/**
 * 价格数据与峰谷档位（2026-09-18 T 节）。
 *
 * ## 为什么单独一个模块
 *
 * 价格原先是 `handoff-core.js` 里的一个硬编码常量（"DeepSeek flash 空闲价"），
 * 带来三个静默风险（T.1）：
 *   · 官方调价 → 所有成本建议静默算错，用户无从察觉；
 *   · 用户换模型（flash → pro，价差 3~4.5 倍）→ 整套账全错；
 *   · 界面不标"价格是哪天的" → 用户无法判断账目是否过期。
 *
 * 这里把"价格从哪来 / 现在该用哪一档 / 这个模型认不认识"收敛成**唯一一处**。
 *
 * ## 三层来源（优先级从高到低）
 *
 *   1. `<DSH_HOME>/attention-health/prices.json`（用户可改，官方调价不必改代码）；
 *   2. `DEFAULT_PRICES` —— **2026-09-18 按官方定价页逐项核对**的内置值；
 *   3. 都没有 → 仍然可用（内置值就是兜底），且**任何读取失败都不抛错**。
 *
 * ⚠️ **不用第三方价源**（如 models.dev）：实测它给 `deepseek-v4-pro` 的
 * 未命中输入低 35%、输出低 57%（T.6）。照抄等于把插件"账算得准"这个立身之本降级。
 * 拿不到可靠价时，正确做法是**标注不确定**或**不裁决**，不是随便填一个数。
 *
 * ## 峰谷（T.7）
 *
 * 官方定义：**北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，其余为空闲**，
 * 高峰全部单价 ×2。插件此前全程按空闲价算 —— 那意味着**用户白天干活时恰好低估一半**。
 *
 * @module prices
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 内置默认价表（元 / 百万 token）。
 *
 * ⚠️ 数值来源：**2026-09-18 按 DeepSeek 官方定价页逐项核对**（flash 与 pro、
 * 空闲与高峰、命中/未命中/输出各三项）。改动这里之前请重新核对官方页并更新 `fetchedAt`。
 */
export const DEFAULT_PRICES = {
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  fetchedAt: '2026-09-20',
  /**
   * 中国法定节假日（B2 修复，2026-09-20）—— 官方口径是
   * 「周一至周五（**不含中国法定节假日**）9-12 / 14-18 为高峰，其余（含周末与法定节假日全天）空闲」。
   * 此前只有"星期几 + 小时"，于是**国庆/春节的白天被按高峰价 ×2**。
   *
   * ⚠️ 两条纪律（AF.2）：
   *   1. **不要**把"调休补班的周末"算高峰 —— 官方字面是"周一至周五"，补班日本就落在周末，
   *      现有周末判定保持不动；
   *   2. 这张表是**内置兜底**，用户可用 `prices.json` 的 `holidays` 覆盖；官方每年 11 月前后公布下一年安排。
   *
   * 来源：国办发明电〔2025〕7 号《国务院办公厅关于2026年部分节假日安排的通知》
   * （https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm ，2026-09-20 抓取）。
   * 只列**放假**的日子；其中落在周末的（如春节 2/15、2/21-22）本来就被周末规则判为空闲，
   * 一并列出来是为了"照抄官方原文、便于逐年核对"。
   */
  holidaysSource: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  holidaysFetchedAt: '2026-09-20',
  holidays: [
    // 元旦：1/1（周四）–1/3（周六）；1/4（周日）上班 → **不**列入
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节：2/15（周日）–2/23（周一），共 9 天
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明：4/4（周六）–4/6（周一）
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节：5/1（周五）–5/5（周二）；5/9（周六）上班 → 不列入
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午：6/19（周五）–6/21（周日）
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋：9/25（周五）–9/27（周日）
    '2026-09-25', '2026-09-26', '2026-09-27',
    // 国庆：10/1（周四）–10/7（周三）；9/20（周日）、10/10（周六）上班 → 不列入
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07',
    // 2027 年安排尚未公布 → 只放**日期固定**的元旦当天（其余等官方通知或用户覆盖）
    '2027-01-01',
  ],
  // ⚠️ 前缀必须覆盖**实际出现过的所有写法**。2026-09-18 实测：同一批会话里两者并存 ——
  //   · `deepseek-v4.1-flash-expires-on-0910`（较新的会话）
  //   · `deepseek-v4-flash`（更早的会话，**没有 `.1`**）
  // 漏掉任一种，那条会话就会静默降级成"价格未知 → 成本不裁决" —— 虽然比算错好，
  // 但会悄悄丢掉整个成本维度（S.4 的真实会话回归正是先失败、才暴露出这个差异的）。
  //
  // 2026-09-20（B1，AF.1）：**官方现行模型名已改成 `deepseek-flash`** —— 官方定价页原文
  // 「模型名请使用 `deepseek-flash`。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`
  //  仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 提供服务，并按 Flash 价格计费。」
  // 不补这一条，用现行模型名的会话会**整条静默跳过成本通道**（known=false，不报错）。
  // 前缀匹配（`startsWith`）是刻意设计，**不要**改成子串匹配。
  models: [
    {
      prefix: 'deepseek-flash',
      offPeak: { hit: 0.02, miss: 1, out: 4 },
      peak: { hit: 0.04, miss: 2, out: 8 },
    },
    {
      prefix: 'deepseek-v4.1-flash',
      offPeak: { hit: 0.02, miss: 1, out: 4 },
      peak: { hit: 0.04, miss: 2, out: 8 },
    },
    {
      prefix: 'deepseek-v4-flash',
      offPeak: { hit: 0.02, miss: 1, out: 4 },
      peak: { hit: 0.04, miss: 2, out: 8 },
    },
    {
      prefix: 'deepseek-v4.1-pro',
      offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
      peak: { hit: 0.3, miss: 9, out: 27 },
    },
    {
      prefix: 'deepseek-v4-pro',
      offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
      peak: { hit: 0.3, miss: 9, out: 27 },
    },
  ],
};

/** 价格文件路径（`DSH_HOME` 可覆盖，与 `handoff-history.jsonl` / `guard-trips.jsonl` 同目录）。 */
export function pricesFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'attention-health', 'prices.json');
}

/** 文件读取缓存（按 mtime 失效）—— 判定链每轮都会问价，不能每次都读盘。 */
let fileCache = null;

/**
 * 读取生效价表：优先 `prices.json`，缺失 / 损坏 / 不可读 → 内置核对值。
 *
 * **绝不抛错**：这是判定链的输入，价格文件坏掉不该让插件停摆。
 *
 * @returns {object} 价表（含 `fromFile` 标记，供界面标注来源）
 */
export function loadPrices() {
  const file = pricesFile();
  try {
    const st = fs.statSync(file);
    if (fileCache && fileCache.mtimeMs === st.mtimeMs) return fileCache.table;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.models) || !parsed.models.length) {
      throw new Error('prices.json 结构不完整');
    }
    const table = { ...DEFAULT_PRICES, ...parsed, fromFile: true };
    fileCache = { mtimeMs: st.mtimeMs, table };
    return table;
  } catch {
    return { ...DEFAULT_PRICES, fromFile: false };
  }
}

/** 仅供测试：清掉文件缓存，让下一次 `loadPrices()` 重新读盘。 */
export function resetPriceCache() {
  fileCache = null;
}

/**
 * 当前是否处于**高峰时段**（官方口径）。
 *
 * 用 UTC+8 平移后取 UTC 字段，避免依赖运行机器的时区设置。
 *
 * B2（2026-09-20）：高峰**不含中国法定节假日** —— 之前这里只有"星期几 + 小时"，
 * 于是国庆 / 春节的白天被按高峰价 ×2（用户白天干活时恰好算贵一倍）。
 * 现在先查 `holidays` 表；表里命中 → **全天空闲**。
 * ⚠️ 调休补班的**周末**不列入表，也不额外处理：官方字面是"周一至周五"，
 * 补班日落在周末 → 周末规则本来就判空闲，保持不动（AF.2 明确要求）。
 *
 * @param {Date} [now]
 * @param {string[]} [holidays] - `['YYYY-MM-DD', …]`（默认取内置表）
 * @returns {boolean}
 */
export function isPeakTime(now = new Date(), holidays = DEFAULT_PRICES.holidays) {
  const bj = new Date(now.getTime() + 8 * 3600e3);
  const day = bj.getUTCDay(); // 0 = 周日
  if (day === 0 || day === 6) return false; // 周末全天空闲
  // 平移后的 UTC 字段就是北京时间 → 直接取日期部分比对
  const date = bj.toISOString().slice(0, 10);
  if (Array.isArray(holidays) && holidays.includes(date)) return false; // 法定节假日全天空闲
  const h = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 该时刻是否落在 `holidays` 里（供界面标注"今日为法定节假日 → 空闲价"）。 */
export function isHoliday(now = new Date(), holidays = DEFAULT_PRICES.holidays) {
  const bj = new Date(now.getTime() + 8 * 3600e3);
  return Array.isArray(holidays) && holidays.includes(bj.toISOString().slice(0, 10));
}

/**
 * 把「模型名 + 当前时刻」解析成一份可用单价。
 *
 * 三种情形分得很清楚（T-5 / T-6）：
 *   · 模型名匹配某个前缀 → 按该模型、当前档位计价，`known: true`；
 *   · 模型名**缺失**（老会话 / 没有 `request/context`）→ 按第一张表估算，
 *     `known: true` 但 `modelMatched: false`（界面如实标注"模型未知"）——
 *     这与"明确不认识"不同：缺字段是数据不全，不该让功能整体失效；
 *   · 模型名**存在但不认识** → `known: false`，**成本裁决跳过**（不确定就不判）。
 *
 * @param {string|null|undefined} model
 * @param {Date} [now]
 * @param {object} [table] - 默认取 `loadPrices()`
 * @returns {{known:boolean, modelMatched:boolean, model:string|null, tier:'peak'|'offPeak',
 *   source:string, date:string, price:{cacheHitPerMillion:number, cacheMissPerMillion:number, outputPerMillion:number}}}
 */
export function resolvePrice(model, now = new Date(), table = loadPrices()) {
  const holidays = table.holidays ?? DEFAULT_PRICES.holidays;
  const onHoliday = isHoliday(now, holidays);
  const tier = isPeakTime(now, holidays) ? 'peak' : 'offPeak';
  const name = typeof model === 'string' ? model : '';
  const models = table.models ?? DEFAULT_PRICES.models;
  const entry = name ? (models.find((m) => name.startsWith(m.prefix)) ?? null) : null;

  // 明确不认识 → 不裁决；但金额仍按第一张表估出来给界面看（并标注不可用于决策）
  if (name && !entry) {
    const p = models[0][tier] ?? models[0].offPeak;
    return {
      known: false,
      modelMatched: false,
      model: name,
      tier,
      onHoliday,
      source: table.fromFile ? 'prices.json' : '内置核对值',
      date: table.fetchedAt ?? DEFAULT_PRICES.fetchedAt,
      holidaysFetchedAt: table.holidaysFetchedAt ?? DEFAULT_PRICES.holidaysFetchedAt,
      price: { cacheHitPerMillion: p.hit, cacheMissPerMillion: p.miss, outputPerMillion: p.out },
    };
  }

  const use = entry ?? models[0];
  const p = use[tier] ?? use.offPeak;
  return {
    known: true,
    modelMatched: entry !== null,
    model: name || null,
    tier,
    onHoliday,
    source: table.fromFile ? 'prices.json' : '内置核对值',
    date: table.fetchedAt ?? DEFAULT_PRICES.fetchedAt,
    holidaysFetchedAt: table.holidaysFetchedAt ?? DEFAULT_PRICES.holidaysFetchedAt,
    price: { cacheHitPerMillion: p.hit, cacheMissPerMillion: p.miss, outputPerMillion: p.out },
  };
}
