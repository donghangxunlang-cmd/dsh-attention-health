/**
 * 实时「思考复读 / 空转」守卫（2026-09-16 用户新增需求）。
 *
 * ## 为什么需要它
 *
 * 原有的退化检测是**事后**的：`assistant/message` 落盘时，那个思考块已经生成完了。
 * 真实事故里单块思考 53.5 万字符、同一行重复 69,667 次、打满 256k 输出预算
 * （≈ ¥1.02，相当于 270 轮正常对话）—— **等它写完再报，钱已经烧掉了**。
 *
 * DSH 提供了两个关键能力，使"实时拦截"成为可能（已核对官方类型定义）：
 *   · `agent/assistant-stream` 事件逐帧发布 `frame.chunk`，其中 `reasoning-delta`
 *     就是**正在生成的思考片段**（`{ type:'reasoning-delta', index, text }`）；
 *   · `agent.cancel({ kind:'hook', reason })` 可以**中止活动 turn**，而 `reason`
 *     会作为 `turn/end` 的 `aborted` 原因落进会话日志 —— 于是界面能显示确切原因。
 *
 * ## 设计原则：宁可漏报，不许误杀
 *
 * 中断一次正在进行的生成是有代价的（丢掉这一轮的工作）。所以判据刻意保守，
 * 只抓"正常的思考绝不会出现"的形态：
 *
 *   1. **同一行连续重复** ≥ `streakLimit` 次（默认 8）—— 且该行 ≥ `minLineChars` 字符
 *      （排除 `---`、`}`、空行这类"重复也不稀奇"的短行）；
 *   2. **行内片段连续重复** ≥ `streakLimit` 次 —— 抓"没有换行的复读"；
 *   3. **滑动窗口空转**：最近 `windowLines` 行里不同行的占比低于 `uniqueRatioMin`。
 *
 * 三种都是"越界的重复"，与"思考很长""思考很啰嗦"不同 —— 后者不该被中断。
 *
 * @module guard
 */

/** 守卫默认参数（可由 `COMPACT_DEFAULTS` 或调用方覆盖）。 */
export const GUARD_DEFAULTS = {
  /** 总开关：界面/文档都能看到它被关掉了。 */
  enabled: true,
  /** 同一行连续出现多少次即判复读。8 次：正常推理里"完全相同的整行"连续 8 次不成立。 */
  streakLimit: 8,
  /** 计入"复读"的行最短字符数。排除 `---` / `}` / `);` 这类短行。 */
  minLineChars: 12,
  /** 空转检测的滑动窗口行数。 */
  windowLines: 40,
  /** 窗口内至少要有这么多行才做"空转"判断。 */
  windowMinLines: 24,
  /** 窗口内"不同行占比"的下限；低于它判空转。 */
  uniqueRatioMin: 0.25,
  /**
   * 「短行高频」判据的窗口行数（2026-09-18 H.5/H.7 新增，候选 B）。
   *
   * 为什么需要它：真实空转现场（`session-SAMPLE-464c3aba`，03:03–03:04）是
   * **短行交替复读**（`做。` / `**（Go.）**` / `**（执行。）**` … A/B/A/B 交替），
   * 它同时躲开了原有两条规则 ——
   *   · 同行连续：`做。` 只有 2 字符，被 `minLineChars = 12` 挡掉；
   *   · 窗口唯一率：窗口只收 ≥12 字符的行，短行全不进，唯一率反而高达 57.5%。
   *
   * H.7 实测定案（2,244 个真实思考块）：**窗口 60 行 / 同一短行 ≥30 次**。
   * 阈值 40 次时命中为 0（连真实空转都抓不住）—— **这是放宽的硬上限**。
   */
  shortLineWindow: 60,
  /** 判定为"短行"的最大字符数。 */
  shortLineMaxChars: 11,
  /** 窗口内同一短行出现多少次即判空转。**不要超过 30**（见上）。 */
  shortLineRepeatLimit: 30,
  /** 窗口内至少要有这么多短行才做判定（避免短会话误伤）。 */
  shortLineMinCount: 30,
  /**
   * 行内复读检测的**周期范围**（2026-09-18 Q 节重做）。
   *
   * ⚠️ 旧实现只试 `[8, 16, 32]` 三个**固定**单元长度、并按该长度**对齐**向前比对，
   * 结果两个方向都错（Q 节实测复现，见 `work/q-repro.mjs`）：
   *   · 纯符号串（`─`×80 这类长分隔线）天然是周期串，任何对齐长度都能匹配 → **误杀**；
   *   · 有意义的句子（如 11 字的 `这是一行会被重复的内容`）与 8/16/32 对不齐 → **漏报**。
   * 它抓的是"周期字符"，不是"语义重复" —— 与"抓思考空转"的初衷相反。
   * 现在改为扫描 `[inlineMinPeriod, inlineMaxPeriod]` 内的**所有**周期长度。
   */
  inlineMinPeriod: 2,
  /** 周期上限：比它更长的"重复单元"已经不像机械复读，交给其它判据。 */
  inlineMaxPeriod: 40,
  /** 行内复读探测只在"当前未闭合行"超过这个长度后才做（避免每个 delta 都算）。 */
  inlineMinPendingChars: 64,
};

/**
 * 行内复读的**语义门槛**（Q-1）：单元必须含字母 / 数字 / 汉字。
 *
 * 纯符号单元一律跳过 —— 长分隔线（`─`×80）、框线、重复标点是 markdown 常态，
 * 不是"思考空转"。2026-09-18 05:24 那次真实**误杀**正是被一条 `─` 长分隔线触发的
 * （用户正常的生成被无端中断）。这与 `DECISION_NOISE` 排除框线字符（U+2500–U+257F）同源。
 */
const INLINE_WORD_RE = /[\p{L}\p{N}]/u;

/**
 * 建一个守卫实例（每次模型 attempt 一个，用完即弃）。
 *
 * @param {object} [options] - 覆盖 `GUARD_DEFAULTS` 的字段
 * @returns {{push: (text: string) => (null | {reason: string, kind: string, detail: object}), stats: () => object}}
 */
export function createLoopGuard(options = {}) {
  const O = { ...GUARD_DEFAULTS, ...(options ?? {}) };
  let pending = ''; // 未见到换行的尾巴
  let totalChars = 0;
  let lineCount = 0;
  let lastLine = null;
  let streak = 0;
  /** 滑动窗口：最近 windowLines 个非空行（2026-09-18 H.5 候选 A：短行也参与）。 */
  const window = [];
  /** 短行窗口（2026-09-18 H.5 候选 B）：最近 shortLineWindow 个 ≤11 字符的行。 */
  const shortWindow = [];

  const trip = (kind, reason, detail) => ({ kind, reason, detail });

  /** 判定一条完整行；返回命中信息或 null。 */
  const addLine = (raw) => {
    const line = raw.trim();
    if (!line) return null;
    lineCount += 1;

    // ① 同一行连续重复
    if (line === lastLine) {
      streak += 1;
    } else {
      lastLine = line;
      streak = 1;
    }
    if (line.length >= O.minLineChars && streak >= O.streakLimit) {
      return trip('repeat-line', `同一行连续重复 ${streak} 次`, {
        streak,
        lineChars: line.length,
        sample: line.slice(0, 80),
      });
    }

    // ② 短行高频交替（2026-09-18 H.5 新增，候选 B）——
    // 真实空转现场是 `做。` 与 `**（Go.）**` 这类**短行交替**（A/B/A/B），
    // 它躲开了 ①（`做。` 仅 2 字符，被 minLineChars 挡掉）与 ③（短行不进旧窗口）。
    if (line.length <= O.shortLineMaxChars) {
      shortWindow.push(line);
      if (shortWindow.length > O.shortLineWindow) shortWindow.shift();
      if (shortWindow.length >= O.shortLineMinCount) {
        const counts = new Map();
        let best = 0;
        let bestLine = '';
        for (const l of shortWindow) {
          const n = (counts.get(l) ?? 0) + 1;
          counts.set(l, n);
          if (n > best) {
            best = n;
            bestLine = l;
          }
        }
        if (best >= O.shortLineRepeatLimit) {
          return trip(
            'short-line-repeat',
            `最近 ${shortWindow.length} 个短行里有 ${best} 行是「${bestLine}」`,
            { windowLines: shortWindow.length, repeat: best, sample: bestLine.slice(0, 40) },
          );
        }
      }
    }

    // ③ 滑动窗口空转。2026-09-18 H.5 候选 A：**全部非空行参与**（原来只收 ≥12 字符的行，
    // 于是"短行占绝大多数"的空转窗口反而唯一率很高、永远测不出来）。
    window.push(line);
    if (window.length > O.windowLines) window.shift();
    if (window.length >= O.windowMinLines) {
      const uniq = new Set(window).size;
      const ratio = uniq / window.length;
      if (ratio <= O.uniqueRatioMin) {
        return trip('spinning', `最近 ${window.length} 行只有 ${uniq} 种内容`, {
          windowLines: window.length,
          unique: uniq,
          ratio: Number(ratio.toFixed(3)),
        });
      }
    }
    return null;
  };

  /**
   * 行内片段复读（没有换行的复读）—— 2026-09-18 Q 节按"周期检测"重做。
   *
   * 判据：末尾存在长度 p ∈ [inlineMinPeriod, inlineMaxPeriod] 的单元，
   * 连续重复 ≥ `streakLimit` 次，**且该单元含语义字符**（字母 / 数字 / 汉字）。
   *
   * 语义门槛是这次修复的关键：`─`.repeat(80) 这类长分隔线是 markdown 常态、
   * 天然是周期串，旧实现把它判成"片段重复 10 次"并**中断了用户的正常生成**。
   */
  const checkInline = (text) => {
    const need = O.inlineMaxPeriod * O.streakLimit;
    const probe = text.slice(-Math.max(need, 256));
    for (let p = O.inlineMinPeriod; p <= O.inlineMaxPeriod; p += 1) {
      if (probe.length < p * O.streakLimit) continue;
      const unit = probe.slice(-p);
      if (!unit.trim()) continue;
      // Q-1：纯符号单元跳过（长分隔线 / 框线 / 重复标点不是"思考空转"）
      if (!INLINE_WORD_RE.test(unit)) continue;
      // 快速预检（性能）：末尾两段不同 → 连 2 次都不到，直接试下一个周期。
      // 正常文本里这一步挡掉绝大多数 p，只有真周期才走完整回扫。
      if (probe.slice(-p) !== probe.slice(-2 * p, -p)) continue;
      let n = 2; // 末尾两段已确认相同
      for (let i = probe.length - 2 * p; i - p >= 0; i -= p) {
        if (probe.slice(i - p, i) === unit) n += 1;
        else break;
      }
      if (n >= O.streakLimit) {
        return trip('repeat-inline', `同一片段连续重复 ${n} 次（单元 ${p} 字符）`, {
          repeat: n,
          unitChars: p,
          sample: unit.slice(0, 60),
        });
      }
    }
    return null;
  };

  return {
    /**
     * 喂入一个 `reasoning-delta` 片段。
     * @param {string} text
     * @returns {null | {reason: string, kind: string, detail: object}} 命中即返回，调用方据此中止
     */
    push(text) {
      if (!O.enabled) return null;
      if (typeof text !== 'string' || text.length === 0) return null;
      totalChars += text.length;
      pending += text;

      // 逐行消费（一次 delta 可能带多个换行）
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const hit = addLine(line);
        if (hit) return hit;
        nl = pending.indexOf('\n');
      }

      // 长时间没有换行（或换行很稀疏）→ 查行内片段复读
      if (pending.length >= O.inlineMinPendingChars) {
        const hit = checkInline(pending);
        if (hit) return hit;
        // 只在尾巴里保留探测所需长度，避免 pending 无界增长
        const keep = O.inlineMaxPeriod * O.streakLimit;
        if (pending.length > keep) pending = pending.slice(-keep);
      }
      return null;
    },

    /** 观测用：调用方可以在日志里带上它，便于回溯误报。 */
    stats() {
      return {
        totalChars,
        lineCount,
        lastStreak: streak,
        windowLines: window.length,
        windowUnique: new Set(window).size,
      };
    },
  };
}
