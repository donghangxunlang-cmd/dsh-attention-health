/**
 * attention-health-ui —— 浏览器半（手写产物，未经 tsdown 构建）。
 *
 * ## 为什么可以手写
 *
 * 宿主加载客户端 bundle 的契约很简单（对照 `dsh-client-ui-jobs/lib/client.js`）：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * ```
 *
 * 这是一个**惰性 CJS factory**：执行只注册 factory，模块副作用在物化时运行。
 * `require` 由页面的基座模块表解析 —— 基座内已有 `react` 等，
 * 所以**不需要 external 声明，也不需要构建链**。
 *
 * ## 行为
 *
 * 1. 消费 host 半注册的 `attentionHealth` projection，在 composer 下方渲染风险提示条。
 *    **仅在出现风险时渲染**（`level !== 'ok'`）—— 正常时不占用任何界面空间。
 * 2. 展开后的操作区提供「复制交接内容」：浏览器 fetch host 半注册的本地路由
 *    `/attention-health/handoff`，拿到**纯规则提炼**的精简交接 Markdown
 *    （零模型调用、零 token），**直接复制到剪贴板**，由用户粘贴到新会话。
 *
 * ## 为什么最终是"复制到剪贴板"而不是"自动预填新会话"
 *
 * 曾经做过自动方案（`uiWorkspace.startSession()` + 新会话 `inputActions.setDraft()`），
 * 但客户端实测 `ctx.get('uiWorkspace')` 在 apply 阶段拿不到服务（与 host 侧同一个
 * "服务注册早于插件初始化"的问题），于是退化为明确报错、不可用。
 * 按用户决定改为剪贴板方案：不依赖任何服务时序，一步到位且零副作用。
 *
 * 剪贴板优先级：`navigator.clipboard.writeText`（127.0.0.1 属安全上下文）
 * → 兜底 `document.execCommand('copy')`。两者都失败时**明确报错**，
 * 绝不假装成功。
 */

window.__ModuleLoader__.load({
  id: 'dsh-attention-health',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /**
     * 风险等级 → 视觉与文案。取值与 host 半的 `level` 一一对应。
     *
     * 重要：等级**只由上下文规模推出**，所以这里**不给任何行动建议**（"建议交接"之类），
     * 只说清规模状态。行动建议的唯一来源是 host 的双维度结论（`compactAdviceText`）——
     * 否则会出现"标题劝交接、正文劝压缩"的自相矛盾（2026-09-15 用户实测截图反馈）。
     */
    const LEVEL_META = {
      watch: {
        color: '#eab308',
        label: '留意上下文',
        hint: '上下文已接近有效工作区间的一半，注意单次塞入的量。',
      },
      warn: {
        color: '#f97316',
        label: '上下文偏大',
        hint: '已进入有效窗口的偏大区；是否交接要看质量维度有无退化信号，见展开区。',
      },
      critical: {
        color: '#ef4444',
        label: '上下文过大',
        hint: '已超出可靠工作区间。请按下方结论行动：若结论是交接，先复制交接内容再新开会话。',
      },
    };

    /** host 半注册的本地路由。 */
    const HANDOFF_ENDPOINT = '/attention-health/handoff';

    /** 从当前页面 URL 里取鉴权 token（DSH 的 token 就在 query 上）。 */
    function readToken() {
      try {
        const search = String((window.location && window.location.search) || '');
        const matched = /[?&]token=([^&]+)/.exec(search);
        return matched ? decodeURIComponent(matched[1]) : '';
      } catch (_error) {
        return '';
      }
    }

    /**
     * 调 host 半生成交接内容。失败一律抛出，绝不静默降级。
     *
     * `profile`：`'slim'`（默认，精简档：结论 + 待办 + 文件 + 最近 1 轮原文）或
     * `'full'`（完整档：含完整元说明与附录 B 全量留档）。
     *
     * @param {string} sessionId
     * @param {'slim'|'full'} [profile]
     */
    async function requestHandoff(sessionId, profile) {
      if (typeof fetch !== 'function') throw new Error('当前页面不支持 fetch，无法调用本地生成接口');

      const token = readToken();
      const url =
        HANDOFF_ENDPOINT +
        '?sessionId=' +
        encodeURIComponent(String(sessionId)) +
        '&profile=' +
        encodeURIComponent(profile === 'full' ? 'full' : 'slim') +
        (token ? '&token=' + encodeURIComponent(token) : '');

      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      const raw = await response.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        throw new Error('生成接口返回的不是 JSON（HTTP ' + response.status + '）');
      }
      if (!response.ok || !data || data.ok !== true) {
        throw new Error(String((data && data.error) || 'HTTP ' + response.status));
      }
      if (typeof data.markdown !== 'string' || data.markdown === '') {
        throw new Error('生成接口返回的交接内容为空');
      }
      return data;
    }

    /**
     * 把文本放进剪贴板。
     *
     * @param {string} text
     * @returns {Promise<void>} 失败时抛出（调用方负责显示原因）
     */
    async function copyToClipboard(text) {
      // 1) 异步剪贴板 API：127.0.0.1 属安全上下文，通常可用
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (error) {
          // 落到下面的兜底，但要保留原因
          if (typeof document === 'undefined') throw error;
        }
      }

      // 2) 兜底：临时 textarea + execCommand
      if (typeof document === 'undefined' || !document.body) {
        throw new Error('页面不支持剪贴板 API');
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      try {
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        if (!ok) throw new Error('execCommand 复制失败');
      } finally {
        document.body.removeChild(area);
      }
    }

    /**
     * 会话内上下文健康提示条 + 展开后的交接操作区。
     *
     * props 由 slot 注入；本组件只用到 `useProjection` 与 `sessionId`。
     */
    function AttentionHealthBar(props) {
      const useProjection = props && props.useProjection;
      const sessionId = props && props.sessionId;

      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      /** 展开区里"异常现场"当前展开了哪一条（-1 = 全部收起）。2026-09-18 H.8。 */
      const [openSample, setOpenSample] = React.useState(-1);

      const health = typeof useProjection === 'function' ? useProjection('attentionHealth') : undefined;

      // 打扰判据由 host 统一给出（`level` 只看上下文规模，而最终建议还会被"压缩次数 /
      // 压缩后仍偏高"这类覆盖规则改写；旧代码只看 level，"level=ok 但建议交接"的
      // 结论就会整条不可见，连复制按钮一起消失）。2026-09-15 审查修复。
      // 防御性回退：stateVersion 升到 3 之后 host 一定会给这个字段；万一拿到的是旧折叠态，
      // 退回按 level 判断 —— 总比整条不渲染好。
      const notify =
        typeof health?.shouldNotify === 'boolean' ? health.shouldNotify : health?.level !== 'ok';
      if (!health) return null;

      /**
       * 生成交接内容 → 复制到剪贴板。
       *
       * `profile`：`'slim'`（默认精简档）或 `'full'`（完整档）。
       * 注意 onClick 会把事件对象当第一个参数传进来，所以调用处一律写 `() => onCopy('slim')`。
       */
      const onCopy = (profile) => {
        if (busy) return;
        const mode = profile === 'full' ? 'full' : 'slim';
        setBusy(true);
        setNotice('');
        setError('');

        requestHandoff(sessionId, mode)
          .then((data) => copyToClipboard(data.markdown).then(() => data))
          .then((data) => {
            setBusy(false);
            setNotice(
              '已复制' +
                (mode === 'full' ? '完整档' : '精简档') +
                ' ' +
                data.markdown.length.toLocaleString() +
                ' 字符（' +
                data.markdown.split('\n').length +
                ' 行），直接粘贴到新会话即可（内容可能含个人信息，分享前请自行确认）',
            );
          })
          .catch((err) => {
            setBusy(false);
            setError(String((err && err.message) || err));
          });
      };

      // 规模档位文案：静默入口与折叠行都要用，所以在这里先算出来（W 节 2026-09-18）。
      const SIZE_TEXT = { ok: '正常', watch: '偏大', warn: '较大', critical: '过大' };
      const sizeText = SIZE_TEXT[health.level] || '未知';

      // 静默态：不展开完整提示条，但保留一个**极轻的入口**（2026-09-15 审查 P3-4）。
      // 旧实现只在风险时渲染整条提示条，于是"想主动交接却找不到入口" ——
      // 用户可能在任何时候要开新会话，而不是只在被提示时。
      //
      // 2026-09-18 W 节（用户拍板"无异常即静默"）：静默现在覆盖**两种**情况 ——
      // 真健康，以及"仅规模偏大但无退化、成本也不过门槛"。后者仍有信息价值
      // （规模是多少、账怎么算），所以入口上加一个"展开"：**想看就展开**。
      // 判据由 host 下发（`shouldNotify`），界面不自己重算。
      if (!notify && !open) {
        return React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              lineHeight: '16px',
              padding: '0 8px',
              opacity: 0.45,
            },
          },
          React.createElement(
            'span',
            {
              onClick: () => setOpen(true),
              title: '当前无异常、也无行动建议 —— 点开查看规模与账目',
              style: { cursor: 'pointer' },
            },
            // W.6（2026-09-18 用户反馈）：静默状态**只能是中性的** ——
            // 入口写"● 上下文规模：过大"会自己打自己的脸（判定说"不需要打扰"，
            // 字面却像警报）。规模档位只留在展开区（"想看啥就展开"）。
            '● 无异常',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => onCopy('slim'),
              disabled: busy,
              title: '把当前会话提炼成交接内容（精简档）并复制到剪贴板（纯本地、零 token）',
              style: {
                all: 'unset',
                cursor: busy ? 'default' : 'pointer',
                border: '1px solid rgba(128,128,128,0.35)',
                borderRadius: '4px',
                padding: '0 6px',
                fontSize: '11px',
              },
            },
            busy ? '生成中…' : '复制交接内容',
          ),
          React.createElement(
            'span',
            { onClick: () => setOpen(true), title: '展开详情', style: { cursor: 'pointer' } },
            '详情 ▾',
          ),
          notice ? React.createElement('span', { style: { opacity: 0.85 } }, notice) : null,
          error ? React.createElement('span', { style: { color: '#ef4444', opacity: 0.9 } }, error) : null,
        );
      }

      const meta = LEVEL_META[health.level] || LEVEL_META.watch;
      const pct =
        typeof health.effectivePercent === 'number'
          ? health.effectivePercent.toFixed(1) + '%'
          : '未知';

      /**
       * 界面不渲染 Markdown：把标记剥掉，免得在界面上漏出 `**` 或反引号。
       *
       * host 的 `compactAdviceNote` 本来就不含标记，这里是**防漂移的保险** ——
       * 一旦有人把给文档用的 `compactReason`（含 `**粗体**` 与 `` `/compact` `` 反引号）
       * 直接接过来，界面也不会变脏。
       * 2026-09-16 Codex 审查 P2：原来只剥 `**`，漏了反引号与单星号，已补齐。
       */
      const stripMd = (s) =>
        String(s == null ? '' : s)
          .replace(/\*\*/g, '')
          .replace(/[*`]/g, '');

      // ── 边界（2026-09-16）：缺数据时**不许假装知道** ──
      // 旧版在 `usedTokens = 0` / 缺声明窗口时照样渲染 "0 token · 有效占用 未知"，
      // 维度行还会给出档位文案（"继续（有效窗口 <50%）"）—— 那是**编造出来的结论**。
      const hasScale = (health.usedTokens || 0) > 0;
      const hasPercent = typeof health.effectivePercent === 'number';
      const dataMissing = !hasScale || !hasPercent;
      const MISSING = '无法判断（缺窗口或用量数据）';
      const fmtTok = (v) => (typeof v === 'number' ? v.toLocaleString() : '未知');

      // 行动建议的**唯一来源**：host 的双维度最终结论。
      // 折叠行直接显示它 —— 这样"交接 / 压缩"在界面上只会出现一个，不会自相矛盾。
      //
      // AF.2 需求 1（2026-09-20 用户提出）：`handoff` 从**红**改**黄** ——
      // 交接是"优化建议"，不是"故障警报"；红色留给真正的规模异常（`LEVEL_META.critical`）
      // 与质量异常（`hasSignal` 的橙）。
      // AF.2 需求 2：新增 `prepare`（准备交接）—— 比 handoff 浅一档的黄，靠 ○ / ● 与字重再区分。
      // AG（2026-09-22 用户实测「7 轮就建议交接」）：再补一档 `costNote`（最轻）——
      // 它**不是建议**，只是"成本偏高"这个状态，所以用浅蓝、中点、最轻字重，
      // 让人一眼看出它和黄色系的两档建议不是一个量级。
      const ADVICE_COLOR = {
        continue: '#22c55e', // 绿：正常
        costNote: '#38bdf8', // 浅蓝（最轻）：成本偏高，但不构成建议
        prepare: '#facc15', // 浅黄：留意，不催促
        handoff: '#eab308', // 黄：明确建议交接（原为红 #ef4444）
        compact: '#eab308', // 历史遗留值
      };
      // 图形与字重也要跟着分档，否则浅蓝的"最轻"会和黄色的"建议"看起来同级。
      const ADVICE_GLYPH = { continue: '●', costNote: '·', prepare: '○', handoff: '●', compact: '●' };
      const ADVICE_WEIGHT = { continue: 500, costNote: 400, prepare: 500, handoff: 600, compact: 600 };
      const adviceColor = ADVICE_COLOR[health.compactAdvice] || meta.color;
      const adviceLabel = health.compactAdviceText || meta.label;

      // 退化信号的**命中原因**由 host 直接给出（N-5）：客户端不自己猜判据名，
      // 这样提示条与交接文档说的必然是同一件事。
      const reasonText = (list) =>
        (Array.isArray(list) ? list : [])
          .filter((r) => r && r.count > 0)
          .map((r) => (r.label || r.key) + (r.count > 1 ? ' ×' + r.count : ''))
          .join('、');
      const thinkCount = (health.reasoningLoop || 0) + (health.reasoningFlags || 0);
      // 「符号堆砌」精确率存疑（README 实测：思考侧 22/22 全部落在代码 / 正则里，
      // 修复后仍有非 ASCII 残留，自评"可接受的止损"），**已从判定里摘出**（2026-09-18）。
      // 这里单独统计，只在展开区作为"疑似"提示 —— 不能让一个可能误报的信号
      // 看起来像"模型真的异常了"（它会劝人换会话，代价与收益不对称）。
      const symbolCount = (Array.isArray(health.reasoningReasons) ? health.reasoningReasons : [])
        .filter((r) => r && r.key === 'symbolRun')
        .reduce((n, r) => n + (r.count || 0), 0);

      // ── 折叠行（2026-09-18 U 节 方案甲）────────────────────────────────────
      //
      // 修改前这里显示 `上下文健康 0/100` —— 而 U 节的概念审计指出：**那个合成分没有严格
      // 依据**（规模是测量、退化是真实样本，但"合成健康度"是从未被验证的经验组合；
      // 65 与 75 不代表"健康差 10%"）。
      //
      // 现在改成分层表达（用户拍板，并要求保住信号层）：
      //   · **有信号**（退化 / 守卫）：`⚠ 上下文过大 + 思考打转 10 次 · 建议交接`
      //     —— 档位是"状态"，信号是"要不要动手"，两者都在，不损失信息；
      //   · **无信号**：`上下文规模：偏大`（此时结论通常是"继续"，不必占位）；
      //   · 分数**降级到展开区**（标注"启发式"），留给想看同会话趋势的人。
      // 折叠行只列**最要紧的两条**信号（全部信号在展开区与 ⓘ 里）——
      // 守卫排最前：它是插件**已经动手掐断**的事实，比事后统计更硬（R 节）。
      const briefSignals = [];
      if ((health.guardTripCount || 0) > 0) briefSignals.push('已中止空转 ' + health.guardTripCount + ' 次');
      if ((health.reasoningLoop || 0) > 0) briefSignals.push('思考打转 ' + health.reasoningLoop + ' 次');
      if ((health.reasoningFlags || 0) > 0) briefSignals.push('思考异常长 ' + health.reasoningFlags + ' 次');
      if ((health.degradedReplies || 0) > 0) briefSignals.push('输出异常 ' + health.degradedReplies + ' 条');
      if ((health.repeatWorst || 0) >= 3) briefSignals.push('重复调用 ' + health.repeatWorst + ' 次');
      const brief = briefSignals.slice(0, 2).join(' + ');
      const hasSignal = briefSignals.length > 0;
      // ⚠️ **无信号也可能要显示建议**：成本通道判了交接（`level=ok`、无退化，但钱上划算）。
      // 这是 2026-09-15 修过的老问题 —— "行动建议只在折叠行出现一次"，
      // 若折叠行因为"没退化"而不显示它，用户就完全看不到该行动了。
      const showAdvice = hasSignal || health.compactAdvice !== 'continue';

      const head = React.createElement(
        'div',
        {
          onClick: () => setOpen((v) => !v),
          // 等级说明放悬停提示：它只解释"等级 = 规模"，不该占展开区一行、也不该和维度结论重复。
          title: meta.label + '：' + meta.hint + '（点击展开详情）',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '2px 8px',
            userSelect: 'none',
          },
        },
        React.createElement(
          'span',
          { style: { color: hasSignal ? '#f97316' : adviceColor, fontSize: '10px' } },
          // 行动建议的图形与字重分档（AF.2 + AG）：
          //   costNote：中点「·」最轻字重（只是状态，不是建议）
          //   prepare ：空心点「○」普通字重（留意，不催促）
          //   handoff ：实心点「●」加粗（明确建议）
          // 有质量信号时统一是橙色「⚠」（退化 / 守卫），与"建议"语义分开。
          hasSignal ? '⚠' : ADVICE_GLYPH[health.compactAdvice] || '●',
        ),
        React.createElement(
          'span',
          { style: { color: adviceColor, fontWeight: ADVICE_WEIGHT[health.compactAdvice] ?? 500 } },
          hasSignal
            ? '上下文' + sizeText + (brief ? ' + ' + brief : '') + ' · ' + adviceLabel
            : showAdvice
              ? // 无异常但有行动建议（成本通道驱动）→ **只报建议、不报规模档位**（W.6）
                adviceLabel
              : '上下文规模：' + sizeText,
        ),
        // 压缩史是**事实**、不是建议：保留它，用来解释"为什么压缩过了、提示条却还在"。
        // 2026-09-15 复核【遗留-2】：压缩后占用骤降会让旧版分数回满 100、判 ok、提示条消失，
        // 等于把"续命"记成"治愈"。现在评分有上限，这里把原因直接摆出来。
        (health.summaryCount || 0) > 0
          ? React.createElement(
              'span',
              { style: { opacity: 0.55 } },
              '· 有损压缩 ' + health.summaryCount + ' 次',
            )
          : null,
        React.createElement('span', { style: { opacity: 0.4, fontSize: '10px' } }, open ? '▲' : '▼'),
      );

      if (!open) return head;

      // ── 展开区：**最多 4 行**（2026-09-18 L 节精简）────────────────────────
      //
      // 用户截图反馈："展开区像内容固定、伪装成的一样" —— 无论会话什么状态，
      // 它永远铺满同样的 10+ 行：三张成本表（token 当量 / 元 / 总花费）+ 扣分明细
      // （−75 / −50 / 封顶 50）+ 一堆写给开发者的括号解释。
      //
      // 精简原则（审查清单 L.2）：
      //   · 折叠行回答"要不要动手"，展开区回答"为什么 + 现场在哪"；
      //   · **分析报告是交接文档的职责**，提示条不该复刻它；
      //   · 同一结论最多出现两次（折叠行 1 次 + 展开区 1 次）；
      //   · 括号里的**规则解释**删掉；口径标注保留（它不是解释，是坐标）。
      // 细节（评分扣分依据 / 启发式声明 / 完整成本表）全部收进 ⓘ 的悬停提示 ——
      // 想看的人一悬停就有，不想看的人不会被它挡住。
      const QUALITY_TEXT = { continue: '可继续', handoff: '建议交接', immediate: '立即新开会话' };
      const qualityText = QUALITY_TEXT[health.qualityAdvice] || '未知';
      const adviceText = health.compactAdviceText || qualityText;
      const degradedNow =
        (health.repeatWorst || 0) >= 3 || (health.degradedReplies || 0) > 0 || thinkCount > 0;
      // 有效窗口系数**由 host 下发**（界面不再自己写死 0.5/0.6）—— 它写进 ⓘ 的说明里。
      const ratioText =
        typeof health.effectiveWindowRatio === 'number' ? String(health.effectiveWindowRatio) : '0.6';

      /** 展开区一行：固定宽度的标签列 + 可换行的内容列。 */
      // 标签列 160px → 88px（L 节）：正文只剩 3~4 行时，长标签列会把内容挤到右边、
      // 留出一大片空白，反而更像"填满的报表"。
      const labelStyle = { flex: '0 0 88px', opacity: 0.6 };
      const valueStyle = { flex: '1 1 auto', minWidth: 0 };
      const line = (key, label, value) =>
        React.createElement(
          'div',
          { key, style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
          React.createElement('span', { style: labelStyle }, label),
          React.createElement('span', { style: valueStyle }, value),
        );

      // 退化信号分两份（L 节）：
      //   · `coreSignals` —— **参与判定**的那几条，进正文（它们解释了结论从哪来）；
      //   · `signals` —— 完整清单（含不参与判定的"疑似符号堆砌"与守卫中止），进 ⓘ。
      // 折叠行已经报过总数（"思考异常 10 次"），所以正文不重复铺"哪些不算数"。
      const signals = [];
      const coreSignals = [];
      if ((health.repeatWorst || 0) >= 3) {
        const t = '重复调用 ' + health.repeatWorst + ' 次';
        coreSignals.push(t);
        signals.push(t);
      }
      if ((health.degradedReplies || 0) > 0) {
        const why = reasonText(health.replyReasons);
        const t = '输出异常 ' + health.degradedReplies + ' 条' + (why ? '（' + why + '）' : '');
        coreSignals.push(t);
        signals.push(t);
      }
      // 2026-09-18 UI 整理：不再用「思考异常 N 次（原因：…）」这种聚合写法 ——
      // 它与括号里的原因计数互相重复（"思考异常 7 次（…思考打转 ×7）"），还造成三层括号嵌套。
      if ((health.reasoningLoop || 0) > 0) {
        const t = '思考打转 ' + health.reasoningLoop + ' 次';
        coreSignals.push(t);
        signals.push(t);
      }
      if ((health.reasoningFlags || 0) > 0) {
        const t = '思考异常长 ' + health.reasoningFlags + ' 次';
        coreSignals.push(t);
        signals.push(t);
      }
      // 「疑似符号堆砌」精确率存疑、不参与判定（README 实测 22/22 落在代码/正则里）：
      // 仍然显示（用户有权知道），但只在 ⓘ 里，且不再附"（不计入判定）"这种注解。
      if (symbolCount > 0) signals.push('疑似符号堆砌 ' + symbolCount + ' 次');
      // 实时守卫的止损记录同理（折叠行已有"已中止空转 N 次"）。
      if ((health.guardTripCount || 0) > 0) {
        signals.push('已中止空转 ' + health.guardTripCount + ' 次');
      }

      // ── 第 1 行：结论。这是它在界面上**第二次、也是最后一次**出现
      //    （第一次在折叠行；L.2 的上限就是"折叠行 + 展开区标题各一次"）──
      // ── 第 2 行：规模事实 + 具体退化信号，一行装下（完整口径与扣分细节在 ⓘ）──
      // 旧的「占用规模 / 质量 / 占用（声明窗口）」三行说的是同一批数字的三个侧面，
      // 合并成一行后，读者一眼能看完"现在多大、有多危险"。
      const factParts = [];
      if (hasScale) factParts.push(health.usedTokens.toLocaleString() + ' token');
      // S2（AF.1，2026-09-20 外部清单）：「有效占用 X%」的分母是插件自定的
      // **声明窗口 × 系数**，单看容易误读成"占了窗口 X%"。所以：
      //   · 把**声明窗口占比**排在前面（它是客观坐标）；
      //   · 有效占用后面跟上分母口径（口径标注不是"规则解释"，按 X 节原则应当保留）。
      if (typeof health.windowPercent === 'number') {
        factParts.push('声明窗口 ' + health.windowPercent.toFixed(1) + '%');
      }
      if (hasPercent) {
        const ratio =
          typeof health.effectiveWindowRatio === 'number' ? String(health.effectiveWindowRatio) : '0.6';
        factParts.push('有效占用 ' + pct + '（分母 = 声明窗口 × ' + ratio + '）');
      }
      // 「距官方线 / 约 N 轮」进 ⓘ（L 节）：它是**规模**信息，但决定当前行动的不是它，
      // 正文留给"多大 + 有没有退化"这两件真正驱动结论的事。
      const factText = factParts.concat(coreSignals).join(' · ') || MISSING;

      // U 节（方案甲）：合成分**降级到这里**（折叠行不再显示）——
      // 它对本插件的意义只有"同一会话的趋势"，所以标注清楚，并留给想看的人。
      const scoreText =
        typeof health.score === 'number' ? ' · 评分 ' + health.score + '/100（启发式，仅供同会话趋势）' : '';
      const detailLines = [
        line('advice', '建议', dataMissing && !health.compactAdviceText ? MISSING : adviceText),
        line('facts', '规模', factText + scoreText),
      ];

      // ── 第 3 行：判定依据（host 给的一句话，解释"为什么这么建议"）──
      // 它复述的是**决策逻辑**（退化信号 / 继续是否划算 / 官方线会怎么处理），
      // 而不是再报一遍占用率 —— 否则就是同一信息渲染两遍。
      if (health.compactAdviceNote) {
        detailLines.push(line('why', '依据', stripMd(health.compactAdviceNote)));
      }

      // ── 成本：正文最多一行，其余进 ⓘ（2026-09-18 L 节）────────────────────
      //
      // 旧版这里有**三张表**：token 当量（继续/压缩/交接）、元口径、到官方线前总花费。
      // 三个视角说的是同一个结论 —— 一起铺开正是"像填满的报表"的主因（L.1 根源 1）。
      // 现在：正文只留**元口径一句**（判定用的就是它，且只在结论为交接时出现），
      // 一次性成本、命中率、总花费全部进 ⓘ。
      //
      // token 当量表**整块删除**：它只能横向比、回答不了"该花谁的钱"，
      // 而插件自 2026-09-16 起已改用真实价格判定 —— 留着它只会让人以为还有第四个结论。
      const showCostDetail = health.compactAdvice === 'handoff';
      const yuan = (v) => '¥' + (v < 0.01 ? v.toFixed(4) : v.toFixed(3));
      let costSentence = '';
      const tipCostLines = [];

      // ── 真实花费（元）──────────────────────────────────────────────────────
      // 2026-09-16：成本判定已从"token 当量"换成**真实价格**（DeepSeek flash 空闲价：
      // 命中 0.02 / 未命中 1 / 输出 4，元每百万 token）。所以元口径是**判定依据本身**，
      // 正文留它、砍掉 token 当量表。
      if (typeof health.costContinuePerRound === 'number') {
        // X 节：ⓘ 里的"完整成本"同样只留继续 vs 交接（压缩是死信息，不驱动行动）。
        const parts = ['继续 ' + yuan(health.costContinuePerRound) + '/轮'];
        if (typeof health.costFreshPerRound === 'number') {
          parts.push('机械交接 ' + yuan(health.costFreshPerRound) + '/轮（第 2 轮起）');
        }
        const kn =
          health.costHitRateKnown === false
            ? '无实测命中率，金额按假设值估算（不作为决策依据）'
            : '命中率 ' + ((health.cacheHitRate ?? 0) * 100).toFixed(1) + '%';
        tipCostLines.push(parts.join(' / '), kn);

        if (showCostDetail && health.costPriceKnown === false) {
          // T 节（2026-09-18）：模型不在价表里 → 成本比较**已跳过**。
          // 如实说清楚，而不是给一个用错价算出来的金额（那正是 T 节要防的"静默算错"）。
          costSentence = String(health.costPriceLabel || '模型不在价表里 —— 成本比较已跳过');
        } else if (showCostDetail) {
          // 判定是「交接回本轮数 + 1 轮余量 < 预计剩余轮数」（2026-09-18）——
          // 正文必须让用户看到这两个数，否则结论无法自行核对；
          // 实测增速 P25~P75 差 2.4 倍，一个布尔值不足以支撑这个决定。
          // X 节（2026-09-18 用户拍板）：成本行**只留「继续 vs 交接」**——
          // 压缩已退出行动域，把它列在这里不驱动任何行动（原则：读者能否据此行动？不能就删）。
          // S9（AT 节 2026-09-24，用户凌晨实测：同一会话两次看到**整整 2 倍**的价差）：
          // 金额必须带**价格档位**。官方高峰价就是空闲价的 2 倍，不标档位时
          // 用户会以为数据坏了 —— 这不是"解释设计决策"，而是**这个数字的前提**。
          // 档位是**状态**（X 节原则允许进界面）；完整口径（价目表日期 / 法定节假日）
          // 仍由 tooltip 的「价格口径：」那一行承担，这里只放最短的标签、不重复。
          // ⚠️ 旧 host 可能没有 `costPriceTier` —— 此时**不加标签**，
          //    而不是默认成"空闲价"（那会在高峰时段说假话）。
          const tierTag =
            health.costPriceTier === 'peak' ? '高峰价' : health.costPriceTier === 'offPeak' ? '空闲价' : '';
          const bits = [
            '继续 ' + yuan(health.costContinuePerRound) + '/轮' + (tierTag ? '（' + tierTag + '）' : ''),
          ];
          if (typeof health.costFreshPerRound === 'number') {
            bits.push('交接 ' + yuan(health.costFreshPerRound) + '（无损）');
          }
          if (typeof health.costFreshBreakEvenRounds === 'number') {
            const mg = health.costFreshWinMarginRounds;
            const be = health.costFreshBreakEvenRounds;
            // AD 节（2026-09-20）：`0.0457` 被 `toFixed(1)` 显示成「交接回本 0.0 轮」——
            // 数值没错，但"回本 0.0 轮"读起来像数据坏了（用户截图发起复核的就是这个）。
            // 分档：≤0 → 首轮即摊平；<0.1 → 首轮内（不带"轮"字，避免"首轮内 轮"）；其余一位小数。
            const beText = be <= 0 ? '首轮即摊平' : be < 0.1 ? '首轮内' : be.toFixed(1) + ' 轮';
            bits.push(
              '交接回本 ' +
                beText +
                (typeof mg === 'number' && mg >= 0 ? '（余量 ' + mg.toFixed(1) + ' 轮）' : ''),
            );
          }
          costSentence = bits.join(' · ');
          // S-3（2026-09-18）：把**具体金额**摆出来，让用户自己判断值不值 ——
          // 只给"建议交接"这个结论时，用户无法区分"省 2 分"与"省 2 毛"（实测差 10 倍）。
          if (typeof health.costSavingYuan === 'number' && health.costSavingYuan > 0) {
            // S1（AF.1，2026-09-20 外部清单）：这个数是**按当前增速外推**到官方线算出来的，
            // 增速一变金额就变 —— 原来只报一个数，读者会当成确定值。
            // **判定阈值不动**（回本判据本身是稳的），只在展示上带前提。
            // ⚠️ 措辞**不写 P25/P75**：那是 X 节（用户拍板）明令不进界面的"死信息"
            //（`ui-build-test` 的 BANNED_IN_UI 会当场拦下 —— 第一版就撞上了）。
            // 数字留在交接文档 / NOTES 里，界面只说"这是外推值"。
            costSentence +=
              ' · 到官方线前可省 ¥' +
              health.costSavingYuan.toFixed(3) +
              '（按当前增速外推，实际随增速浮动）' +
              (health.costSavingEnough === false ? '（差额偏小，不足以作为换会话的理由）' : '');
          }
        }

        // 到官方线为止的三方案总花费 —— 进 ⓘ（正文不铺表）。
        //
        // ⚠️ 2026-09-16 审查 P1：界面**不许**在这里自称"最省"。
        // 宿主判定带轮数余量、并且经优先级链（退化 / 官方线会覆盖成本裁决）；
        // 界面若按"绝对最小"重算，就会出现"账面最小是新开、结论却是继续"的同屏打脸
        // （实测 760k：总额 继续 0.799 / 压缩 0.821 / 新开 0.700，宿主 = official 分支）。
        // 所以只并列三个数并指向最终建议，不下判断。
        if (
          typeof health.costTotalContinue === 'number' &&
          typeof health.costTotalCompact === 'number' &&
          typeof health.costTotalFresh === 'number'
        ) {
          // X 节（2026-09-18）：只留「继续 vs 新开」——压缩是死信息（不驱动行动），
          // 连"谁更省以最终建议为准"这类判定权说明也一并去掉（那是对设计的解释）。
          tipCostLines.push(
            '到官方线前总花费（窗口 ' +
              (health.costHorizonRounds ?? 0) +
              ' 轮）：继续 ' +
              yuan(health.costTotalContinue) +
              ' / 新开 ' +
              yuan(health.costTotalFresh),
          );
        }
      }

      // 正文的成本行：只在结论是交接时出现 —— 它是那个结论的依据（L.2：其余数字进 ⓘ）。
      // 单位写进标签，「元/轮」不必挤在数字尾巴上。
      if (costSentence) detailLines.push(line('cost', '成本（元/轮）', costSentence));

      // ── ⓘ 的悬停内容：评分依据 + 退化细节 + 完整成本 + 启发式声明 ──────────
      //
      // L 节的核心处置：**分析报告是交接文档的职责**，提示条只留"结论 + 为什么 + 现场"。
      // 扣分明细（−75 / −50 / 封顶 50）与规则说明并没有被删掉，只是从"永远铺开"
      // 变成"想看才看" —— 悬停即得，不想看的人不会被它挡住。
      const detailTipParts = [];
      if (health.findings && health.findings.length) {
        detailTipParts.push('评分依据：\n' + health.findings.map((f) => '· ' + f).join('\n'));
      }
      if (degradedNow) {
        detailTipParts.push(
          '退化信号：' +
            (signals.length ? signals.join(' / ') : '已检出') +
            ((health.guardTripCount || 0) > 0 && health.lastGuardReason
              ? '\n最近一次守卫中止原因：' + health.lastGuardReason
              : ''),
        );
      }
      // X 节（2026-09-18 用户拍板）：删掉「精确率存疑 / 不参与判定 / 实测 22/22」这类注解 ——
      // 那是**解释设计**，读者不能据此行动（判定细节属于 DEPLOYMENT-NOTES / README）。
      if (typeof health.headroomToOfficial === 'number') {
        detailTipParts.push(
          '距官方自动压缩线 ' +
            health.headroomToOfficial.toLocaleString() +
            ' token' +
            (typeof health.headroomRounds === 'number' ? '（约 ' + health.headroomRounds + ' 轮）' : '') +
            '。',
        );
      }
      // 轮数旁边给出**分母**：轮数是"余量 ÷ 每轮增长"算出来的，用户能自己核对。
      // （2026-09-16 之前投影按**每条消息**算增长，同样的余量报成 259 轮 —— 真实约 6 轮。）
      if (
        typeof health.headroomRounds === 'number' &&
        typeof health.avgRoundGrowth === 'number' &&
        health.avgRoundGrowth > 0
      ) {
        detailTipParts.push(
          '「约 ' +
            health.headroomRounds +
            ' 轮」怎么来的：距官方线余量 ÷ 每轮增长（按每轮 +' +
            health.avgRoundGrowth.toLocaleString() +
            ' token 估算）。',
        );
      }
      if (tipCostLines.length) {
        detailTipParts.push('完整成本：\n' + tipCostLines.map((l) => '· ' + l).join('\n'));
      }
      // T-9 / T-10（2026-09-18）：价格的**来源 / 日期 / 档位**必须可见 ——
      // 否则官方调价或换模型之后，账目已经算错而界面看起来一样自信。
      if (health.costPriceLabel) {
        detailTipParts.push('价格口径：' + health.costPriceLabel);
      }

      // ── 异常现场明细（2026-09-18 H.8）────────────────────────────────────
      // 用户诉求："点击异常提醒，能看看出问题的地方长什么样"。
      // 真跳转（滚动到聊天流对应消息并高亮）DSH **没有**公开 API，硬做只能 play DOM、
      // 官方一升级就碎；就地展开原文则完全在插件内 —— host 已把「轮次 + 摘录」
      // 放进 `degradedSamples`（见 lib/index.js 的 H.8 段）。
      //
      // 默认收起（只给 60 字预览）：这是"想看才看"的东西，不该把展开区撑长。
      const SAMPLE_KIND_TEXT = { reasoning: '思考异常', reply: '输出异常', guard: '已中止空转' };
      const samples = Array.isArray(health.degradedSamples) ? health.degradedSamples : [];
      const samplesBlock = samples.length
        ? React.createElement(
            'div',
            { key: 'samples', style: { marginTop: '4px', fontSize: '11px', paddingLeft: '96px' } },
            React.createElement(
              'div',
              { style: { opacity: 0.6 } },
              '异常现场（最近 ' + samples.length + ' 条，点标题看原文）：',
            ),
            samples.map((s, i) => {
              const isOpen = openSample === i;
              // turn = 0 是 host 的"轮次未知"约定（不拿别的数字顶上），这里如实显示。
              const where = s && s.turn > 0 ? '第 ' + s.turn + ' 轮' : '轮次未知';
              const kindText = SAMPLE_KIND_TEXT[s && s.kind] || String((s && s.kind) || '异常');
              const text = typeof (s && s.excerpt) === 'string' ? s.excerpt : '';
              return React.createElement(
                'div',
                { key: 'sample-' + i, style: { marginTop: '1px' } },
                React.createElement(
                  'span',
                  {
                    onClick: () => setOpenSample(isOpen ? -1 : i),
                    title: isOpen ? '点击收起' : '点击展开（最多 200 字）',
                    style: { cursor: 'pointer', opacity: 0.9 },
                  },
                  (isOpen ? '▾ ' : '▸ ') +
                    where +
                    ' · ' +
                    kindText +
                    (isOpen || !text
                      ? ''
                      : '：' + text.slice(0, 60) + (text.length > 60 ? '…' : '')),
                ),
                isOpen
                  ? React.createElement(
                      'div',
                      {
                        style: {
                          margin: '2px 0 2px 12px',
                          opacity: 0.85,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        },
                      },
                      // 原文没落盘时如实说清楚 —— 而不是留一个空框让人以为是渲染坏了
                      text || '（原文未留存：该次退化只留下计数与判定描述）',
                      text
                        ? React.createElement(
                            'button',
                            {
                              type: 'button',
                              onClick: () => {
                                // 复用与交接复制同一套剪贴板两级回退（异步 API → execCommand）
                                copyToClipboard(text)
                                  .then(() => setNotice('已复制该片段'))
                                  .catch((err) => setError(String((err && err.message) || err)));
                              },
                              style: {
                                marginLeft: '6px',
                                fontSize: '11px',
                                lineHeight: '18px',
                                padding: '0 6px',
                                cursor: 'pointer',
                              },
                            },
                            '复制片段',
                          )
                        : null,
                    )
                  : null,
              );
            }),
          )
        : null;

      // N-6：把"这套数字是什么性质"说清楚，避免评分被当成测量结论 ——
      // 但 L 节把它从正文（1 行）降级进 ⓘ：它是**免责说明**，不该常驻占版面。
      // 系数从 host 下发（`effectiveWindowRatio`，见展开区开头），界面不写死 0.5/0.6。
      //
      // 2026-09-18 U 节（概念审计）补了两条**明确"不要这样读"**：
      //   · 它不是"健康度百分比"—— 65 分与 75 分不代表健康差 10%；
      //   · 不能跨会话比分数 —— 各会话的规模 / 压缩史 / 退化计数都不同。
      // 这两条是 U.4 列的"不要信"，此前界面没写，容易被读成精确测量。
      detailTipParts.push(
        '评分为启发式指标（阈值由内部校准，未做回溯验证）：只能看「同一会话的趋势」。' +
          '它不是"健康度百分比"（65 分与 75 分不代表健康差 10%），也不能跨会话比分数' +
          '（各会话的规模、压缩史、退化计数都不同）。' +
          '有效窗口 = 声明窗口 × ' +
          ratioText +
          '。',
      );
      const detailTip = detailTipParts.join('\n\n');

      const actionRow = React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px solid rgba(128,128,128,0.25)',
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => onCopy('slim'),
            disabled: busy,
            title: '机械提炼交接内容（精简档：结论 + 待办 + 文件 + 最近 1 轮原文），不调用模型',
            style: {
              fontSize: '12px',
              lineHeight: '20px',
              padding: '1px 10px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          },
          busy ? '生成中…' : '复制交接内容',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => onCopy('full'),
            disabled: busy,
            title: '完整档：含完整元说明与附录 B 全量原文（篇幅约多三成）',
            style: {
              fontSize: '12px',
              lineHeight: '20px',
              padding: '1px 10px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          },
          '复制完整版',
        ),
        React.createElement(
          'span',
          { style: { fontSize: '11px', opacity: 0.55 } },
          '本地提炼 · 零 token · 复制后粘贴到新会话',
        ),
        // L 节：评分扣分依据、完整成本账、启发式声明全部收在这里 ——
        // 悬停即得，不占正文。正文只剩"建议 / 规模 / 依据 / 成本"最多 4 行。
        React.createElement(
          'span',
          {
            title: detailTip,
            style: {
              fontSize: '11px',
              opacity: 0.6,
              cursor: 'help',
              textDecoration: 'underline dotted',
            },
          },
          'ⓘ 评分与成本详情',
        ),
        notice
          ? React.createElement('span', { style: { fontSize: '11px', color: '#22c55e' } }, notice)
          : null,
        error
          ? React.createElement('span', { style: { fontSize: '11px', color: '#ef4444' } }, '失败：' + error)
          : null,
      );

      const detail = React.createElement(
        'div',
        {
          style: {
            fontSize: '12px',
            lineHeight: '19px',
            padding: '2px 8px 8px 22px',
            opacity: 0.9,
          },
        },
        detailLines,
        samplesBlock,
        actionRow,
      );

      return React.createElement('div', null, head, detail);
    }

    /** 只依赖 slot 服务。 */
    const inject = ['slots'];

    /** 提示条挂载的槽位名（DSH 客户端契约；改名则提示条不出现）。 */
    const SLOT_NAME = 'conversation.composer.dock';

    /**
     * 客户端插件体：把提示条注册进 composer 下方的 list 槽。
     *
     * 用独立的 `id`（`attention-health`），因此与既有的
     * `ui-chat` StatsPills（`id: 'stats'`）并存而互不覆盖。
     *
     * ── 兼容性防护（2026-09-16 用户要求「DSH 更新后不要崩」）──
     * 客户端插件一旦在 apply 里抛异常，整个提示条（乃至同批客户端插件）都可能加载失败。
     * 所以这里把"槽位名或 slots API 变了"降级成一条**控制台日志**：
     * 提示条不出现，但页面其余部分照常。排查时打开浏览器控制台搜 `attention-health-ui` 即可。
     */
    function apply(ctx) {
      try {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          console.error('[attention-health-ui] ctx.slots 契约不可用 —— 提示条不会出现（DSH 版本可能已变）');
          return;
        }
        ctx.slots.inject(SLOT_NAME, () => {
          try {
            ctx.slots.register(
              {
                name: SLOT_NAME,
                id: 'attention-health',
                order: 15,
              },
              AttentionHealthBar,
            );
            console.error(`[attention-health-ui] 提示条已注册到 ${SLOT_NAME}`);
          } catch (error) {
            console.error(
              `[attention-health-ui] 注册到 ${SLOT_NAME} 失败（槽位契约可能已变化）：`,
              error?.message ?? error,
            );
          }
        });
      } catch (error) {
        console.error('[attention-health-ui] apply 失败（已隔离，不影响页面其余部分）：', error?.message ?? error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
