/**
 * handoff · 共用的常量、评分与 token 口径
 *
 * 版本号、等级标签、决策句词表、有效窗口默认值（`COMPACT_DEFAULTS`）、
 * 健康评分（`scoreContextHealth`）与上下文规模口径（`contextTokensOf` / `blocksToText`）。
 *
 * 本模块**不依赖任何兄弟模块** —— 它是这套判定的地基：阈值与词表只在这里定义一次，
 * 所有下游（判据 / 折叠 / 计划 / 渲染）都从这里取，避免"改一处忘一处"的老坑。
 *
 * ── 本文件是 2026-09-18 D3 拆分产物 ──
 * 内容**逐字切分**自 `handoff.js` 第 32–534 行（共 503 行），
 * 只补了 `import` / `export` 与这段头注释，实现代码一个字符都没改；
 * 对外仍由 `handoff.js`（barrel）按原名单转发，公开 API 与拆分前完全一致。
 */

/** 插件版本（与 package.json 保持一致，测试会校验）。 */
export const PLUGIN_VERSION = '0.1.2';

/**
 * 风险等级 → 人类文案。**取值与 UI 半的 `LEVEL_META` 逐字一致**。
 *
 * 铁律：等级**只由上下文规模推出**，所以这里的文案**不得含任何行动含义**
 * （"建议交接 / 建议立即新开会话"之类）。行动建议的唯一来源是下面的双维度结论
 * （维度 A 质量 / 维度 B 压缩时机）。
 *
 * 历史：UI 半在 2026-09-15 已按用户截图反馈改成"上下文偏大 / 上下文过大"，
 * 交接文档这一半**漏改**，于是同一份文档里顶部写"建议交接"、正文写"可继续"、
 * 结论写"先手动压缩" —— 三处打架（复核文档【遗留-1】）。
 * 现在两侧统一口径，并由 `handoff-test` 断言"取值不得含『建议』二字"守住。
 */
export const LEVEL_LABEL = {
  ok: '正常',
  watch: '留意上下文',
  warn: '上下文偏大',
  critical: '上下文过大',
};

/** 「关键决策」抽取的关键词。命中任一即视为候选句。 */
/**
 * 「决策 / 未决」句的命中词。
 *
 * 刻意收紧：早期版本收了「失败 / 原因 / 注意 / 下一步 / 修复 / 坑」这类泛词，实测会把
 * 表格行、测试指标行（`| 主机测试 | 24 通过 / 0 失败 |`）、代码片段一并抽出来 ——
 * 74 条里大半是噪声，还会把**过期的数字**当决策展示。现在只留真正表达取舍与结论的词。
 */
export const DECISION_KEYWORDS = [
  '根因', '结论', '决定', '选定', '定案', '改为', '改成', '放弃', '不采用', '不再',
  '待确认', '待定', '未决', '下一步', '取舍', '权衡', '优先',
  '规避', '约束', '必须', '不能', '禁止', '假设', '风险', '踩坑',
];

/**
 * 通用**结论词**（第二级，会话级兜底）。
 *
 * 2026-09-15 复核第三次提出扩充词表。上一轮拒绝的是「失败 / 原因 / 注意 / 修复 / 坑」这类泛词
 * （实测把 74 条里大半变成表格行与过期数字）；这一批**实测过**，表现完全不同 ——
 * 全量新增 204 句（发现 141 / 推荐 47 / 因此 8 / 合计 6 / 最优 3），抽样全是结论性句子
 * （"核心发现：…"、"散件合计约 11900 元"、"更推荐去本地口碑好的维修店"）。
 *
 * 但直接并进主词表会让工程会话（主词表本就命中 800+ 句）的「关键决策」变长，所以做成
 * **会话级分级**：整场会话主词表命中不足 `DECISION_BROAD_TRIGGER` 条时，才用这张表兜底重抽。
 * 实测只影响 19/67 个会话、全量多 16 条 —— 精准补上非工程对话（咨询 / 报表 / 生活）的
 * 数字结论，主词表够用的会话完全不受影响。
 */
const DECISION_KEYWORDS_BROAD = ['发现', '推荐', '因此', '最优', '汇总', '合计'];

/**
 * **英文**取舍词表（2026-09-18 审查 F.2 新增）。
 *
 * 背景：原词表**全为中文**，对英文会话零命中。实测 60 个有实质正文的会话里，
 * 18 个中文占比 <60%（英文 / 代码为主），其中中文占比 <30% 的会话「关键决策」章节**完全为空**。
 * 典型案例 `session-SAMPLE-24c6a0d8`：正文 4,863 字符、中文仅 9%，却含明确结论句
 * "The key difference: standard solves Windows by swapping `tool-bash` …"——
 * 这正是最值得交接的那类句子，却被词表语言挡在门外。
 *
 * 选词立场与中文侧一致：**高精度、宁可漏报不误报**。刻意避开 `because` / `therefore` /
 * `so` / `note that` / `however` 这类在技术叙述里高频出现、会大面积误报的连接词。
 */
export const DECISION_KEYWORDS_EN = [
  'decided to',
  'decision',
  'conclusion',
  'root cause',
  'recommend',
  'chose',
  'switched to',
  'the key difference',
  'the fix is',
  'the approach is',
];

/**
 * **英文**通用结论词（第二级兜底，与 `DECISION_KEYWORDS_BROAD` 对称）。
 * 同样避开高频泛词，只在主表命中不足 `DECISION_BROAD_TRIGGER` 条时才启用。
 */
const DECISION_KEYWORDS_BROAD_EN = ['finding', 'findings', 'in summary', 'the best', 'overall', 'total of'];

/** 第一级抽取用的**中英合并**主词表（2026-09-18 F.2）。 */
export const DECISION_KEYWORDS_ALL = [...DECISION_KEYWORDS, ...DECISION_KEYWORDS_EN];

/** 第二级兜底用的**中英合并**通用词表。 */
export const DECISION_KEYWORDS_BROAD_ALL = [...DECISION_KEYWORDS_BROAD, ...DECISION_KEYWORDS_BROAD_EN];

/** 主词表命中少于该值 → 启用通用结论词兜底（实测值，见上）。 */
export const DECISION_BROAD_TRIGGER = 3;

/** 决策句的噪声模式：命中即丢弃（宁可少抽，也不要噪音）。 */
export const DECISION_NOISE = [
  /^#{1,6}\s/, // Markdown 标题行（如 "## 下一步（规则推导…）"）
  /\|/, // Markdown 表格行
  /[✅⚠❌🔴]/u, // 状态标记
  /\d+\s*(通过|失败)\s*\/\s*\d+/, // 测试指标行
  /[A-Za-z]:\\[^\s]{12,}/, // 长绝对路径
  /^[-*+]\s*\[[ xX]\]/, // checkbox 行
  /^\s*(npm|pnpm|node|git|curl|pwsh|powershell)\s/, // 命令行
];

/** 视为"命令行写文件"的工具名。 */
export const COMMAND_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'shell', 'cmd', 'zsh']);

/** 附录 A 的总长上限（字符）。 */
export const APPENDIX_MAX_CHARS = 20000;

/**
 * 附录 B（超长用户请求原文）的**合计**上限。
 *
 * 2026-09-15 审查修复：原来每条都全量放，8 条 3,500 字的长需求就能把文档撑到 37KB
 * （附录 B 独占 24KB），与"提炼压缩"的初衷相反。单条是否进附录由 `REQUEST_SUMMARY_CHARS`
 * 决定，这里限制总体积，超出部分只标注条数。
 */
export const APPENDIX_B_MAX_CHARS = 12000;

/** 用户请求超过该长度就压缩成摘要，原文进附录 B。 */
export const REQUEST_SUMMARY_CHARS = 320;

/**
 * 「压缩 vs 交接」成本模型的默认参数（需求补充 1/2）。
 *
 * **两套账并存**（2026-09-16）：
 *   · **token 当量**（相对量）：不受价格变动影响，用于文档/界面里横向比较三个方案；
 *   · **真实价格**（`prices`，元/百万 token）：绝对量，**判定用的是它** ——
 *     "该不该压缩 / 该不该新开"都由三方案的总花费比出来。
 * `cacheFactor` = 官方命中价 ÷ 未命中价（0.02），不再是"估计的相对倍数"。
 *
 * 关键背景：官方 `dsh-compaction-basic` 在**声明窗口的 80%** 触发自动压缩，
 * 压缩先做零 token 的裁剪（`compaction/prune`），必要时再调模型生成摘要
 * （`compaction/summary`，消耗 token 且有损）。
 */
export const COMPACT_DEFAULTS = {
  // ── 成本模型（2026-09-16：从"token 当量"升级为**真实价格**）──
  //
  // DeepSeek flash 系列现行价（2026-09-10 12:00 起，**空闲时段**，单位：元/百万 token）：
  //   输入缓存命中 **0.02** ｜ 输入缓存未命中 **1** ｜ 输出 **4**
  // 高峰时段（周一至周五 9:00-12:00、14:00-18:00）为上述 2 倍。插件**不区分峰谷**
  // ——要按峰时算，覆盖 `prices` 即可（用户明确说峰谷自己考虑）。
  //
  // 两个必须记住的事实：
  //   ① 命中与未命中**价差 50 倍**。所以高命中率下"继续"便宜到可以忽略：
  //      600k 上下文一轮 ≈ 0.03 元。旧代码按 10 倍估（`cacheFactor: 0.1`），
  //      **高估缓存成本 5 倍**，把压缩的账算得太乐观（回本 8 轮 vs 真实 21 轮）。
  //   ② **输出才是大头**：4 元/百万是未命中输入的 4 倍。一次思考打转打满 256k 思考预算
  //      ≈ **1.02 元**，约等于 270 轮正常对话、或 85 次机械交接（交接冷启动才 0.012 元）。
  //      旧模型完全不算输出，等于把最贵的那部分钱漏掉了。
  prices: {
    cacheHitPerMillion: 0.02,
    cacheMissPerMillion: 1,
    outputPerMillion: 4,
  },
  /** 缓存命中价相对未命中价的系数（= 0.02，与 `prices` 的比值一致；保留此字段便于测试覆盖）。 */
  cacheFactor: 0.02,
  /** 每轮平均输出 token 的兜底值（拿不到实测时的保守估计）。 */
  fallbackOutputTokens: 500,
  /**
   * "新开更省"的容差倍数（2026-09-16）。
   *
   * 只有当**新开的总花费**低于继续/压缩里更省的那个达到该倍数时，才改判"推荐新开"。
   * 理由：新开会话有无法量化的隐性成本 —— 重新交代背景、丢上下文、人工衔接 ——
   * 钱上差个 10% 不值得折腾；差到 1.5 倍以上才说明这条路真的更划算。
   */
  costFreshMargin: 1.5,
  /**
   * 交接回本必须留出的**轮数**余量（2026-09-18 新增，取代 `costFreshMargin` 的判定作用）。
   *
   * 判据：`回本轮数 + handoffMarginRounds < 预计剩余轮数` 才改判交接。
   * 留 1 轮的理由**不是钱，是估计误差**：剩余轮数由 `avgRoundGrowth` 外推，
   * 而实测 30 个会话的增速是 P25/P50/P75 = 8,157/14,548/20,708 token/轮 ——
   * 同一个 765k 上下文算出的 H 能差 2.4 倍（4.2 / 2.4 / 1.7 轮）。
   * 回本后剩不下 1 轮，结论就经不起增速估计本身的误差。
   */
  handoffMarginRounds: 1,
  /**
   * 「准备交接」中间档的**余量阈值**（AF.2 需求 2，2026-09-20 用户提出）。
   *
   * 背景：建议原先只有 continue / handoff 两档，于是"**差一点**"的情况被归进"可以继续"，
   * 用户既看不出边界快到了，也没有"在任务边界顺手交接"的余地。
   *
   * 判据：`0 ≤ freshWinMarginRounds ≤ prepareMarginRounds`（且其它成本门槛都过）→ 准备交接。
   * 与 `handoffMarginRounds` 的关系：交接要求"余量 > 1 轮"，所以 `0~2` 恰好是
   * "回本已落在窗口内、但优势没稳"的那条带 —— 与 handoff 不重叠、也不吃掉 continue。
   *
   * 取 2 的依据：`handoffMarginRounds` 的注释给了增速外推误差的量级（同上下文 H 可差 2.4 倍），
   * "再多留一轮"与那个误差同级；真实语料上的分布见 `work/af-prepare-scan.mjs`。
   */
  prepareMarginRounds: 2,
  /**
   * 「准备交接」的**金额接近比例**（同上）：`savingYuan` 达到门槛的这个比例、但未达门槛 → 准备交接。
   *
   * 与余量判据互补：余量看"窗口够不够"，金额看"省得够不够多"。
   * 取 0.6 是"离门槛只差最后一点"的直观含义；同样是**只约束成本通道**。
   *
   * AG 节（2026-09-22）扩展：这个比例现在是**两级软化的分界**——
   *   · `[0.6×门, 门)` → `prepare`（钱快到门槛了，给"边界交接"的余地）；
   *   · `(0, 0.6×门)` → `costNote`（最轻一档，只说"每轮成本偏高"，不劝任何动作）。
   */
  prepareSavingRatio: 0.6,
  /**
   * **会话成熟线**（轮）—— AG 节（2026-09-22 用户实测反馈）。
   *
   * 现场：一个 **7 轮**的会话（`session-SAMPLE-8f723845`）就收到"建议机械交接 + 新开会话"。
   * 数字本身成立（10.29 次请求/轮 × 235k 存量，继续确实贵、到官方线前省 ¥2.38），
   * 但**体验不成立**：任务刚展开就劝换会话，照做之后新会话以同样增速 7 轮又触发，
   * 任务被切成碎片 —— 而"任务连续性 / 重建理解"这些隐性代价**不在成本模型里**。
   *
   * 规则：**轮数低于本值时，成本通道最高只判 `prepare`（软提示）**，不催促。
   * 质量通道（退化 / 守卫）**不受本线限制** —— 真异常该说就说，那是止损不是打扰。
   *
   * 为什么"等到成熟线"不亏：会话跑到 15 轮时规模更大、每轮差额更大，
   * 那时的建议更扎实；而在第 7 轮给出的强建议，收益要靠几十轮外推才兑现，
   * 打扰却是即刻发生的 —— **先平滑，等建议自己变扎实**。
   *
   * 取 15 的依据：本会话（`fcafee61`，27 轮）与历史标定会话（`d854e8b5` 等）都在 20 轮上下，
   * 交接建议在那时才有"任务段落已成形"的语义；7 轮明显属于"刚展开"。
   * `turnCount` 已在判定链里（AB.3 接入，host 与离线两路都有），无需新增数据源。
   */
  matureSessionTurns: 15,
  /**
   * 跨会话**公共前缀**的实测命中率（2026-09-18 新增）。
   *
   * 实测依据：72 个会话的**首轮**样本，命中率中位数 **76%**（分布 0%~86%）。
   * 说明 system prompt + 工具 schema 这类公共前缀**跨会话共享**
   * （官方文档"公共前缀检测落盘"：多次请求存在公共前缀时会单独落盘该前缀单元）。
   *
   * 因此新会话首轮**不是**全未命中 —— 只有**交接文档**那部分是全新的、必然未命中。
   * 方案 C 的首轮必须**分段计费**：公共前缀按本系数加权，交接文档按未命中价。
   */
  handoffBaseHitRate: 0.76,
  /**
   * 成本裁决的**规模门槛**（声明窗口占比 %）—— 2026-09-18 用户拍板定 20。
   *
   * 为什么需要：修正方案 C 的分段计费后，76 个真实会话里 **66 个**翻转成"新开更省"，
   * 而其中大量上下文只有几十 k，`H` 由 `avgRoundGrowth` 线性外推出 736/848/1318/5214 轮
   * 这种不可能的值。数学上"回本 < H"成立，决策上荒谬。
   * 20 是实测选出的交点：参与 13 个会话、回本集中在 1~8 轮（收益实在），
   * 而 `used=4,938 / H=1318` 这类小会话被挡在外面。
   */
  handoffMinWindowPercent: 20,
  /**
   * 成本裁决的**外推轮数上限** —— 2026-09-18 用户拍板定 200。
   *
   * 与上一条互补：20% 挡"小上下文"，这一条挡"上下文不小、但增速极慢"的会话
   * （实测 `used=353,386 / 966 token 每轮 → H=462 轮`）。`H` 是线性外推，
   * 超过本值就不再是可用依据，此时不做成本裁决（保守判继续）。
   */
  handoffMaxHorizonRounds: 200,
  /**
   * "缓存崩了"的命中率阈值（2026-09-18 用户拍板定 0.5）。
   *
   * 低于此值说明前缀复用已经失效 —— 继续每轮都在按未命中价重付**全部**上下文
   * （实测 550k / 0% → ¥0.55/轮），而新会话只有首轮冷启动（约 ¥0.03）。
   * 这种场景**第 1 轮就回本**，所以它是**独立于"回本 < H"的第二条成本通道**：
   * 不看 `H` —— 估不出还要跑几轮，也不改变"该换"这个结论。
   *
   * 守卫测试见 `handoff-test.mjs`「闸门：缓存真崩（命中率 0%）时覆盖规则仍然生效 → 交接」，
   * 它的 fixture **故意不给 `avgRoundGrowth`**，就是为了守住这条通道不被 H 门槛误伤。
   */
  brokenCacheHitRate: 0.5,
  /**
   * 成本通道的**最小节省额**（元）—— 2026-09-18 S 节新增。
   *
   * 前三道门槛挡的是"算不出来的会话"（小上下文 / 荒谬外推 / 估不出轮数），
   * 这一道挡的是"算得出来、但不值一提"的：实测三个会话同样判"交接"，节省额差 10 倍 ——
   * `fcafee61` **¥0.023**、`d854e8b5` ¥0.100、`d346d3e8` **¥0.235**。
   *
   * 为 2 分钱劝人换会话是错的：换会话要复制文档、开新会话、等它重新进入状态（几分钟），
   * 人工成本是那 2 分钱的几百倍；而且这类会话往往**没有质量理由**（模型工作正常）。
   * 用户照做几次发现"换了也没差"，以后连真正该听的建议（模型崩了那种）也会被忽略。
   *
   * ⚠️ 它**只约束成本通道**：由退化 / 守卫触发的质量通道不受金额约束 ——
   * 那是"能不能干活"的问题，不是钱的问题。
   *
   * ── 2026-09-20 AB.3 重标定结论：**保持 0.15**，理由与证据 ──
   * 上面那三个数（¥0.023 / ¥0.100 / ¥0.235）是**旧口径**算出来的：总额拿"每次请求"的钱
   * 乘了"轮数"，而一轮里平均有 `stepsPerTurn` 次请求（全量 79 个会话 p50 = 8.11）
   * → 旧数字整体偏小，门槛被**实际收紧**了。口径修正（`handoff-plan.js` 的 `stepsPerTurn`）
   * 之后，同一个门槛作用在"真钱"上：
   *   · 该放行的会话放行了 —— 语料上新增 5 个建议交接，真实省额 ¥1.19~¥2.15
   *     （`fcafee61` / `d854e8b5` / `0748147e` / `8f906b2a` / `80a60f4a`，旧口径下它们的
   *      省额只有 ¥0.05~¥0.12，全被这道门槛挡住 —— 正是复核侧说的"该劝的没劝"）；
   *   · 没有会话"除金额外全都过、只卡在金额门槛上"（`work/ab-cost-baseline.mjs` 实测 0 个）
   *     → 这个值在当前语料上既不误挡也不空转，不需要为了数字好看去调它。
   * 复现：`node work/ab-cost-baseline.mjs`（含新旧口径的逐会话对照）。
   */
  minSavingYuan: 0.15,
  /**
   * 缺实测命中率时用于**金额展示**的假设命中率（不代表判定依据）。
   *
   * 判定（"该不该新开""压缩值不值"）一律要求 `hitRateKnown === true`：
   * 拿假设值去劝用户换会话，是在未经验证的推断上做大决定。
   * 但金额总得显示 —— 用 0.9 这个长会话常态值估算，并在界面标注"假设值"。
   */
  assumedHitRate: 0.9,
  /**
   * 有效窗口 = 声明窗口 × 该系数。
   *
   * 2026-09-16 边界设定：0.5 → **0.6**。
   *
   * 取 0.5 时，"质量线 ≥90% 有效"落在**声明窗口 45%**：1M 窗口用到 450k 就劝人新开会话，
   * 而官方自动压缩线在 800k —— 中间 35 万 token 被白白劝退（扫描矩阵实测）。
   * 0.6 把同一条线后移到 **54% 声明**；再配合上一条"质量判据必须有退化信号"，
   * 规模大而未退化的会话就不再被劝交接，而是交给压缩维度定时机。
   */
  effectiveWindowRatio: 0.6,
  /** 没有实测值时摘要输出的预估 token。 */
  summaryOutputTokens: 2000,
  /** 估算用的预计剩余轮数（无法预知，用保守默认值）。 */
  remainingRounds: 10,
  /** 机械交接后新会话的每轮基准上下文（系统提示 + 工具 schema ≈ 20K）。 */
  freshSessionBaseTokens: 20000,

  // ── 维度 A：质量（口径 = **有效窗口** = 声明 × ratio）──
  //
  // 2026-09-16 边界设定：**规模单独不再触发交接**，两个质量阈值都必须伴随退化信号。
  //
  // 原因（用扫描矩阵实测出来的，不是推测）：旧规则里 `qualityImmediatePercent` 只看规模，
  // 于是"有效 ≥90%"（= 声明 45%）之后整条曲线都被 `drivenBy=quality` 的 handoff 抢占——
  // 官方线（声明 80%）**永远轮不到**：那条「现在手动 /compact，否则官方即将自动压缩」的
  // 建议，在声明窗口 5%~100% 全区间一次都没成为结论（bandText 变成"即将自动压缩"、
  // 行动建议却仍是"建议机械交接"）。
  //
  // 而"上下文大"本身不是故障：真正不可救的是**退化**（重复调用 / 输出异常 / 思考打转），
  // 因为压缩只腾空间、不修复退化。规模大但没有退化的会话，交给压缩维度去定时机即可。
  /** 有效占用 ≥ 该值**且**有退化信号 → 建议交接。 */
  qualityHandoffPercent: 70,
  /** 有效占用 ≥ 该值**且**有退化信号 → 立即新开会话。 */
  qualityImmediatePercent: 90,
  /** 连续相同工具调用达到该次数 = 退化信号。 */
  qualityRepeatThreshold: 3,
  /** 输出退化回复数达到该值 = 退化信号。 */
  qualityDegradedThreshold: 1,
  /**
   * 思考守卫中止达到该次数 → **不看占用规模**直接建议交接（2026-09-18 R 节新增）。
   *
   * 为什么它要单列一条、而不是只当 `degraded` 的一个分量：
   * `degraded` 只在与"规模"组成双条件门时才判交接（占用 ≥70%），而实测那次
   * （`session-SAMPLE-bdde842b`：守卫掐断 **4 次**、占用 49.5%）规模不够，
   * 于是质量维度说"继续"、最终只能靠成本驱动 —— 而成本上**只省 ¥0.10**，
   * 前端理由写成"继续会话已不划算"，用户看到的是一句计较一毛钱的话。
   *
   * 判据性质上，守卫中止是**实时验证**过的退化（检测器当场判定并掐断，还留有现场），
   * 比事后统计的 `reasoningLoop` 更硬，更比依赖增速外推的成本推算可靠。
   * 取 2 而非 1：掐断一次可能是偶发（模型自己恢复了），**反复**掐断才说明执行能力不可靠。
   */
  qualityGuardTripHandoff: 2,

  // ── 维度 B：压缩时机（档位口径 = **声明窗口**，与官方线同一坐标系）──
  //
  // 2026-09-16 边界设定：档位从"有效窗口"改锚**声明窗口**。
  //
  // 旧口径（有效窗口 = 0.5×声明）有两个连带问题：
  //   ① 声明 40% 起全部落进 urgent，紧急档失去区分度；
  //   ② 它必须与质量维度共用同一坐标，于是质量维度一旦只看规模，就把整条压缩曲线遮蔽掉。
  //
  // 现在两个维度各归其位，互不遮蔽：
  //   · 质量维度用**有效窗口**回答"现在还可不可靠"（且必须有退化信号才动手）；
  //   · 压缩维度用**声明窗口**回答"什么时候该压"，直接与官方 80% 线对齐，不再换算。
  // 两者运行时并列展示、各自标注口径，不混用。
  /** 占声明窗口 <50% 继续；≥50% 轻度提示。 */
  compactMildFrom: 50,
  /** 占声明窗口 ≥65% 推荐手动压缩（带成本/收益）。 */
  compactRecommendFrom: 65,
  /** 占声明窗口 ≥80% 紧急（先压缩，别硬撑）。 */
  compactUrgentFrom: 80,
  /** 官方自动压缩线（占**声明窗口**），接近它直接判紧急。 */
  officialCompactPercent: 80,
  /**
   * 「现在还不必压缩」的余量门槛（轮）—— 2026-09-16 用户反馈后新增。
   *
   * 反馈原话：「还能用就开始建议手动压缩再继续了」。实测触发场景：上下文 383,757 /
   * 声明 1M → 有效占用 76.8%（band=recommend）→ 建议手动压缩，**但距官方自动压缩线
   * 还有 416,243 token（约 259 轮）**。旧规则只看"有效窗口档位"，没看"离官方线还有多远"。
   *
   * 判据改成"压缩要能兑现收益"：你得会继续工作足够久才值得现在压。官方线还有这么多轮才到，
   * 说明短期不会撞线；此时提前压缩是**纯支出**（一次性成本要先付、摘要有损），
   * 收益要等你真的继续工作才兑现。
   *
   * 取 30 轮 ≈ 成本模型里 `remainingRounds`（10）的 3 倍，也就是"至少要能回本三次"。
   */
  compactDeferMinRounds: 30,
  /**
   * 估不出轮数时的保守代理：占**声明窗口**低于该值就推迟压缩。
   * 理由：离 80% 官方线还有 20 个百分点以上，短期内不会自动压缩。
   *
   * 2026-09-16 边界设定：50 → **60**。
   *
   * 档位改锚声明窗口后，`compactMildFrom`（50）就是档位起点 —— 而那正是"降级成 continue、
   * 根本走不到推迟分支"的位置。保留 50 会让这条代理判据**永远不可达**：
   * 能进推迟分支的会话，声明窗口必然 ≥50，于是 "<50 就推迟" 恒为假。
   * 抬到 60 后，"50%~60% 声明且拿不到每轮增长"的会话会被稳妥地判为"现在不必压"。
   */
  compactDeferBelowDeclaredPercent: 60,

  // ── 覆盖规则（跨维度）──
  /** 压缩后仍高于该**声明**窗口占比 → 交接。 */
  handoffAfterWindowPercent: 60,
  /** 已压缩达到该次数 → 交接（收益递减 + 信息累积损失）。 */
  handoffAtCompactionCount: 2,

  // ── 压缩收益模型 ──
  /**
   * 没有实测值（上次压缩的真实前后规模）时，估计一次压缩能压掉当前上下文的比例。
   * 有实测时以实测的"不可压缩基线"为准。
   *
   * ⚠️ AH-B6（2026-09-22）后**降级为兜底**：主口径改用官方的 `retainRatio`（见下），
   * 本值只在"连窗口都拿不到"（`contextWindow === null`）时参与估算。
   */
  compressibleRatio: 0.6,
  /**
   * 自动压缩的**保留比例**（占声明窗口）—— AH-B6（2026-09-22）。
   *
   * 来源：官方 `dsh-compaction-basic` 源码实测 ——
   *   `thresholdTokens = floor(window × 0.8)`、`retainTokens = floor(window × 0.16)`
   * （`work/` 侧的第四版问题清单 B6 逐行核对，复核侧独立读源码确认）。
   *
   * 为什么需要它：本插件原先用 `compressibleRatio`（压掉 60%）反推"压缩后规模"，
   * 即 `baseline = usedTokens × 0.4` —— 这**把一个与窗口无关的假设**当成了压缩后的规模。
   * 而官方压缩是**锚窗口**的：压完保留约 `window × 0.16`。两者在 1M 窗口的会话上
   * 差异很大（实测 `fcafee61`：假设值 ≈ 267k，而官方机制应为 ≈ 160k），
   * 于是"压缩后每轮成本"被系统性高估、压缩方案显得比实际更差。
   *
   * 现在：`afterUsed = max(窗口基准, 骨架基准)`，`compressibleRatio` 仅作无窗口时的兜底。
   */
  retainRatio: 0.16,

  // ── 评分（"评分只反映上下文规模"）──
  // 与维度 A/B 的档位阈值**刻意分开定义**：评分是"背景信息"，两个维度才是行动依据，
  // 共用常量会让"改一次 B 档位"顺手改掉顶部评分，出现难以解释的联动。
  /** 有效占用 ≥ 该值 → 最重扣分档。 */
  scoreCriticalFrom: 90,
  /** 有效占用 ≥ 该值 → 次重扣分档。 */
  scoreWarnFrom: 70,
  /** 有效占用 ≥ 该值 → 轻扣分档。 */
  scoreWatchFrom: 50,
  /** 有效占用 ≥ 该值 → 极轻扣分档。 */
  scoreNoticeFrom: 30,

  // ── 有损压缩的评分上限（2026-09-15 复核【遗留-2】）──
  /**
   * 经历过的**模型摘要**次数 → 评分上限（按 `from` **降序**匹配，取第一个命中的）。
   *
   * 压缩是**续命**（有损），不是治愈：空间压力确实解除了，但原始内容已被摘要替换，
   * 细节可能已经丢了。只看 `totalTokens` 就会出现"压缩一次 → 100 分 → 判 ok → 提示条消失"，
   * 等于把续命记成治愈（实测：543,662 → 20,494，占用 −96%，分数直接回满）。
   *
   * 上限值**刻意都压在 ok 阈值（80）以下**，保证压缩过的会话不会再显示成"正常"。
   * 复核原稿给的是 85 / 70 / 50，但 85 仍在 ok 区间（实测压缩后判 ok、提示条依旧消失），
   * 与它自己的验收标准"应停在 watch"冲突 —— 故下调为 79 / 65 / 50。
   *
   * 只数**模型摘要**（`summaryCount`）：零 token 的 `prune` 裁剪不消耗模型、损失小得多。
   */
  lossySummaryCaps: [
    { from: 3, cap: 50 },
    { from: 2, cap: 65 },
    { from: 1, cap: 79 },
  ],
};

/**
 * 由原始指标算出**评分、等级与说明** —— 全插件唯一的评分实现。
 *
 * 为什么必须唯一：`index.js` 的投影（热会话）与 `handoff.js` 的日志折叠（冷会话）
 * 都要展示评分。两处各写一份，就会出现"提示条说 55 分、交接文档说 100 分"这类
 * 自相矛盾（2026-09-15 复核：UI 半改了、文档半没改，同源数据两种说法）。
 * 现在热/冷两条路径都调用本函数，口径由构造保证一致。
 *
 * 评分的边界：**只由上下文规模（含退化信号）推出**，与挂钟时间、轮数无关；
 * 它**不给任何行动建议**（那是双维度结论的职责）。
 *
 * @param {object} input
 * @param {number} [input.usedTokens] - 当前上下文规模（token）
 * @param {number|null} [input.contextWindow] - 模型声明窗口
 * @param {number} [input.repeatWorst] - 最长连续相同工具调用
 * @param {number} [input.degradedReplies] - 退化回复条数
 * @param {number} [input.reasoningLoop] - 思考打转次数（2026-09-15 复核 N-5 新增）
 * @param {number} [input.reasoningFlags] - 其他思考异常次数（异常长 / 预算打满 / 符号堆砌）
 * @param {number} [input.reasoningWorstRepeat] - 思考里同一行重复的最高次数（仅用于说明）
 * @param {number} [input.summaryCount] - 经历过的**模型摘要**次数（有损压缩）
 * @param {object} [input.thresholds] - 覆盖 `COMPACT_DEFAULTS`
 * @returns {{score:number, level:string, findings:string[], windowPercent:number|null,
 *   effectiveWindow:number|null, effectivePercent:number|null, cap:number|null,
 *   capped:boolean, summaryCount:number}}
 */
export function scoreContextHealth(input = {}) {
  const T = { ...COMPACT_DEFAULTS, ...(input.thresholds ?? {}) };

  const usedTokens =
    typeof input.usedTokens === 'number' && input.usedTokens > 0 ? input.usedTokens : 0;
  const contextWindow =
    typeof input.contextWindow === 'number' && input.contextWindow > 0 ? input.contextWindow : null;
  const repeatWorst = input.repeatWorst ?? 0;
  const degradedReplies = input.degradedReplies ?? 0;
  // 思考过程退化（2026-09-15 复核 N-5）：真事故里唯一能看到的信号，见文件头实测依据。
  const reasoningLoop = Math.max(0, input.reasoningLoop ?? 0);
  const reasoningFlags = Math.max(0, input.reasoningFlags ?? 0);
  const reasoningWorstRepeat = Math.max(0, input.reasoningWorstRepeat ?? 0);
  const summaryCount = Math.max(0, input.summaryCount ?? 0);

  const windowPercent = contextWindow && usedTokens ? (usedTokens / contextWindow) * 100 : null;
  const effectiveWindow = contextWindow ? Math.round(contextWindow * T.effectiveWindowRatio) : null;
  const effectivePercent =
    effectiveWindow && usedTokens ? Math.min(100, (usedTokens / effectiveWindow) * 100) : null;

  let score = 100;
  const findings = [];

  if (effectivePercent !== null) {
    // 扣分力度经过校准，使 score 与 level 阈值自然一致：
    //   占用 ≥90% → 25 分 → critical ／ ≥70% → 55 分 → warn ／ ≥50% → 75 分 → watch
    //
    // 文案只写**判断 + 扣分说明**：占用率数字已经在结构化行给过一遍，复述是噪音；
    // 它也**不给行动建议**，否则会出现"上面劝交接、下面劝压缩"的自相矛盾。
    const degradedSignal =
      degradedReplies > 0 ||
      repeatWorst >= T.qualityRepeatThreshold ||
      reasoningLoop > 0 ||
      reasoningFlags > 0;
    if (effectivePercent >= T.scoreCriticalFrom) {
      score -= 75;
      findings.push(`已超出可靠工作区间（有效窗口的 ${T.scoreCriticalFrom}% 线；评分 −75）`);
    } else if (effectivePercent >= T.scoreWarnFrom) {
      score -= 45;
      findings.push(
        degradedSignal
          ? '进入有效窗口的偏大区，且检出退化信号 —— 压缩修不好退化（评分 −45）'
          : '进入有效窗口的偏大区，未检出退化信号（仍在可靠区间，注意观察；评分 −45）',
      );
    } else if (effectivePercent >= T.scoreWatchFrom) {
      score -= 25;
      findings.push('已过有效窗口一半（评分 −25）');
    } else if (effectivePercent >= T.scoreNoticeFrom) {
      score -= 8;
      findings.push('上下文开始累积（评分 −8）');
    }
  }

  if (repeatWorst >= 8) {
    score -= 25;
    findings.push(`连续 ${repeatWorst} 次相同工具调用（严重打转）`);
  } else if (repeatWorst >= 5) {
    score -= 15;
    findings.push(`连续 ${repeatWorst} 次相同工具调用（疑似打转）`);
  } else if (repeatWorst >= T.qualityRepeatThreshold) {
    score -= 8;
    findings.push(`连续 ${repeatWorst} 次相同工具调用`);
  }

  if (degradedReplies > 0) {
    score -= Math.min(30, degradedReplies * 6);
    findings.push(`${degradedReplies} 条回复出现复读/格式/符号异常`);
  }

  // ── 思考退化（N-5）：打转是"输出预算正在被烧掉"的直接证据，扣分力度高于回复异常 ──
  // 实测事故：单块 53.5 万字符、同一行重复 69,667 次、reasoningTokens 打满 256,000。
  if (reasoningLoop > 0) {
    const penalty = Math.min(50, reasoningLoop * 25);
    score -= penalty;
    findings.push(
      `思考过程出现打转：${reasoningLoop} 次` +
        (reasoningWorstRepeat >= 10 ? `（最长同一行重复 ${reasoningWorstRepeat.toLocaleString('en-US')} 次）` : '') +
        `（评分 −${penalty}）`,
    );
  }
  if (reasoningFlags > 0) {
    const penalty = Math.min(12, reasoningFlags * 4);
    score -= penalty;
    findings.push(`思考过程异常长 ${reasoningFlags} 次（评分 −${penalty}）`);
  }

  // ── B：把"已经历有损压缩"作为一条评分依据摆出来（2026-09-15 复核【遗留-2】）──
  // 它不解释"分数为什么低"，而是提醒"分数的含义已经变了" —— 压缩之后的高分并不等于健康。
  let cap = null;
  if (summaryCount > 0) {
    const tier = (T.lossySummaryCaps ?? []).find((t) => summaryCount >= t.from);
    cap = tier ? tier.cap : null;
    findings.push(
      `已经历 ${summaryCount} 次模型摘要（有损）：原始内容已被摘要替换，细节可能已丢失` +
        (cap !== null ? `（评分据此封顶 ${cap}）` : ''),
    );
  }

  // ── A：评分上限 —— 压缩是"续命"，不该把分数送回满分 ──
  score = Math.max(0, Math.round(score));
  let capped = false;
  if (cap !== null && score > cap) {
    score = cap;
    capped = true;
  }

  const level = score >= 80 ? 'ok' : score >= 60 ? 'watch' : score >= 40 ? 'warn' : 'critical';

  return {
    score,
    level,
    findings,
    windowPercent,
    effectiveWindow,
    effectivePercent,
    cap,
    capped,
    summaryCount,
  };
}

// ─────────────────────────── 通用小工具 ───────────────────────────

/**
 * 从一次请求的 `usage` 推算**上下文 token 规模** —— 热路径（投影）、冷路径（日志折叠）
 * 与离线 CLI 共用的**唯一实现**。
 *
 * ⚠️ **关键陷阱**：`inputTokens` 只是**未命中前缀缓存**的那部分输入。
 * 实测某个长会话里 `inputTokens` 仅 142~258，而 `cacheReadTokens` 高达 256,128 ——
 * 直接用 `inputTokens` 会把上下文规模低估三个数量级。
 *
 * 取值优先级：
 *   1. `totalTokens`（= inputTokens + cacheReadTokens + outputTokens，已实测验证）
 *   2. 三项相加
 *   3. `0`（无法判断）
 *
 * 2026-09-15 复核实测补充：原先只判 `typeof === 'number'`，于是 `NaN` / `Infinity`
 * 会被当成合法规模，进而产出**违反投影 schema** 的 state（`z.number()` 拒收 `NaN`）。
 * host 插件里一次校验失败就可能连累整轮请求，所以这里要求**有限正数**。
 *
 * 为什么必须唯一：`plugin/index.js` 与 `lib/detect.mjs` 曾各持一份拷贝
 * （与当年 `textOf` 被删掉的理由完全相同）—— 同一职责两份实现，
 * 两次改动就会分叉，而"投影说 142、文档说 256,128"这类矛盾最难查。
 *
 * @param {object} usage - `assistant/message` 的 `data.usage`
 * @returns {number} 该次请求涉及的上下文 token 总量；无法判断时返回 0
 */
export function contextTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const total = finite(usage.totalTokens);
  if (total > 0) return total;
  const sum = finite(usage.inputTokens) + finite(usage.cacheReadTokens) + finite(usage.outputTokens);
  if (sum > 0) return sum;
  return 0;
}

export function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      parts.push(blocksToText(block.content));
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}
