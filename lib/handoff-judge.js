/**
 * handoff · 退化判据（全项目唯一实现）
 *
 * 回复退化（`replyDegradeReasons`）、思考退化（`reasoningDegradeReasons`）、
 * 一条消息的整体扫描（`scanReasoning`）与布尔版（`looksDegraded`）。
 *
 * ⚠️ **host 投影、冷会话折叠、离线工具三处共用这一份**。
 * 历史上它们各有一份平行实现，结果同一会话出现"提示条说 3 条、文档说 0 条"——
 * 本模块存在的意义就是让那种分叉在结构上不可能发生。
 *
 * 本模块**不依赖任何兄弟模块**（只用自己的常量与正则）。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 811–1064 行（共 254 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 *//**
 * 退化检测 —— **全项目唯一实现**（host 投影与交接折叠共用）。
 *
 * ## 立场
 *
 * 宁可漏报也不误报 —— 误报会让用户忽略提示，比不提示更糟。
 *
 * ## 2026-09-15 第二次审查（N-5）：判据按实测数据重做
 *
 * 旧版判据在真实数据上的表现（全量 73 会话 / 4,185 条回复 / 3,491 个思考块）：
 *
 * | 判据 | 真实触发 | 结论 |
 * | --- | --- | --- |
 * | 5｜中英严重混杂（全篇中文占比 5%~25%） | **25 次，25/25 全是误报** | **删除** |
 * | 3｜长段落逐字重复（>60 字） | 1 次 | 阈值对中文太长 → 降到 25 字 |
 * | 1｜围栏不闭合 / 2｜同行复读 / 4｜符号堆砌 | **0 次** | 被 80 字门槛挡住 → 门槛删除 |
 *
 * 规则 5 的 25 条命中抽样全是正常技术回复（中文说明 + 英文代码 / 路径 / URL / 包名），
 * 而它每条扣 6 分、最多扣 30 分，还让提示条显示"输出异常 N 条" —— 这与上面的立场直接冲突。
 * 规则 4 另有一个误报源：Unicode 边框表格（`╔══╦══╗`）被算成符号堆砌，现在排除框线字符。
 *
 * ## 最大盲区：思考过程（`reasoning`）
 *
 * 旧版只读 `type === 'text'`，思考块**一个字都没检查**。而实测思考量是最终回复的 7.9 倍
 * （3,491 块 / 592 万字符 vs 2,284 块 / 75 万字符），用户描述的退化现象恰恰是
 * "思考过程夹杂一堆无用的东西和符号"。真实事故样本 `session-SAMPLE-bfd2b142`：
 *
 * ```
 * 单个思考块：535,355 字符 / 116,152 行 / 仅 56 个唯一行（重复率 0.9995）
 * 最高频行：「好。」×69,667、「执行。」×23,214、「（执行）」×23,205
 * usage：reasoningTokens = 256,000（输出预算被打满，256K token 全烧在循环上）
 * 旧版 looksDegraded() 判定：**正常**（漏检）
 * ```
 *
 * 因此新增两条**思考判据**（阈值由上面这个真实事故 + 全量 3,491 块零误报共同定出）：
 * `thinkLoop`（行重复率 ≥ 0.7 且行数 ≥ 30）与 `thinkHuge`（单块 ≥ 10 万字符）。
 * 阈值敏感性：0.6/0.7/0.8/0.9 在全量数据上都只命中那 1 个事故块；0.5 会多带 2 个
 * 正常代码块（` ```js ` 重复 7 次），故取 0.7 留出安全余量。
 */

/** 判据标签：命中原因会带进提示条与交接文档，让用户自己判断提示可不可信。 */
export const DEGRADE_LABELS = {
  fence: '围栏不闭合',
  lineRepeat: '同行复读',
  paraRepeat: '段落复读',
  symbolRun: '符号堆砌',
  thinkLoop: '思考打转',
  thinkHuge: '思考异常长',
  thinkBudget: '思考预算打满',
};

/** 表格 / 框线类字符：Markdown 表格与 ASCII art 的正常用法，不算"符号堆砌"。 */
const TABLE_DRAW_CHARS = /[\u2500-\u257F\u2580-\u259F]/g;

/** 段落复读的最小长度（中文一句话常 25~50 字，旧值 60 等于放过中文短段）。 */
const PARA_REPEAT_MIN_CHARS = 25;

/** 思考打转：行数门槛 + 行重复率门槛（见上方实测依据）。 */
const THINK_LOOP_MIN_LINES = 30;
const THINK_LOOP_REPEAT_RATE = 0.7;

/** 思考异常长：单块字符数门槛（实测最长正常块 44,249，事故块 535,355）。 */
const THINK_HUGE_CHARS = 100000;

/**
 * 思考预算门槛：单条消息的 `usage.reasoningTokens`（**真实计量**，不是字符估算）。
 *
 * 2026-09-15 复核实测（70 会话 / 3,534 条带该字段的消息）：
 * p50=269、p90=1,648、p99=4,237，而真事故那条是 **256,000**（打满上限）。
 * 取 16,000 ≈ 4×p99：语料上零误报，且只有事故那一条越过它。
 *
 * 它补的是 `THINK_HUGE_CHARS` 的盲区 —— 后者只看**单个块**的字符数，
 * 遇到"多个中等块加起来烧掉预算"就会漏（每块都不到 10 万字符）；
 * 本判据按**消息级真实 token** 判定，且**不依赖思考正文是否落盘**。
 */
export const THINK_BUDGET_TOKENS = 16000;

/**
 * 去掉代码，只留散文 —— 符号类判据专用。
 *
 * 依据（2026-09-15 复核实测）：`symbolRun` 在 3,638 个真实思考块上命中 21 次、
 * 在 2,271 个回复块上命中 1 次，**22/22 全部落在代码里**（正则字面量、JS 字符串、
 * 生成 Markdown 表格的语句）。模型"思考正则/代码"时标点密度天然极高 ——
 * 那不是退化，那就是工作内容本身。
 */
function stripCodeBlocks(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * 符号堆砌：≥16 个连续符号、种类 ≥4、且**以非 ASCII 符号为主**（已排除表格框线）。
 * 返回命中的串，无则 null。
 *
 * "必须以非 ASCII 为主"是 2026-09-15 复核加的：真实乱码 / 卡图（※★☆●▲■◆、emoji 卡住）
 * 几乎必然是非 ASCII；而**长串 ASCII 标点实测 22/22 是正则或代码**。
 * 再配合 `stripCodeBlocks` 先剥掉代码，等于双重止损。设计立场仍是"宁可漏报不误报"。
 */
function symbolRunHit(text) {
  const prose = stripCodeBlocks(text).replace(TABLE_DRAW_CHARS, ' ');
  for (const run of prose.match(/[^\p{L}\p{N}\s]{16,}/gu) ?? []) {
    if (new Set(run).size < 4) continue;
    const exotic = (run.match(/[^\x20-\x7E]/g) ?? []).length;
    if (exotic / run.length < 0.5) continue;
    return run;
  }
  return null;
}

/** 同一行连续重复的最高次数（用于把"重复了 69,667 次"这种事实说清楚）。 */
function worstLineRepeat(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const counts = new Map();
  let worst = 0;
  for (const l of lines) {
    const n = (counts.get(l) ?? 0) + 1;
    counts.set(l, n);
    if (n > worst) worst = n;
  }
  return worst;
}

/**
 * 最终回复（`text` block）的退化判据。
 *
 * 注意：判据与长度**无关**（围栏是否闭合、是否复读、是否符号堆砌都不取决于长度），
 * 旧版的 `length < 80` 全局门槛只造成了"短文本全盲"。
 *
 * @param {string} text
 * @returns {string[]} 命中的判据键（`DEGRADE_LABELS` 的 key），无命中则为空数组
 */
export function replyDegradeReasons(text) {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const hits = [];

  // 1) 代码块围栏不闭合 —— 格式漂移
  if (((t.match(/```/g) ?? []).length % 2) !== 0) hits.push('fence');

  // 2) 同一行连续重复 ≥3 次 —— 复读
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let run = 1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === lines[i - 1] && lines[i].length > 4) {
      run += 1;
      if (run >= 3) {
        hits.push('lineRepeat');
        break;
      }
    } else {
      run = 1;
    }
  }

  // 3) 段落逐字重复 —— 复读
  const seen = new Set();
  for (const para of t.split(/\n\s*\n/)) {
    const p = para.trim();
    if (p.length <= PARA_REPEAT_MIN_CHARS) continue;
    if (seen.has(p)) {
      hits.push('paraRepeat');
      break;
    }
    seen.add(p);
  }

  // 4) 符号堆砌 —— 输出乱码
  if (symbolRunHit(t)) hits.push('symbolRun');

  // 5) 已删除：中英严重混杂（全量 25 次命中全是误报，见上方实测表）

  return hits;
}

/**
 * 单个思考块（`reasoning` block）的退化判据。
 *
 * 刻意**不**在思考里判"围栏不闭合"：思考中的代码片段天然可能是半截的，判它必然误报。
 * @param {string} text
 * @returns {string[]}
 */
export function reasoningDegradeReasons(text) {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const hits = [];

  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= THINK_LOOP_MIN_LINES) {
    const unique = new Set(lines).size;
    if (1 - unique / lines.length >= THINK_LOOP_REPEAT_RATE) hits.push('thinkLoop');
  }
  if (t.length >= THINK_HUGE_CHARS) hits.push('thinkHuge');
  if (symbolRunHit(t)) hits.push('symbolRun');

  return hits;
}

/**
 * 扫描一条助手消息的思考内容（一条消息可能有多个 reasoning 块）。
 *
 * `thinkBudget` 是**消息级**判据（依据 `usage.reasoningTokens` 真实计量），
 * 因此在块循环之外单独判定 —— 这样即使思考正文没有落盘、块为空，也能识别出
 * "这一条把思考预算烧穿了"。
 *
 * @param {Array|string} content - `data.message.content`
 * @param {object} [usage] - `data.usage`；缺省时不做预算判定（向后兼容）
 * @returns {{flagged:boolean, reasons:string[], worstRepeat:number, maxChars:number,
 *   reasoningTokens:number}}
 */
export function scanReasoning(content, usage) {
  const blocks = Array.isArray(content)
    ? content.filter((b) => b?.type === 'reasoning' && typeof b.text === 'string' && b.text.trim())
    : [];
  const reasons = new Set();
  let worstRepeat = 0;
  let maxChars = 0;
  for (const block of blocks) {
    for (const r of reasoningDegradeReasons(block.text)) reasons.add(r);
    const rep = worstLineRepeat(block.text);
    if (rep > worstRepeat) worstRepeat = rep;
    if (block.text.length > maxChars) maxChars = block.text.length;
  }
  const reasoningTokens =
    typeof usage?.reasoningTokens === 'number' && usage.reasoningTokens > 0
      ? usage.reasoningTokens
      : 0;
  if (reasoningTokens >= THINK_BUDGET_TOKENS) reasons.add('thinkBudget');
  return { flagged: reasons.size > 0, reasons: [...reasons], worstRepeat, maxChars, reasoningTokens };
}

/**
 * 退化判定（布尔版，保留旧签名）。
 *
 * @param {string} text
 * @param {'reply'|'reasoning'} [kind] - 判据集；默认按最终回复判
 * @returns {boolean}
 */
export function looksDegraded(text, kind = 'reply') {
  return kind === 'reasoning'
    ? reasoningDegradeReasons(text).length > 0
    : replyDegradeReasons(text).length > 0;
}

