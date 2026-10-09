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
 * 行内复读的**语义门槛**（Q-1 → 2026-10-01 AX 节档位 0 收紧）：单元必须含**字母或汉字**。
 *
 * 两级由来：
 *   · Q-1（2026-09-18）：纯符号单元一律跳过 —— 长分隔线（`─`×80）、框线、重复标点是 markdown 常态，
 *     不是"思考空转"。那次真实误杀正是被一条 `─` 长分隔线触发的。
 *   · AX（2026-10-01）：**去掉 `\p{N}`**。原来"含数字"也算语义单元，于是
 *     **命令参数 / 序号 / 数值列的结构重复**被当成了周期复读 —— 本机首条真实守卫记录（也是唯一一条）
 *     就是这类误停：模型正常地写"连按 N 次同一按键"的命令，同一个按键码被连续写出十几次，
 *     守卫在流式生成中途直接中止了那一轮（合成复现：`work/guard-repro-inline-cmd.mjs`，
 *     与真实记录的 kind / 重复次数 / 单元长度逐字一致）。
 *     审查侧裁决（AX.5 档位 0）：纯数字参数、序号、表格分隔符属于**正常结构重复** → 放行。
 *
 * 代价（必须如实记录，不得宣称"零误报"）：**纯数字/纯标点的周期复读不再被这条判据抓住**。
 * 2026-10-01 用 6820 个真实思考块回归：`repeat-inline` 命中由 1 条降为 0 条，
 * 而该条正是上述误报，其余判据（short-line-repeat / repeat-line / spinning）命中数不变 ——
 * 本机语料里没有"纯数字周期复读是真实空转"的证据，但这不等于跨用户/跨模型也如此。
 */
const INLINE_WORD_RE = /[\p{L}]/u;

// BG（2026-10-09）：`0x00,` 是十六进制字节，不是自然语言空转。
// 周期扫描取得的 unit 可能从字节中间开始（如 `00,0x`），所以检查全部循环位移。
// 周期扫描会同时尝试 1、2、3… 个字节组成的周期，故允许一个 unit 含多个字节。
const HEX_BYTE_UNIT_RE = /^(?:0x[0-9a-f]{2}[,;\s]*)+$/i;
const isHexByteCycle = (unit) => {
  if (unit.length < 4 || !/[xX]/.test(unit)) return false;
  for (let offset = 0; offset < unit.length; offset += 1) {
    if (HEX_BYTE_UNIT_RE.test(unit.slice(offset) + unit.slice(0, offset))) return true;
  }
  return false;
};

/**
 * 行内复读的**档位门槛**（AX.5，2026-10-01）。
 *
 * 档位 3（止损）：重复 ≥ `INLINE_TRIP_REPEATS` 次**且**累计 ≥ `INLINE_TRIP_CHARS` 字才中止。
 *
 * ⚠️ **这两个值必须与"未闭合行保留长度"同源**（见 `createLoopGuard` 内的 `inlineKeep`）——
 * 2026-10-01 AY.2 复核抓到的正是这里不同源：探测窗扩到了 `inlineMaxPeriod × 16 = 640` 字，
 * 而流式喂入时未闭合行仍按 `inlineMaxPeriod × streakLimit = 320` 字裁剪，
 * 于是长周期（如 21 字单元）**在凑齐 16 次之前就被丢掉**：
 * 同一段内容整段喂 → 命中；每 5 字分片喂 → `null`（漏检）。DSH 实际就是逐帧喂。
 */
const INLINE_TRIP_REPEATS = 16;
const INLINE_TRIP_CHARS = 160;
/**
 * 档位 2（提醒）候选阈值：达到它**只提醒、不中止**（AX.5 明确标注为**待验证候选值**）。
 * 与止损阈值的区别正是本轮"档位 1/2 通道"的核心：以前落在 8～15 次之间的重复要么被中止、
 * 要么（提高门槛后）完全不留痕迹；现在它变成一条可被调用方取走的提醒。
 */
const INLINE_WARN_REPEATS = 12;
const INLINE_WARN_CHARS = 96;

/**
 * 建一个守卫实例（每次模型 attempt 一个，用完即弃）。
 *
 * @param {object} [options] - 覆盖 `GUARD_DEFAULTS` 的字段
 * @returns {{push: (text: string) => (null | {reason: string, kind: string, detail: object}), stats: () => object}}
 */
export function createLoopGuard(options = {}) {
  const O = { ...GUARD_DEFAULTS, ...(options ?? {}) };
  let pending = ''; // 未见到换行的尾巴
  // ── 代码围栏状态（AZ.2 / BA.3，2026-10-01）──────────────────────────────────
  // 目的：代码块**内**的重复多半是代码/字符串内容（有用途），不该按"思考空转"中止。
  // ⚠️ BA.3 复核指出首版实现（逐字符数连续反引号）有三类问题，这里改用 **CommonMark 行结构**判定：
  //   · 误关：遇到任何连续 ≥3 反引号就翻转 → 用四个反引号开启的块，内部出现三反引号就被当成关闭；
  //   · 漏识：`~~~` 围栏完全没被识别；
  //   · 误开：正文里提到"三个反引号"就被当成开围栏 → 该轮后续行内守卫**持续静默失效**。
  // 规则（简化 CommonMark）：开 = 行首(≤3 空格)后跟 ≥3 个同类字符；关 = 行首后跟**不少于开启长度**
  // 的同类字符，且其后只有空白。按**完整行**判定，天然跨分片安全（分片切不出半个"行"）。
  let fenceChar = null; // '`' 或 '~'；null = 当前不在围栏内
  let fenceLen = 0;
  // ── 代码字符串区间（BA.2 选项 A；2026-10-01 BE 节复核后**收紧为区间判定**）────────
  // 目的：无围栏但明显是代码的重复（`const s = "hello hello …"` 这种**未闭合字符串字面量**）
  // 不该按"思考空转"中止。
  // ⚠️ BE.2 否掉了首版的两条做法，这里逐条改：
  //   ① 首版把 `return `/`function `/`let ` 这类"单词+空格"当特征 → 普通英文叙述
  //      （`I will return to this.`、`The function is described here.`）会把整行静默豁免。
  //      现在**只认字符串区间**：先见到赋值/调用前缀（`=` `(` `[` `,`），再见到引号 → 进入区间；
  //      同种引号再次出现 → 区间结束。关键词一律不再是特征。
  //   ② 首版是**整行粘性** → `const s = "ok"; now I am stuck: …` 的字符串早已结束，
  //      后面的普通叙述却继承了豁免。现在状态表示**末尾位置是否在区间内**：
  //      引号闭合或遇到 `;` 就退出/解除，字符串外的重复照常中止（BD.2 ①：特征要与重复片段同一上下文）。
  //   ③ 顺序性：状态只依据**已经到达**的字符推进，不再"先扫完整段再判定末尾复读"——
  //      未来的关键词不能追溯性地豁免已经生成的重复（BE.2 的整段/分片不一致即由此而来）。
  let pendingWarn = null; // 档位 2（提醒）：达到提醒阈值但未到止损阈值 —— **不中止**，等调用方取走
  let skippedInline = 0; // 被围栏/代码字符串区间豁免的行内检查次数（BA.3：豁免也要可追溯）
  let inCodeString = false; // 末尾是否位于代码字符串区间内
  let strArmed = false; // 本行已出现赋值/调用前缀
  let quoteChar = null; // 当前区间使用的引号字符
  const scanCodeContext = (text) => {
    for (const ch of text) {
      if (ch === '\n') {
        // 行结束 → 状态清理（BD.2 ④：回到普通正文后不得继续豁免）
        inCodeString = false;
        strArmed = false;
        quoteChar = null;
        continue;
      }
      if (inCodeString) {
        if (ch === quoteChar) {
          inCodeString = false; // 字符串闭合 → 区间结束
          quoteChar = null;
        }
      } else if (ch === '"' || ch === "'") {
        if (strArmed) {
          inCodeString = true; // 赋值/调用前缀之后的引号 = 代码字符串
          quoteChar = ch;
        }
      } else if (ch === ';') {
        strArmed = false; // 语句结束：后面的引号不再算代码字符串（BE.2 ②）
      } else if (ch === '=' || ch === '(' || ch === '[' || ch === ',') {
        strArmed = true;
      }
    }
  };
  // `push` 仍引用这个名字（等价于 inCodeString），改名留到下一次触及该函数时一并做。
  const codeContextOf = () => inCodeString;
  const updateFence = (line) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) return;
    const marker = m[1];
    const rest = m[2];
    if (fenceChar === null) {
      // 开启：反引号围栏的 info string 里不允许再出现反引号（CommonMark）
      if (marker[0] === '`' && rest.includes('`')) return;
      fenceChar = marker[0];
      fenceLen = marker.length;
    } else if (marker[0] === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
      fenceChar = null;
      fenceLen = 0;
    }
  };
  // （BA.3 之前那版"逐字符数连续反引号"的 fenceOpen / backtickRun 已随本次重写删除。）
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
    // ── AX.5 档位 2/3（2026-10-01）────────────────────────────────────────────
    // 审查侧裁决把"重复"分档，**单一、短小、能由命令或排版解释的重复不应直接中止生成**：
    //   档位 3 止损：排除结构重复后，自然语言行内复读 **≥16 次且累计 ≥160 字** → 才中止；
    //   档位 2 提醒：≥12 次且累计 ≥96 字 → 原则上不中止（界面提醒通道**尚未接通**，见下）；
    //   档位 1 观察：达到旧门槛(8 次)但不到 12 次 → 不中止。
    // 为什么必须同时看"累计字数"：旧实现只数次数 —— 8 次 × 3 字符 = **24 字**就足以中止一轮生成，
    // 这正是 2026-10-01 那次真实误停（命令里连续重复的按键码被当成复读）。
    // ⚠️ `INLINE_TRIP_*` 是**模块级**常量（并入 `GUARD_DEFAULTS` 要同时改测试与文档，
    //    连带 `handoff-core.js` 的口径说明，留到下一轮）；`streakLimit` 仍服务于同行连续判据。
    // ⚠️ 未接通的部分如实记：档位 2 的"本轮结束后显示提醒"需要 index.js 的新通道 + 投影字段 +
    //    界面渲染，本轮**没有**实现 —— 现在的表现是"不中止且不留痕迹"。
    // ⚠️ `inlineKeep` 与 `push` 里裁剪 `pending` 的长度**必须是同一个表达式**（AY.2）：
    //    保留长度 < 探测长度 ⇒ 流式喂入时凑不齐止损次数（整段喂命中、分片喂漏检）。
    const inlineKeep = Math.max(O.inlineMaxPeriod * INLINE_TRIP_REPEATS, 256);
    const probe = text.slice(-inlineKeep);
    for (let p = O.inlineMinPeriod; p <= O.inlineMaxPeriod; p += 1) {
      if (probe.length < p * INLINE_TRIP_REPEATS) continue;
      const unit = probe.slice(-p);
      if (!unit.trim()) continue;
      // Q-1：纯符号单元跳过（长分隔线 / 框线 / 重复标点不是"思考空转"）
      if (!INLINE_WORD_RE.test(unit)) continue;
      // BG：`0x00,` 的 x 虽是字母，整段仍只是重复的字节表示；从任意分片相位都放行。
      if (isHexByteCycle(unit)) continue;
      // 快速预检（性能）：末尾两段不同 → 连 2 次都不到，直接试下一个周期。
      // 正常文本里这一步挡掉绝大多数 p，只有真周期才走完整回扫。
      if (probe.slice(-p) !== probe.slice(-2 * p, -p)) continue;
      let n = 2; // 末尾两段已确认相同
      for (let i = probe.length - 2 * p; i - p >= 0; i -= p) {
        if (probe.slice(i - p, i) === unit) n += 1;
        else break;
      }
      if (n >= INLINE_TRIP_REPEATS && n * p >= INLINE_TRIP_CHARS) {
        return trip('repeat-inline', `同一片段连续重复 ${n} 次（单元 ${p} 字符）`, {
          repeat: n,
          unitChars: p,
          sample: unit.slice(0, 60),
        });
      }
      // 档位 2（AX.5「提醒」）：达到提醒阈值但未到止损阈值 → **不中止**，只留一条可取的提醒。
      // 阈值为审查侧标注的候选值（12 次 / 96 字），落在这一档的重复按口径应"原则上不中止"。
      if (!pendingWarn && n >= INLINE_WARN_REPEATS && n * p >= INLINE_WARN_CHARS) {
        pendingWarn = {
          kind: 'repeat-inline',
          reason: `疑似思考复读：同一片段连续重复 ${n} 次（单元 ${p} 字符，累计 ${n * p} 字），未中止`,
          detail: { repeat: n, unitChars: p, sample: unit.slice(0, 60) },
        };
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
      // 依生成顺序判定：整段 delta 也逐字符推进，避免后面才出现的代码特征
      // 追溯性豁免前面的复读；换行前先检查行内判据，避免完整行一次喂入漏检。
      for (const ch of text) {
        if (ch === '\n') {
          updateFence(pending);
          const hit = addLine(pending);
          pending = '';
          scanCodeContext(ch);
          if (hit) return hit;
          continue;
        }
        pending += ch;
        scanCodeContext(ch);
        if (pending.length < O.inlineMinPendingChars) continue;
        // AZ.2 / BA.3 / BA.2-A（BE 收紧）：**围栏内**或**代码字符串区间内**都不做行内中止 ——
        // 那里的重复是代码或字符串字面量内容，有明确用途。
        // ⚠️ 这叫"**静默豁免**"，不是"降为观察"：档位 1/2 的计数与展示通道还没建，
        //    跳过 `checkInline` 既不留记录也不发提醒（BA.3 要求别让用户以为有观察记录）。
        // ⚠️ 只作用于**行内**判据；同行连续与窗口唯一率仍按原规则中止。
        // 豁免也要**可统计**（BA.3）：否则"静默豁免"连次数都查不到。
        const exempt = fenceChar !== null || codeContextOf();
        if (exempt) skippedInline += 1;
        const hit = exempt ? null : checkInline(pending);
        if (hit) return hit;
        // 只在尾巴里保留探测所需长度，避免 pending 无界增长
        // AY.2（2026-10-01 审查侧复核）：保留长度必须与 `checkInline` 的探测长度**同源**
        // （同一个表达式）—— 旧值 `inlineMaxPeriod × streakLimit`(320) 比探测所需的 640 短，
        // 流式喂入时长周期会在凑齐止损次数之前被裁掉：整段喂命中、每 5 字分片喂漏检。
        const keep = Math.max(O.inlineMaxPeriod * INLINE_TRIP_REPEATS, 256);
        if (pending.length > keep) pending = pending.slice(-keep);
      }
      return null;
    },

    /**
     * 取走一条「档位 2（提醒）」信号（取走后清空）。
     *
     * ⚠️ 它**不代表要中止**：调用方（host 半）应在流式处理里轮询并把它上报给投影，
     * 由界面显示"疑似思考复读（已继续生成）"。`push()` 的返回值语义**不变** —— 仍只有
     * 达到档位 3（止损）才返回命中对象，所以调用方即使暂不轮询也不会误中止。
     */
    takeWarn() {
      const w = pendingWarn;
      pendingWarn = null;
      return w;
    },

    /** 观测用：调用方可以在日志里带上它，便于回溯误报。 */
    stats() {
      return {
        totalChars,
        lineCount,
        lastStreak: streak,
        windowLines: window.length,
        windowUnique: new Set(window).size,
        // BA.3：被围栏/代码字符串区间豁免的行内检查次数 —— 让"静默豁免"至少可被统计
        skippedInline,
      };
    },
  };
}
