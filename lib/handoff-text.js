/**
 * handoff · 文本工具（截断 / 清洗 / 句子切分 / 决策句抽取）
 *
 * 把任意文本整理成"能进文档"的形状：截断加省略号、剥 Markdown 装饰、
 * 切句、按关键词抽决策句。全部是纯函数，不依赖会话结构。
 *
 * 只依赖 `handoff-core.js` 的词表。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 535–810 行（共 276 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 */
import { DECISION_KEYWORDS_ALL, DECISION_NOISE } from './handoff-core.js';
/** 把命中原因计数拼成"（符号堆砌 ×2、同行复读）"，让读者能自己判断提示可不可信。 */
export function degradeReasonText(items) {
  const parts = (Array.isArray(items) ? items : [])
    .filter((it) => it && Number(it.count) > 0)
    .map((it) => `${it.label ?? it.key}${Number(it.count) > 1 ? ` ×${it.count}` : ''}`);
  return parts.length ? `（${parts.join('、')}）` : '';
}

/** 压平空白并截断，超出时标注原始长度。 */
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}… (${flat.length} 字)`;
}

/**
 * Markdown 表格单元格转义（2026-09-15 审查修复）。
 *
 * 会话正文里出现一个 `|` 就能把整行拆散 —— 实测助手回复写"方案A | 方案B | 方案C"，
 * 6 列的进度表被切成 8 个单元格，整表错位。所有进入表格的字段都要先过这里。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\') // 先转义反斜杠，否则会把下面对 | 的转义二次转义
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseArguments(raw) {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function seqOf(event) {
  return event?.seq ?? event?.seq0;
}

export function timeOf(event) {
  return event?.time ?? event?.time0;
}

/** 归一化：只留字母/数字/汉字，用于比较与去重。 */
export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 双字母组 Jaccard 相似度（0~1）。纯本地、可解释。 */
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const grams = (s) => {
    const map = new Map();
    for (let i = 0; i + 1 < s.length; i += 1) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };

  const A = grams(na);
  const B = grams(nb);
  let inter = 0;
  let union = 0;
  for (const [g, c] of A) {
    const d = B.get(g) ?? 0;
    inter += Math.min(c, d);
    union += Math.max(c, d);
  }
  for (const [g, c] of B) if (!A.has(g)) union += c;
  return union === 0 ? 0 : inter / union;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间字符串（秒精度）。 */
export function isoLocal(ms) {
  if (typeof ms !== 'number') return String(ms ?? '未知');
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}:${pad2(d.getSeconds())}`;
}

// ─────────────────────────── 决策句抽取 ───────────────────────────

/** 把一段文本切成候选句子（按中英文句末标点与换行）。 */
function splitSentences(text) {
  const flat = String(text ?? '').replace(/\r/g, '');
  return flat
    // 2026-09-18 审查 F.2 深挖：**必须也按英文句点切分**。
    // 原规则只认中文标点 / `;!?` / 换行，于是英文段落整段保留 —— 实测
    // `session-SAMPLE-24c6a0d8` 里含结论的那段因此长到 **417 字符**，被下游
    // `s.length > 400` 直接跳过。这才是"英文会话决策章节全空"的真根因
    // （词表只有中文只是表象的一半：加了英文词表也照样抽不到）。
    //
    // 保护：只在「句点 + 空白 + 大写字母 / 左括号」处切，避免切碎
    // `1.5` / `v0.2.1` / `e.g. xxx` / `tool-bash` 这类技术写法。
    .split(/(?<=[。；！？!?;])|(?<=\.)\s+(?=[A-Z(])|\n+/)
    .map((s) => s.replace(/^[\s>*\-–—•\d.、()（）]+/, '').trim())
    .filter(Boolean);
}

/**
 * 抽取一段文本里的「决策 / 未决」句子。
 *
 * 规则朴素：长度 12~400 字、命中关键词、排除纯符号行与代码行。宁可少抽也不要噪音。
 */
/**
 * 临时产物 / 验证脚本标注（2026-09-15 审查指出：`.dsh-tmp` 产物、`work\` 复核脚本
 * 与项目源码并列，会让接手方误以为它们也是要维护的代码）。
 */
export function tempTag(p) {
  const s = String(p ?? '');
  if (/(\\|\/)\.dsh-tmp(\\|\/)/i.test(s) || /(\\|\/)tmp(\\|\/)/i.test(s)) return ' ⚠️ **临时产物**';
  if (/(\\|\/)work(\\|\/)/i.test(s) || /(\\|\/)outputs(\\|\/)/i.test(s)) return '（复核/发布脚本）';
  return '';
}

/**
 * 把一段 Markdown 压成适合放进表格单元格的纯文本（2026-09-15 审查修复）。
 * 审查实测：进度表"结果"列直接塞了助手回复里的 `| # | 需求 | 落地方…` 表格片段，难读。
 */
export function plain(text, max) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' '); // 代码块
  t = t.replace(/`([^`]*)`/g, '$1'); // 行内代码
  t = t.replace(/^\s*\|.*\|\s*$/gm, ' '); // 表格行
  t = t.replace(/^\s*[-*+]\s+/gm, ' '); // 列表符号
  t = t.replace(/^\s*#{1,6}\s+/gm, ' '); // 标题
  t = t.replace(/^\s*-{3,}\s*$/gm, ' '); // 分隔线
  t = t.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1'); // 强调
  return clip(t.replace(/\s+/g, ' ').trim(), max);
}

/**
 * 内联标记清理（渲染期兜底）：成对的强调保留，**落单的标记直接删掉**。
 *
 * 抽取阶段已经只剥成对标记并做了配对自检（宁可带着完整标记返回），但源文本本身可能
 * 就是断的（会话里出现过 `交接结论（已实测核实）**` 这种半截加粗），而 `clip()` 截断
 * 也可能在标记中间切开。半截 `**` / 反引号会让后续整段变粗体或把文字吃掉，
 * 所以真正写进文档前再兜一次。
 */
export function sanitizeInline(text) {
  let t = String(text ?? '');
  const dropLast = (s, marker) => {
    const n = s.split(marker).length - 1;
    if (n % 2 === 1) {
      const at = s.lastIndexOf(marker);
      if (at >= 0) return s.slice(0, at) + s.slice(at + marker.length);
    }
    return s;
  };
  t = dropLast(t, '`');
  t = dropLast(t, '**');
  return t.replace(/\s+/g, ' ').trim();
}

/** 编号/项目符号句的开头（① 或 1. 或 (1)）。 */
const NUMBERED_RE = /^(?:[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|\(?\d{1,2}[.、)）])\s*/;

/**
 * 只去掉**成对**的 Markdown 装饰（2026-09-15 审查修复）。
 *
 * 旧实现用 `^[`*_>\-\s]+` 无差别裁剪两端，于是 `deploy.ps1\`` 这种"开头是正文、
 * 末尾才是标记"的句子会被剥成 `deploy.ps1\`` —— 留下一个孤立反引号，
 * 渲染时会把后续文字吃掉或整段变粗体。
 *
 * 现在：列表/引用前缀只从开头去；强调标记只去成对包住整句的那种。
 */
function stripMarkdownDecorations(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^(?:[-*+]\s+|>\s+|\d+[.、)]\s+)+/, '').trim();

  const original = t;
  const pairs = [
    [/^\*\*(.+)\*\*$/s, '$1'],
    [/^__(.+)__$/s, '$1'],
    [/^`(.+)`$/s, '$1'],
    [/^\*(.+)\*$/s, '$1'],
  ];
  let changed = true;
  let guard = 0;
  while (changed && guard < 4) {
    changed = false;
    guard += 1;
    for (const [re, rep] of pairs) {
      if (re.test(t)) {
        t = t.replace(re, rep).trim();
        changed = true;
      }
    }
  }

  // 配对自检（2026-09-15 审查建议 2）：剥完若还剩**奇数个** ` 或 `**`，
  // 说明这一剥把一对标记拆坏了（例如 `**四件事值得记住**：…` 被剥成 `四件事值得记住**：…`）。
  // 此时宁可带着完整标记返回 —— 坏标记会让后续整段变粗体或吃掉文字。
  for (const marker of ['`', '**']) {
    if ((t.split(marker).length - 1) % 2 === 1) return original;
  }
  return t;
}

/**
 * 提取"决策句"（含关键词的句子），并就地合并连续编号句。
 *
 * 2026-09-18 审查 B1：这里原本还有一个独立的 `mergeNumberedSentences()`（约 18 行），
 * 全项目搜索**零调用者** —— 编号句合并的责任已经在下面这个函数内部就地完成
 * （见其中对 `NUMBERED_RE` 的两处用法）。死函数已删除。
 */
export function extractDecisionSentences(text, keywords = DECISION_KEYWORDS_ALL) {
  const sentences = splitSentences(text)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const hits = new Set();
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    if (s.length < 12 || s.length > 400) continue;
    if (/^[{}()[\];,.<>|=+\-*/\\_#`~^&%$@!?:"']+$/.test(s)) continue;
    if (/^(const|let|var|function|import|export|return|if|for|while)\b/.test(s)) continue;
    if (DECISION_NOISE.some((re) => re.test(s))) continue;
    // 2026-09-18 审查 F.2：英文关键词必须**大小写不敏感** ——
    // 结论句常以大写开头（"The key difference: …"），用 `s.includes(kw)` 永远匹配不到
    // 小写词条 `the key difference`。中文词条不含拉丁字母，转小写对它们没有影响。
    const lower = s.toLowerCase();
    if (!keywords.some((kw) => lower.includes(kw))) continue;
    hits.add(i);
  }

  // 编号序列：只要序列里**有**一条命中，就把整段连续编号一起带上 ——
  // 否则没命中关键词的那几条会消失，读者看到"① ② ④"会以为漏了内容（2026-09-15 审查）。
  const out = [];
  let i = 0;
  while (i < sentences.length) {
    if (NUMBERED_RE.test(sentences[i])) {
      let j = i;
      while (j < sentences.length && NUMBERED_RE.test(sentences[j])) j += 1;
      let hasHit = false;
      for (let k = i; k < j; k += 1) {
        if (hits.has(k)) {
          hasHit = true;
          break;
        }
      }
      if (hasHit) {
        const merged = sentences.slice(i, j).map(stripMarkdownDecorations).join(' ').trim();
        if (merged.length >= 12) out.push(merged);
      }
      i = j;
    } else {
      if (hits.has(i)) {
        const clean = stripMarkdownDecorations(sentences[i]);
        if (clean.length >= 12) out.push(clean);
      }
      i += 1;
    }
  }
  return out;
}

