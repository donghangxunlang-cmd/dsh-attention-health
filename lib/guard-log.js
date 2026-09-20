/**
 * 守卫现场的**本地落档**（2026-09-18 Q-3）。
 *
 * ## 为什么需要它
 *
 * 一次守卫中止**必须能事后复核** —— 尤其是"误杀"：守卫会中断正在进行的生成，
 * 代价是丢掉这一轮的工作。而在此之前，事后能查到的只有两样，都不够用：
 *
 *   · `turn/end` 的 reason：一句简短文本（如"思考空转 —— 同一片段连续重复 10 次"）；
 *   · `console.error` 的完整日志：写在 `dsh-node.err.log`，而**每次重启覆盖它** ——
 *     2026-09-18 那次误杀（05:24:34）的现场，就在 65 秒后的重启里被冲掉了，
 *     复核方只能凭 `turn/end` 的一句话反推，无法确认"当时到底贴了什么"。
 *
 * 所以这里把命中现场以 JSONL **只追加**写入独立文件：判定种类、理由、`detail`，
 * 以及**当时的文本尾部 500 字** —— 有尾部才能判断"这次抓对了没有"。
 *
 * ## 边界
 *
 * - 位置：`<DSH_HOME>/attention-health/guard-trips.jsonl`，每行一个 JSON 对象。
 * - **只追加**，不修改、不上传、不联网；零 token、纯本地。
 * - 落档失败绝不影响守卫（`recordGuardTrip` 内部吞掉异常，返回 boolean）。
 *
 * @module guard-log
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 追加写入 + 大小轮转（2026-09-18 第三方评审 P1-4）：这个文件此前**无限追加**。
import { appendJsonl } from './jsonl.js';

/** 思考原文尾部的默认保留字符数（Z.5：默认维持现状）。 */
export const DEFAULT_TRIP_TAIL_CHARS = 500;

/** 落档文件的绝对路径（`DSH_HOME` 可覆盖，与插件其它落点一致）。 */
export function guardTripsFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'attention-health', 'guard-trips.jsonl');
}

/**
 * 追加一条守卫命中记录。
 *
 * @param {object} entry - `{ kind, reason, detail, tail, sessionId? }`
 * @returns {boolean} 是否写入成功（失败不抛错 —— 观测手段不该影响守卫本身）
 */
export function recordGuardTrip(entry) {
  // 写入走共享的 `appendJsonl`（含 512 KB 轮转）；失败仍然只吞掉、不抛。
  return appendJsonl(guardTripsFile(), { at: Date.now(), ...entry });
}

/**
 * 落档时保留的思考原文尾部字符数（2026-09-18 Z.5 复核侧裁决）。
 *
 * 默认 **500**（维持现状）—— Q-3 的"误杀要能事后复核"必须保住
 * （实测至今守卫真实命中 0 次、该文件为空，隐私面为 0）。
 * 设为 **0** 则进入**隐私模式**：只存哈希 + 长度 + 首尾 40 字特征，不落思考原文。
 *
 * 配置方式：环境变量 `DSH_ATTENTION_HEALTH_GUARD_TAIL`（非负整数；非法值回落 500）。
 */
export function guardTripTailChars() {
  const raw = process.env.DSH_ATTENTION_HEALTH_GUARD_TAIL;
  if (raw === undefined || raw === '') return DEFAULT_TRIP_TAIL_CHARS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TRIP_TAIL_CHARS;
}

/**
 * 按当前配置把"思考原文尾部"加工成可落档的形状。
 *
 * @param {string} tail
 * @returns {object} 常规档 `{ tail }`；隐私档 `{ tail:'', tailChars, tailHash, tailHead, tailFoot }`
 */
export function shapeGuardTail(tail) {
  const text = String(tail ?? '');
  const limit = guardTripTailChars();
  if (limit > 0) return { tail: text.slice(-limit) };
  // 隐私模式：不落原文，但保留"能证明是同一段"的指纹与形状信息
  return {
    tail: '',
    tailChars: text.length,
    tailHash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    tailHead: text.slice(0, 40),
    tailFoot: text.slice(-40),
  };
}

/** 读取全部记录（坏行跳过，文件不存在返回空数组）。 */
export function readGuardTrips() {
  let raw;
  try {
    raw = fs.readFileSync(guardTripsFile(), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* 坏行跳过：这是尽力而为的观测数据，不该让整体读取失败 */
    }
  }
  return rows;
}
