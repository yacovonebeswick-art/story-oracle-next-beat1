// ============================================================================
// 故事神谕 · 下一拍建议（独立插件，不改 story-oracle 任何代码）
// v3.5.0
//
// v3.5.0 新增：连接设置
//   · 默认【继承故事神谕的连接设置】，只覆盖「模型名」（可以填一个便宜/快速的
//     模型，专门给建议用，不占神谕的 pro 模型）。
//   · 也可以取消勾选「继承」，改成【独立连接】：自己填 端点/密钥/连接模式/
//     配置文件/后端转发/地址原样 等全套。
//   · 走神谕内部传输层（unsafe.eval 拿 callDirect/callProfile/streamDirect），
//     复用它的 URL 规范化、后端转发、附加参数、错误展开；
//     拿不到内部函数时安全降级到「用神谕的 api.run」（= 现状）。
//
// 其它设计（沿用 v3.4.0）：
//   · 楼层 chip = 候选结果的唯一展示位。
//   · 中心面板 / 悬浮球卡片只用来"触发生成"；点完自动收起；不重复显示候选。
//   · 悬浮球（🧭 圆标）常驻；生成完圆标呼吸提示。
//   · 圆标显示 / 隐藏只由两处控制：面板「常驻」勾选、魔杖菜单入口。
//   · × 只收起悬浮球卡片；圆标永远在。
//   · 生成默认手动；自动开关默认关。
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const VERSION = '3.5.0';
  const CFG_VERSION = 7;

  const DEFAULTS = {
    enabled: false,
    showChip: true,
    showToast: false,
    showFloat: false,
    // 连接设置
    connInherit: true,        // 默认继承神谕的连接
    connModelOverride: '',    // 继承模式下：覆盖的模型名（空 = 用神谕的模型）
    // 独立连接（connInherit = false 时生效）
    connMode: 'direct',       // 'direct' | 'profile'
    connEndpoint: '',
    connApiKey: '',
    connModel: '',
    connProfileId: '',
    connDirectViaBackend: false,
    connDirectRawUrl: false,
  };

  const MIN_OUTPUT_TOKENS = 4096;
  const REQUEST_TIMEOUT_MS = 240000;
  const MIN_NARRATIVE_LEN = 10;

  const DONE_META_KEY = MODULE_ID + '_done';
  const DONE_KEEP_MAX = 400;

  const LBL_USER = '我';
  const LBL_TIME = '时间';

  let lastByChat = {};
  let panelEl = null;
  let floatEl = null;
  let floatCollapsed = true;
  let floatFresh = false;
  let currentAbort = null;
  let lastRequestKey = null;

  // -------------------------------------------------------------------------
  // 基础
  // -------------------------------------------------------------------------

  function getCtx() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
      ? SillyTavern.getContext()
      : null;
  }

  function chatKey() {
    const ctx = getCtx();
    if (!ctx) return '::';
    return String(ctx.groupId || '') + '::' + String(ctx.chatId || '');
  }

  function migrateSettings(s) {
    if (s._v === CFG_VERSION) return;
    s.enabled = false;
    if (!s.showFloat) s.showFloat = true;
    s._v = CFG_VERSION;
    saveSettings();
    console.log('[next-beat] 已迁移设置到 v' + CFG_VERSION);
  }

  function loadSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    ctx.extensionSettings[MODULE_ID] = Object.assign(
      {},
      DEFAULTS,
      ctx.extensionSettings[MODULE_ID] || {},
    );
    const s = ctx.extensionSettings[MODULE_ID];
    migrateSettings(s);
    return s;
  }

  function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    }
  }

  // -------------------------------------------------------------------------
  // 持久去重
  // -------------------------------------------------------------------------

  function readDoneSet() {
    const ctx = getCtx();
    const md = ctx && ctx.chatMetadata;
    if (!md) return new Set();
    const arr = Array.isArray(md[DONE_META_KEY]) ? md[DONE_META_KEY] : [];
    return new Set(arr);
  }

  function markDone(key) {
    const ctx = getCtx();
    const md = ctx && ctx.chatMetadata;
    if (!md) return;
    const arr = Array.isArray(md[DONE_META_KEY]) ? md[DONE_META_KEY].slice() : [];
    if (!arr.includes(key)) arr.push(key);
    while (arr.length > DONE_KEEP_MAX) arr.shift();
    md[DONE_META_KEY] = arr;
    try {
      const save = ctx.saveMetadataDebounced || ctx.saveMetadata;
      if (typeof save === 'function') save.call(ctx);
    } catch (e) { /* ignore */ }
  }

  function isDone(key) { return readDoneSet().has(key); }

  // -------------------------------------------------------------------------
  // unsafe.eval
  // -------------------------------------------------------------------------

  function apiSafeEval(expr, fallback) {
    const api = window.StoryOracleAPI;
    if (!api || !api.unsafe || typeof api.unsafe.eval !== 'function') return fallback;
    try {
      const v = api.unsafe.eval(expr);
      return (v === undefined) ? fallback : v;
    } catch (e) {
      console.warn('[next-beat] unsafe.eval 失败：', e);
      return fallback;
    }
  }

  function cleanNarrative(raw) {
    const text = String(raw == null ? '' : raw);
    if (!text) return '';
    const cleaned = apiSafeEval(
      '(function(t){' +
      '  var a = (typeof stripMechanismBlocks === "function") ? stripMechanismBlocks(t) : t;' +
      '  var b = (typeof stripReasoningTags === "function") ? stripReasoningTags(a) : a;' +
      '  return b;' +
      '})(' + JSON.stringify(text) + ')',
      text,
    );
    return String(cleaned == null ? text : cleaned);
  }

  function getActiveBeatInfo() {
    const seq = apiSafeEval('(typeof getSeq === "function" ? getSeq() : null)', null);
    if (!seq || !Array.isArray(seq.beats) || !seq.beats.length) return null;
    const active = apiSafeEval('(typeof seqActiveBeat === "function" ? seqActiveBeat(getSeq()) : null)', null);
    const beat = active || seq.beats[seq.cursor] || null;
    if (!beat) return null;
    return {
      seqTitle: String(seq.title || ''),
      progress: `${(seq.cursor | 0) + 1} / ${seq.beats.length}`,
      cursor: seq.cursor | 0,
      total: seq.beats.length,
      beatTitle: String(beat.title || ''),
      goal: String(beat.goal || ''),
      seed: String(beat.seed || ''),
      why: String(beat.why || ''),
    };
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  const SYSTEM_PROMPT =
    '你是一个为角色扮演游戏生成「玩家下一步可发送指令」候选的助手。' +
    '用户会给你：当前剧情的最后一段正文，以及（如果有）当前正在引导的剧情序列中的某一拍目标。' +
    '你需要生成 3~6 条候选，每条都能作为「玩家」接下来直接发送给 AI 的指令。' +
    '\n' +
    '输出格式（严格遵守）：每条一行，行首固定为「**标签** 」加一个空格，然后接具体内容。' +
    '标签只允许以下三类：' +
    '  1) **我**      —— 玩家自己（第一人称「我」）的动作/台词；' +
    '  2) **角色X**   —— 最近正文里【在场的其他角色】的动作/台词，' +
    'X 用正文里对这个人物的称呼替换（例如「胡一菲」）；' +
    '若模型无法确定具体是谁，则保留 **角色A** / **角色B** / **角色C**；' +
    '不要凭空发明正文里没出现过的人物。' +
    '  3) **时间**    —— 时间推进 / 换场；只有在满足下述条件时才使用。' +
    '\n' +
    '内容要求：' +
    '  · 每条 1~2 句，具体到可以立刻发送（带动作/台词/场景细节之一）；' +
    '  · 【紧跟上文】：不要凭空跳跃时间或地点；上一句若是对话/问句，' +
    '    大部分候选应当是【立即】的回应或行动，而不是「几小时后……」。' +
    '  · 前 3 条必须是 **我**（三个不同角度的合理应对：直接回应 / 另一角度 / 更主动的做法）。' +
    '  · 第 4~5 条：使用 **角色X**。' +
    '    ⚠ 硬约束：第 4 条与第 5 条【必须是不同的角色】——不允许同一角色换角度写两条。' +
    '    如果最近正文里【只有一个】其他角色在场：只给第 4 条，不给第 5 条。' +
    '    如果最近正文里【没有】其他角色在场：不给第 4~5 条，只给前 3 条。' +
    '  · 只有当【本拍目标】明确暗示需要换场/换时间（例如目标里含「次日」「翌日」' +
    '    「数日后」「转场」「到了……」等）时，才在最后追加一条 **时间** 选项；' +
    '    否则不给 **时间** 选项。' +
    '  · 行内不要出现 MBTI 分析、不要出现「（动作）」这类标注、不要引号外的解释。' +
    '  · 不要使用 Markdown 列表符号（- / *），只用上面规定的「**标签** 内容」格式。' +
    '\n' +
    '示例（仅示范格式；实际人物/场景由你根据正文判断）：' +
    '**我** 我站起身，走到门口把帘子拉下。\n' +
    '**我** 我把杯子里的水一口喝掉，沉默了两秒。\n' +
    '**我** 我回头看了一眼，低声说：「我们换个地方谈。」\n' +
    '**角色A** 他靠在墙边，抱着胳膊没说话。\n' +
    '**角色B** 她放下手里的笔，抬头看向我。\n' +
    '**时间** 半小时后，天色完全暗了下来。\n' +
    '（⚠ 错误示范，禁止照抄：两条都写成 **角色A** 只是角度不同——那样是同一个角色，不允许。）';

  function buildUserPrompt(narrativeText, beatInfo) {
    const parts = [];
    if (beatInfo && beatInfo.goal) {
      parts.push('【当前引导序列】' + (beatInfo.seqTitle || '(未命名)') +
        '（第 ' + beatInfo.progress + ' 拍）');
      if (beatInfo.beatTitle) parts.push('本拍标题：' + beatInfo.beatTitle);
      parts.push('本拍目标（这拍要让故事走向的结果）：' + beatInfo.goal);
      if (beatInfo.seed) parts.push('本拍起始迹象：' + beatInfo.seed);
      if (beatInfo.why) parts.push('为什么这样安排：' + beatInfo.why);
      parts.push('');
    }
    parts.push('【刚写完的正文（仅供参考，不要复述）】');
    parts.push('"""');
    parts.push(narrativeText.slice(-4000));
    parts.push('"""');
    parts.push('');
    if (beatInfo && beatInfo.goal) {
      parts.push('请按系统提示规定的格式，生成 3~6 条候选。' +
        '所有候选的最终目标，都要能自然把剧情推向上面那个【本拍目标】；' +
        '其中至少一条应当是【紧接着上一句正文】的即时回应/行动，' +
        '不要一上来就跨时间。' +
        '再次提醒：第 4 条与第 5 条必须是不同的角色，不能同一角色写两条。');
    } else {
      parts.push('请按系统提示规定的格式，生成 3~6 条候选。' +
        '所有候选都要能顺着刚才这段正文自然展开下一步；' +
        '其中至少一条应当是【紧接着上一句正文】的即时回应/行动。' +
        '再次提醒：第 4 条与第 5 条必须是不同的角色，不能同一角色写两条。');
    }
    return parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // 解析
  // -------------------------------------------------------------------------

  function parseOptions(text) {
    const src = String(text || '');
    const out = [];
    const re = /^\s*\*\*([^*\n]+?)\*\*\s+(.+?)\s*$/;
    for (const line of src.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(re);
      if (!m) continue;
      const label = m[1].trim();
      const content = m[2].trim();
      if (!label || !content) continue;
      out.push({ label, content, raw: line.trim() });
    }
    const seen = new Set();
    const dedup = [];
    for (const o of out) {
      const k = o.label + '\u0001' + o.content;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(o);
    }
    return dedup.length ? dedup : null;
  }

  // -------------------------------------------------------------------------
  // 请求发送：三路分发
  //   ① 继承 + 未覆盖模型 → api.run（现状：完全用神谕的模型与连接）
  //   ② 继承 + 覆盖模型   → 借用神谕内部传输层，只覆盖 model
  //   ③ 不继承（独立）   → 自己直连 / 走 profile
  // -------------------------------------------------------------------------

  async function requestNextBeatOptions(narrativeText, beatInfo) {
    const api = window.StoryOracleAPI;
    if (!api) {
      console.warn('[next-beat] 未检测到 StoryOracleAPI，跳过');
      return null;
    }

    const s = loadSettings();

    // 并发控制
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ctl = new AbortController();
    currentAbort = ctl;
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, REQUEST_TIMEOUT_MS);

    // 输出预算
    let userMax = 0;
    try {
      if (typeof api.getSettings === 'function') {
        const os = api.getSettings();
        if (os && Number.isFinite(Number(os.maxTokens))) userMax = Number(os.maxTokens);
      }
    } catch (e) { /* ignore */ }
    const maxTokens = Math.max(userMax, MIN_OUTPUT_TOKENS);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(narrativeText, beatInfo) },
    ];

    try {
      let text = '';

      if (s.connInherit) {
        const override = String(s.connModelOverride || '').trim();
        if (!override) {
          // ① 完全跟随神谕
          if (typeof api.run !== 'function') {
            console.warn('[next-beat] api.run 不可用，跳过');
            return null;
          }
          const result = await api.run(messages, { stream: false, maxTokens, signal: ctl.signal });
          text = pickText(result);
        } else {
          // ② 继承连接，只覆盖 model
          text = await sendWithModelOverride(api, messages, maxTokens, override, ctl.signal);
        }
      } else {
        // ③ 完全独立连接
        text = await sendWithOwnConnection(api, messages, maxTokens, s, ctl.signal);
      }

      text = String(text || '').trim();
      return parseOptions(text);
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      console.error('[next-beat] 调用失败：', err);
      return null;
    } finally {
      clearTimeout(timer);
      if (currentAbort === ctl) currentAbort = null;
    }
  }

  function pickText(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
      return result.text || result.content || result.reply || '';
    }
    return '';
  }

  // 路径 ② —— 借用神谕内部传输层，覆盖模型名
  async function sendWithModelOverride(api, messages, maxTokens, modelOverride, signal) {
    // 先试着拿神谕内部的传输函数
    const callDirect = apiSafeEval('(typeof callDirect === "function" ? callDirect : null)', null);
    const callProfile = apiSafeEval('(typeof callProfile === "function" ? callProfile : null)', null);
    const resolveEndpointUrl = apiSafeEval('(typeof resolveEndpointUrl === "function" ? resolveEndpointUrl : null)', null);
    const getSettings = apiSafeEval('(typeof getSettings === "function" ? getSettings : null)', null);

    const os = (typeof getSettings === 'function') ? getSettings() : null;
    if (!os) {
      // 拿不到神谕设置（极旧版本），退回 api.run
      console.warn('[next-beat] 拿不到神谕设置，退回 api.run（用神谕模型）');
      const result = await api.run(messages, { stream: false, maxTokens, signal });
      return pickText(result);
    }

    const stream = false;   // 建议生成很短，不需要流式

    if (os.mode === 'direct' && typeof callDirect === 'function' && typeof resolveEndpointUrl === 'function') {
      const url = resolveEndpointUrl(os);
      const body = { model: modelOverride, messages, max_tokens: maxTokens };
      if (os.sendTemperature) body.temperature = os.temperature;
      return await callDirect(url, os.apiKey, body, signal);
    }

    if (os.mode === 'profile' && typeof callProfile === 'function') {
      // profile 模式的模型来自 profile 本身，无法覆盖 —— 用神谕自己的 profile 走一次，
      // model override 只能通过 overridePayload 透传（ST 后端不读 model，但无害）。
      const override = os.sendTemperature ? { temperature: os.temperature } : {};
      return await callProfile(os.profileId, messages, maxTokens, override, signal);
    }

    // 兜底：走 api.run（用神谕模型）
    console.warn('[next-beat] 无法覆盖模型（模式不支持），退回 api.run');
    const result = await api.run(messages, { stream: false, maxTokens, signal });
    return pickText(result);
  }

  // 路径 ③ —— 完全独立连接
  async function sendWithOwnConnection(api, messages, maxTokens, s, signal) {
    if (s.connMode === 'direct') {
      if (!s.connEndpoint || !s.connModel) {
        throw new Error('独立连接未配置：请到设置里填端点 URL 与模型');
      }
      const url = normalizeUrl(s.connEndpoint, s.connDirectRawUrl);
      const body = { model: s.connModel, messages, max_tokens: maxTokens };
      const headers = { 'Content-Type': 'application/json' };
      if (s.connApiKey) headers['Authorization'] = 'Bearer ' + s.connApiKey;

      if (s.connDirectViaBackend) {
        return await sendViaSTBackend(url, headers, body, signal);
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: false }),
        signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? '';
    }

    // profile 模式
    if (!s.connProfileId) {
      throw new Error('独立连接未配置：请到设置里选一个连接配置文件');
    }
    const ctx = getCtx();
    if (!ctx || !ctx.ConnectionManagerRequestService || typeof ctx.ConnectionManagerRequestService.sendRequest !== 'function') {
      throw new Error('此 ST 版本缺少 ConnectionManagerRequestService');
    }
    const override = {};
    const result = await ctx.ConnectionManagerRequestService.sendRequest(
      s.connProfileId,
      messages,
      maxTokens,
      { stream: false, extractData: true, signal },
      override,
    );
    return result?.content ?? '';
  }

  // 独立连接的「经酒馆后端转发」（直连 CORS 问题时用）
  async function sendViaSTBackend(url, headers, body, signal) {
    const ctx = getCtx();
    if (!ctx || !ctx.ChatCompletionService || typeof ctx.ChatCompletionService.processRequest !== 'function') {
      throw new Error('此 ST 版本缺少 ChatCompletionService，无法经后端转发');
    }
    const customUrl = String(url || '').replace(/\/chat\/completions\/?$/, '');
    const { model, messages, max_tokens, stream: _drop, ...rest } = body || {};
    const payload = {
      chat_completion_source: 'custom',
      custom_url: customUrl,
      custom_include_headers: JSON.stringify(headers || {}),
      model, messages, max_tokens,
      stream: false,
      ...rest,
    };
    const result = await ctx.ChatCompletionService.processRequest(payload, { presetName: undefined }, true, signal);
    return result?.content ?? '';
  }

  // URL 规范化（与神谕同款逻辑）
  function normalizeUrl(u, raw) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';
    if (raw) return u + '/chat/completions';
    return u + '/v1/chat/completions';
  }

  // -------------------------------------------------------------------------
  // 输入框
  // -------------------------------------------------------------------------

  function fillInput(text) {
    const el = document.getElementById('send_textarea');
    if (!el) return false;
    el.value = String(text == null ? '' : text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.focus(); } catch (e) { /* ignore */ }
    return true;
  }

  // -------------------------------------------------------------------------
  // 候选列表渲染（只用于楼层 chip 和 toast）
  // -------------------------------------------------------------------------

  function labelClass(label) {
    if (label === LBL_USER) return 'so-nb-lbl-user';
    if (label === LBL_TIME) return 'so-nb-lbl-time';
    return 'so-nb-lbl-role';
  }

  function buildOptionsList(options, opts) {
    const list = document.createElement('div');
    list.className = 'so-nb-options';
    if (!Array.isArray(options) || !options.length) {
      const empty = document.createElement('div');
      empty.className = 'so-nb-empty';
      empty.textContent = '（暂无候选）';
      list.appendChild(empty);
      return list;
    }
    for (const o of options) {
      const row = document.createElement('div');
      row.className = 'so-nb-option-row';
      row.title = '点一下：把这一条填入输入框';
      const tag = document.createElement('span');
      tag.className = 'so-nb-option-tag ' + labelClass(o.label);
      tag.textContent = '[' + o.label + ']';
      const txt = document.createElement('span');
      txt.className = 'so-nb-option-text';
      txt.textContent = o.content;
      row.appendChild(tag);
      row.appendChild(txt);
      row.addEventListener('click', () => {
        if (typeof (opts && opts.onPick) === 'function') opts.onPick(o.content);
      });
      list.appendChild(row);
    }
    return list;
  }

  // -------------------------------------------------------------------------
  // Chip（楼层下方 —— 候选结果的唯一展示位）
  // -------------------------------------------------------------------------

  function chipIdFor(messageId) { return 'so-next-beat-chip-' + messageId; }
  function removeChip(id) { const el = document.getElementById(chipIdFor(id)); if (el) el.remove(); }
  function removeAllChips() { document.querySelectorAll('.so-next-beat-chip').forEach((el) => el.remove()); }

  function renderChipIdle(messageId, beatInfo) {
    const s = loadSettings();
    if (!s.showChip) return;
    const $mes = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!$mes) return;
    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip so-next-beat-chip-idle';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = beatInfo && beatInfo.goal
      ? `🧭 下一拍建议 · 第 ${beatInfo.progress} 拍`
      : '🧭 下一拍建议';
    chip.appendChild(label);

    if (beatInfo && beatInfo.goal) {
      const g = document.createElement('div');
      g.className = 'so-next-beat-chip-goal';
      g.textContent = '目标：' + beatInfo.goal;
      chip.appendChild(g);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-next-beat-chip-btn';
    btn.textContent = '生成建议';
    btn.addEventListener('click', (e) => { e.stopPropagation(); triggerGenerateForMessage(messageId); });
    chip.appendChild(btn);

    const anchor = $mes.querySelector('.mes_text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    else $mes.appendChild(chip);
  }

  function renderChipWithOptions(messageId, options, beatInfo) {
    const s = loadSettings();
    if (!s.showChip) return;
    const $mes = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!$mes) return;
    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = beatInfo && beatInfo.goal
      ? `🧭 下一拍建议 · 第 ${beatInfo.progress} 拍`
      : '🧭 下一拍建议';
    chip.appendChild(label);

    if (beatInfo && beatInfo.goal) {
      const g = document.createElement('div');
      g.className = 'so-next-beat-chip-goal';
      g.textContent = '目标：' + beatInfo.goal;
      chip.appendChild(g);
    }

    chip.appendChild(buildOptionsList(options, { onPick: (c) => { fillInput(c); } }));

    const foot = document.createElement('div');
    foot.className = 'so-next-beat-chip-foot';

    const regen = document.createElement('button');
    regen.type = 'button';
    regen.className = 'so-next-beat-chip-btn so-next-beat-chip-btn-minor';
    regen.textContent = '重新生成';
    regen.addEventListener('click', (e) => { e.stopPropagation(); triggerGenerateForMessage(messageId); });
    foot.appendChild(regen);

    const fillAll = document.createElement('button');
    fillAll.type = 'button';
    fillAll.className = 'so-next-beat-chip-btn so-next-beat-chip-btn-minor';
    fillAll.textContent = '填入整段';
    fillAll.title = '把全部候选按行填入输入框';
    fillAll.addEventListener('click', (e) => {
      e.stopPropagation();
      const all = options.map((o) => '[' + o.label + '] ' + o.content).join('\n');
      fillInput(all);
    });
    foot.appendChild(fillAll);

    chip.appendChild(foot);

    const anchor = $mes.querySelector('.mes_text');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    else $mes.appendChild(chip);
  }

  function rehangChips() {
    const key = chatKey();
    const entry = lastByChat[key];
    if (!entry || entry.messageId == null) return;
    if (Array.isArray(entry.options) && entry.options.length) {
      renderChipWithOptions(entry.messageId, entry.options, entry.beatInfo || null);
    }
  }

  function refreshChips() {
    removeAllChips();
    rehangChips();
    updatePanel();
  }

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------

  function ensureToastContainer() {
    let el = document.getElementById('so-next-beat-toast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-next-beat-toast';
    document.body.appendChild(el);
    return el;
  }

  function hideSuggestionToast() {
    const el = document.getElementById('so-next-beat-toast');
    if (el) el.classList.remove('so-next-beat-show');
  }

  function showSuggestionToast(options) {
    const s = loadSettings();
    if (!s.showToast) return;
    const el = ensureToastContainer();
    el.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'so-next-beat-label';
    label.textContent = '🧭 下一拍建议';
    el.appendChild(label);

    el.appendChild(buildOptionsList(options, { onPick: (c) => { fillInput(c); hideSuggestionToast(); } }));

    const row = document.createElement('div');
    row.className = 'so-next-beat-row';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'so-next-beat-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', hideSuggestionToast);
    row.appendChild(closeBtn);
    el.appendChild(row);
    el.classList.add('so-next-beat-show');
  }

  // -------------------------------------------------------------------------
  // lastByChat
  // -------------------------------------------------------------------------

  function setLast(entry) {
    const key = chatKey();
    lastByChat[key] = Object.assign({ at: Date.now() }, entry || {});
    const keys = Object.keys(lastByChat);
    if (keys.length > 30) {
      keys.sort((a, b) => (lastByChat[a].at || 0) - (lastByChat[b].at || 0));
      for (let i = 0; i < keys.length - 30; i++) delete lastByChat[keys[i]];
    }
    updatePanel();
  }

  function getLast() { return lastByChat[chatKey()] || null; }

  // -------------------------------------------------------------------------
  // 触发（手动）
  // -------------------------------------------------------------------------

  async function generateOptionsForMessage(messageId) {
    const ctx = getCtx();
    if (!ctx || !ctx.chat) return null;
    const m = ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return null;
    if (typeof m.mes !== 'string' || m.mes.trim().length < MIN_NARRATIVE_LEN) return null;

    const narrative = cleanNarrative(m.mes);
    if (!narrative || narrative.length < MIN_NARRATIVE_LEN) return null;

    const beatInfo = getActiveBeatInfo();
    const options = await requestNextBeatOptions(narrative, beatInfo);
    return { options, beatInfo, messageId };
  }

  async function triggerGenerateForMessage(messageId) {
    const ctx = getCtx();
    if (!ctx || !ctx.chat) return;
    const m = ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return;

    const chip = document.getElementById(chipIdFor(messageId));
    if (chip) {
      const btn = chip.querySelector('.so-next-beat-chip-btn');
      if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    }
    const busyToast = showBusyToast();

    const myKey = chatKey() + ':' + messageId + ':' + ((m.swipe_id || 0));
    lastRequestKey = myKey;

    let out = null;
    let errMsg = '';
    try { out = await generateOptionsForMessage(messageId); }
    catch (e) { errMsg = String((e && e.message) || e); }
    finally { dismissToast(busyToast); }

    if (lastRequestKey !== myKey) return;
    const cur = ctx.chat[messageId];
    if (!cur || ((cur.swipe_id || 0) !== (m.swipe_id || 0))) return;

    if (!out || !out.options || !out.options.length) {
      renderChipIdle(messageId, getActiveBeatInfo());
      const idleChip = document.getElementById(chipIdFor(messageId));
      if (idleChip) {
        const tip = document.createElement('div');
        tip.className = 'so-next-beat-chip-err';
        tip.textContent = errMsg ? ('（生成失败：' + errMsg + '）') : '（这次没能生成，看看控制台）';
        idleChip.appendChild(tip);
      }
      return;
    }

    setLast({ options: out.options, beatInfo: out.beatInfo, messageId });
    renderChipWithOptions(messageId, out.options, out.beatInfo);
    showSuggestionToast(out.options);
    notifyFloatNewOptions();
    markDone(myKey);
  }

  function showBusyToast() {
    try {
      if (window.toastr && window.toastr.info) {
        return window.toastr.info('正在生成候选…', '🧭 下一拍建议', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function dismissToast(h) {
    try { if (h && window.toastr && window.toastr.clear) window.toastr.clear(h); } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // 自动触发（默认关）
  // -------------------------------------------------------------------------

  function isAiMessage(ctx, messageId) {
    const m = ctx && ctx.chat && ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return false;
    return typeof m.mes === 'string' && m.mes.trim().length > 0;
  }

  async function onMessageRendered(messageId) {
    const s = loadSettings();
    if (!s.enabled) return;

    const ctx = getCtx();
    if (!ctx || !isAiMessage(ctx, messageId)) return;

    const m = ctx.chat[messageId];
    const swipeId = m.swipe_id || 0;
    const key = `${chatKey()}:${messageId}:${swipeId}`;
    if (isDone(key)) return;

    await triggerGenerateForMessage(messageId);
  }

  // -------------------------------------------------------------------------
  // 中心面板
  // -------------------------------------------------------------------------

  const PANEL_POS_KEY = MODULE_ID + '_panel_pos';

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
  }
  function savePanelPos(left, top) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top })); } catch (e) { /* ignore */ }
  }
  function clearPanelPos() {
    try { localStorage.removeItem(PANEL_POS_KEY); } catch (e) { /* ignore */ }
  }

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    const s = loadSettings();

    panelEl = document.createElement('div');
    panelEl.id = 'so-next-beat-panel';
    panelEl.innerHTML = `
      <div class="so-nb-panel-header" id="so-nb-panel-drag-handle" title="按住可拖动此窗口">
        <span>🧭 下一拍建议</span>
        <span class="so-nb-panel-reset" id="so-nb-panel-reset" title="重置到默认位置">⌖</span>
        <span class="so-nb-panel-close" title="关闭">×</span>
      </div>
      <div class="so-nb-panel-body">
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-enabled" ${s.enabled ? 'checked' : ''}>
          每条新回复自动生成（默认关；手动点更省 API）
        </label>
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-chip" ${s.showChip ? 'checked' : ''}>
          在回复下方显示（结果展示位）
        </label>
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-toast" ${s.showToast ? 'checked' : ''}>
          额外用右下角浮窗提示
        </label>
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-float" ${s.showFloat ? 'checked' : ''}>
          悬浮窗常驻（折叠成 🧭 圆标）
        </label>
        <p class="so-nb-panel-label-hint">本面板 / 悬浮球只用来"触发生成"；结果固定显示在对应楼层的下方。圆标只有取消「常驻」才会消失。</p>

        <details class="so-nb-conn" id="so-nb-conn-details">
          <summary>连接设置（建议专用）</summary>
          <div class="so-nb-conn-body">
            <label class="checkbox_label so-nb-toggle-row">
              <input type="checkbox" id="so-nb-conn-inherit" ${s.connInherit ? 'checked' : ''}>
              继承故事神谕的连接设置（只覆盖下面的"模型名"）
            </label>
            <label class="so-nb-panel-label-hint" style="margin-left:22px; display:block;">
              建议用的模型和主神谕模型不同（比如主用 pro，建议用轻量快速模型）时，勾选此项、在下框填模型名即可。留空 = 完全跟随神谕。
            </label>
            <label class="so-nb-field">
              <span>模型名（继承模式下生效；可留空）</span>
              <input type="text" id="so-nb-conn-model-override" value="${escapeAttr(s.connModelOverride)}" placeholder="例如 gpt-4o-mini / gemini-flash / deepseek-chat">
            </label>

            <div id="so-nb-conn-own">
              <p class="so-nb-panel-label-hint">取消勾选「继承」后，以下独立连接设置生效：</p>
              <label class="so-nb-field">
                <span>连接模式</span>
                <select id="so-nb-conn-mode">
                  <option value="direct" ${s.connMode === 'direct' ? 'selected' : ''}>直连（自定义 URL）</option>
                  <option value="profile" ${s.connMode === 'profile' ? 'selected' : ''}>连接配置文件</option>
                </select>
              </label>
              <div id="so-nb-conn-direct">
                <label class="so-nb-field">
                  <span>端点 URL</span>
                  <input type="text" id="so-nb-conn-endpoint" value="${escapeAttr(s.connEndpoint)}" placeholder="https://your-proxy.com/v1">
                </label>
                <label class="so-nb-field">
                  <span>API 密钥</span>
                  <input type="password" id="so-nb-conn-apikey" value="${escapeAttr(s.connApiKey)}" placeholder="sk-...">
                </label>
                <label class="so-nb-field">
                  <span>模型</span>
                  <input type="text" id="so-nb-conn-model" value="${escapeAttr(s.connModel)}" placeholder="gpt-4o-mini">
                </label>
                <label class="checkbox_label so-nb-toggle-row">
                  <input type="checkbox" id="so-nb-conn-backend" ${s.connDirectViaBackend ? 'checked' : ''}>
                  经酒馆后端转发（避免浏览器跨域 CORS）
                </label>
                <label class="checkbox_label so-nb-toggle-row">
                  <input type="checkbox" id="so-nb-conn-rawurl" ${s.connDirectRawUrl ? 'checked' : ''}>
                  地址原样使用（不自动补 /v1）
                </label>
              </div>
              <div id="so-nb-conn-profile">
                <label class="so-nb-field">
                  <span>配置文件</span>
                  <input type="text" id="so-nb-conn-profileid" value="${escapeAttr(s.connProfileId)}" placeholder="Connection Profile ID">
                </label>
              </div>
            </div>
          </div>
        </details>

        <div class="so-nb-panel-label">当前拍：</div>
        <div class="so-nb-panel-beat" id="so-nb-panel-beat">（未在引导序列中）</div>
        <div class="so-nb-panel-label">最近一次生成：</div>
        <div class="so-nb-panel-suggestion" id="so-nb-panel-suggestion">（暂无 —— 点下方按钮生成）</div>
        <div class="so-nb-panel-row">
          <button type="button" id="so-nb-panel-regen" class="so-next-beat-btn so-next-beat-use">针对最新回复生成</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    (function applyStoredPos() {
      const p = loadPanelPos();
      if (!p) return;
      panelEl.style.left = p.left + 'px';
      panelEl.style.top = p.top + 'px';
      panelEl.style.transform = 'scale(0.96)';
    })();

    panelEl.querySelector('#so-nb-panel-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      clearPanelPos();
      panelEl.style.left = '';
      panelEl.style.top = '';
      panelEl.style.transform = '';
    });

    (function wireDrag() {
      const handle = panelEl.querySelector('#so-nb-panel-drag-handle');
      let sx = 0, sy = 0, sl = 0, st = 0, pid = null, moved = false;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.so-nb-panel-close') || e.target.closest('.so-nb-panel-reset')) return;
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        moved = false;
        const r = panelEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panelEl.style.left = sl + 'px';
        panelEl.style.top = st + 'px';
        panelEl.style.transform = '';
        panelEl.classList.add('so-nb-dragging');
        try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      handle.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nx = Math.max(80 - w, Math.min(vw - 80, sl + dx));
        const ny = Math.max(0, Math.min(vh - 40, st + dy));
        panelEl.style.left = nx + 'px';
        panelEl.style.top = ny + 'px';
      });
      const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        panelEl.classList.remove('so-nb-dragging');
        if (moved) {
          const r = panelEl.getBoundingClientRect();
          savePanelPos(Math.round(r.left), Math.round(r.top));
        }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();

    panelEl.querySelector('.so-nb-panel-close').addEventListener('click', () => togglePanel(false));

    const bindToggle = (id, key) => {
      const el = panelEl.querySelector(id);
      el.addEventListener('change', function () {
        const st = loadSettings();
        st[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
        if (key === 'showFloat') applyFloatVisibility();
        if (key === 'connInherit') applyConnVisibility();
      });
    };
    bindToggle('#so-nb-panel-enabled', 'enabled');
    bindToggle('#so-nb-panel-chip', 'showChip');
    bindToggle('#so-nb-panel-toast', 'showToast');
    bindToggle('#so-nb-panel-float', 'showFloat');
    bindToggle('#so-nb-conn-inherit', 'connInherit');
    bindToggle('#so-nb-conn-backend', 'connDirectViaBackend');
    bindToggle('#so-nb-conn-rawurl', 'connDirectRawUrl');

    const bindInput = (id, key) => {
      const el = panelEl.querySelector(id);
      el.addEventListener('input', function () {
        const st = loadSettings();
        st[key] = this.value;
        saveSettings();
      });
    };
    bindInput('#so-nb-conn-model-override', 'connModelOverride');
    bindInput('#so-nb-conn-endpoint', 'connEndpoint');
    bindInput('#so-nb-conn-apikey', 'connApiKey');
    bindInput('#so-nb-conn-model', 'connModel');
    bindInput('#so-nb-conn-profileid', 'connProfileId');

    const modeSel = panelEl.querySelector('#so-nb-conn-mode');
    modeSel.addEventListener('change', function () {
      const st = loadSettings();
      st.connMode = this.value === 'profile' ? 'profile' : 'direct';
      saveSettings();
      applyConnVisibility();
    });

    applyConnVisibility();

    // 面板 = 快捷生成：点完立刻收起；结果只会进楼层 chip。
    panelEl.querySelector('#so-nb-panel-regen').addEventListener('click', async () => {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) return;
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) { idx = i; break; }
      }
      if (idx === -1) { setPanelSuggestion(null); return; }
      togglePanel(false);
      await triggerGenerateForMessage(idx);
    });

    return panelEl;
  }

  // 按 connInherit / connMode 显隐连接子面板
  function applyConnVisibility() {
    if (!panelEl || !panelEl.isConnected) return;
    const s = loadSettings();
    const ownBox = panelEl.querySelector('#so-nb-conn-own');
    const directBox = panelEl.querySelector('#so-nb-conn-direct');
    const profileBox = panelEl.querySelector('#so-nb-conn-profile');
    const modelOverrideField = panelEl.querySelector('#so-nb-conn-model-override');
    if (ownBox) ownBox.style.display = s.connInherit ? 'none' : '';
    if (directBox) directBox.style.display = s.connMode === 'direct' ? '' : 'none';
    if (profileBox) profileBox.style.display = s.connMode === 'profile' ? '' : 'none';
    if (modelOverrideField) {
      const label = modelOverrideField.closest('label');
      if (label) label.style.display = s.connInherit ? '' : 'none';
    }
  }

  function setPanelSuggestion(options) {
    if (!panelEl || !panelEl.isConnected) return;
    const host = panelEl.querySelector('#so-nb-panel-suggestion');
    if (!host) return;
    host.innerHTML = '';
    if (!Array.isArray(options) || !options.length) {
      host.textContent = '（暂无 —— 点下方按钮生成）';
      return;
    }
    host.textContent = `✓ 已生成 ${options.length} 条候选 —— 请到对应楼层下方查看 / 点选`;
  }

  function setPanelBeat(text) {
    if (!panelEl || !panelEl.isConnected) return;
    const el = panelEl.querySelector('#so-nb-panel-beat');
    if (el) el.textContent = text;
  }

  function updatePanel() {
    if (!panelEl || !panelEl.isConnected) return;
    const entry = getLast();
    if (entry && Array.isArray(entry.options) && entry.options.length) {
      setPanelSuggestion(entry.options);
      const b = entry.beatInfo;
      if (b && b.goal) setPanelBeat(`第 ${b.progress} 拍${b.beatTitle ? ' · ' + b.beatTitle : ''}\n目标：${b.goal}`);
      else setPanelBeat('（未在引导序列中）');
    } else {
      setPanelSuggestion(null);
      const b = getActiveBeatInfo();
      if (b && b.goal) setPanelBeat(`第 ${b.progress} 拍${b.beatTitle ? ' · ' + b.beatTitle : ''}\n目标：${b.goal}`);
      else setPanelBeat('（未在引导序列中）');
    }
  }

  function togglePanel(forceShow) {
    const el = ensurePanel();
    const show = forceShow !== undefined ? forceShow : !el.classList.contains('so-nb-panel-show');
    el.classList.toggle('so-nb-panel-show', show);
    if (show) {
      applyConnVisibility();
      updatePanel();
    }
  }

  // -------------------------------------------------------------------------
  // 悬浮球（极简：状态 + 两个按钮）
  // -------------------------------------------------------------------------

  const FLOAT_ID = 'so-nb-float';
  const FLOAT_POS_KEY = MODULE_ID + '_float_pos';

  function loadFloatPos() {
    try {
      const raw = localStorage.getItem(FLOAT_POS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Number.isFinite(o.left) && Number.isFinite(o.top)) return o;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveFloatPos(left, top) {
    try { localStorage.setItem(FLOAT_POS_KEY, JSON.stringify({ left, top })); } catch (e) { /* ignore */ }
  }

  function ensureFloat() {
    if (floatEl && floatEl.isConnected) return floatEl;

    floatEl = document.createElement('div');
    floatEl.id = FLOAT_ID;
    floatEl.className = 'so-nb-float-hidden so-nb-float-collapsed';
    floatEl.innerHTML = `
      <div class="so-nb-float-badge" title="🧭 下一拍建议（点开 / 折叠）">🧭</div>
      <div class="so-nb-float-body">
        <div class="so-nb-float-head" id="so-nb-float-drag-handle">
          <span class="so-nb-float-title">🧭 下一拍建议</span>
          <span class="so-nb-float-icon-btn" id="so-nb-float-close" title="收起卡片（圆标会保留）">×</span>
        </div>
        <div class="so-nb-float-content" id="so-nb-float-content">（点击下方按钮生成候选）</div>
        <div class="so-nb-float-actions">
          <button type="button" class="so-next-beat-btn so-next-beat-use" id="so-nb-float-regen">生成 / 重新生成</button>
          <button type="button" class="so-next-beat-btn" id="so-nb-float-jump">跳到最新候选</button>
        </div>
      </div>
    `;
    document.body.appendChild(floatEl);

    const p = loadFloatPos();
    if (p) {
      floatEl.style.left = p.left + 'px';
      floatEl.style.top = p.top + 'px';
      floatEl.style.right = 'auto';
    }

    floatEl.querySelector('.so-nb-float-badge').addEventListener('click', () => {
      setFloatCollapsed(!floatCollapsed);
    });

    floatEl.querySelector('#so-nb-float-close').addEventListener('click', () => {
      setFloatCollapsed(true);
    });

    floatEl.querySelector('#so-nb-float-regen').addEventListener('click', async () => {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) { setFloatContent('（找不到聊天）'); return; }
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) { idx = i; break; }
      }
      if (idx === -1) { setFloatContent('（找不到可用的 AI 回复）'); return; }
      setFloatCollapsed(true);
      await triggerGenerateForMessage(idx);
    });

    floatEl.querySelector('#so-nb-float-jump').addEventListener('click', () => {
      jumpToLatestChip();
    });

    wireFloatDrag();
    return floatEl;
  }

  function jumpToLatestChip() {
    const chips = document.querySelectorAll('.so-next-beat-chip');
    if (!chips.length) {
      setFloatContent('（还没有候选 —— 先点「生成 / 重新生成」）');
      return;
    }
    const last = chips[chips.length - 1];
    try {
      last.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      try { last.scrollIntoView(); } catch (_) { /* ignore */ }
    }
    last.classList.add('so-nb-flash');
    setTimeout(() => last.classList.remove('so-nb-flash'), 1200);
  }

  function wireFloatDrag() {
    const badge = floatEl.querySelector('.so-nb-float-badge');
    const handle = floatEl.querySelector('#so-nb-float-drag-handle');
    const makeDrag = (el) => {
      let sx = 0, sy = 0, sl = 0, st = 0, pid = null, moved = false;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.so-nb-float-icon-btn')) return;
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        moved = false;
        const r = floatEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        floatEl.style.left = sl + 'px';
        floatEl.style.top = st + 'px';
        floatEl.style.right = 'auto';
        try { el.setPointerCapture(pid); } catch (_) { /* ignore */ }
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const w = floatEl.offsetWidth, h = floatEl.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        const nx = Math.max(0, Math.min(vw - w, sl + dx));
        const ny = Math.max(0, Math.min(vh - h, st + dy));
        floatEl.style.left = nx + 'px';
        floatEl.style.top = ny + 'px';
      });
      const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { el.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        if (moved) {
          const r = floatEl.getBoundingClientRect();
          saveFloatPos(Math.round(r.left), Math.round(r.top));
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          floatEl.addEventListener('click', swallow, { capture: true, once: true });
          setTimeout(() => floatEl.removeEventListener('click', swallow, { capture: true }), 300);
        }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    };
    makeDrag(badge);
    makeDrag(handle);
  }

  function setFloatCollapsed(collapsed) {
    if (!floatEl) return;
    floatCollapsed = !!collapsed;
    floatEl.classList.toggle('so-nb-float-collapsed', floatCollapsed);
    if (floatCollapsed) {
      floatEl.classList.remove('so-nb-float-fresh');
      floatFresh = false;
    }
  }

  function setFloatContent(text) {
    if (!floatEl) return;
    const host = floatEl.querySelector('#so-nb-float-content');
    if (!host) return;
    host.textContent = typeof text === 'string' ? text : '（点击下方按钮生成候选）';
  }

  function applyFloatVisibility() {
    const s = loadSettings();
    if (!s.showFloat) {
      if (floatEl) floatEl.classList.add('so-nb-float-hidden');
      return;
    }
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    setFloatCollapsed(true);
    updateFloatStatus();
  }

  function updateFloatStatus() {
    const entry = getLast();
    if (entry && Array.isArray(entry.options) && entry.options.length) {
      setFloatContent(`✓ 已生成 ${entry.options.length} 条候选（在楼层下方）`);
    } else {
      setFloatContent('（点击下方按钮生成候选）');
    }
  }

  function notifyFloatNewOptions() {
    const s = loadSettings();
    if (!s.showFloat) return;
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    setFloatCollapsed(true);
    updateFloatStatus();
    floatFresh = true;
    el.classList.add('so-nb-float-fresh');
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------

  function bindEvents() {
    const ctx = getCtx();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
      setTimeout(bindEvents, 500);
      return;
    }
    const et = ctx.event_types;
    const on = (ev, fn) => { try { ctx.eventSource.on(ev, fn); } catch (e) { /* ignore */ } };

    on(et.CHARACTER_MESSAGE_RENDERED, (id) => {
      Promise.resolve(onMessageRendered(id)).catch((e) => console.warn('[next-beat] 处理失败：', e));
      setTimeout(refreshChips, 50);
    });
    ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'].forEach((name) => {
      if (et[name]) on(et[name], () => setTimeout(refreshChips, 30));
    });
    if (et.CHAT_CHANGED) on(et.CHAT_CHANGED, () => {
      removeAllChips();
      setTimeout(rehangChips, 100);
      updatePanel();
      applyFloatVisibility();
    });
  }

  // -------------------------------------------------------------------------
  // 魔杖菜单
  // -------------------------------------------------------------------------

  const WAND_ID = 'so-next-beat-wand-button';

  function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(WAND_ID) && menu.contains(document.getElementById(WAND_ID))) return true;
    const old = document.getElementById(WAND_ID);
    if (old) old.remove();

    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-compass"></i><span>下一拍建议</span>';
    item.addEventListener('click', () => {
      const st = loadSettings();
      if (!st.showFloat) { st.showFloat = true; saveSettings(); syncSettingsUI(); applyFloatVisibility(); }
      togglePanel(true);
    });
    menu.appendChild(item);
    return true;
  }

  function watchWandMenu() {
    if (!injectWandButton()) {
      const mo = new MutationObserver(() => { if (injectWandButton()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
      return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
      const mo = new MutationObserver(() => { injectWandButton(); });
      mo.observe(menu, { childList: true, subtree: true });
    }
  }

  // -------------------------------------------------------------------------
  // 设置面板（扩展设置区）
  // -------------------------------------------------------------------------

  function syncSettingsUI() {
    const s = loadSettings();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    set('so_next_beat_enabled', s.enabled);
    set('so_next_beat_chip', s.showChip);
    set('so_next_beat_toast', s.showToast);
    set('so_next_beat_float', s.showFloat);
    if (panelEl && panelEl.isConnected) {
      set('so-nb-panel-enabled', s.enabled);
      set('so-nb-panel-chip', s.showChip);
      set('so-nb-panel-toast', s.showToast);
      set('so-nb-panel-float', s.showFloat);
      set('so-nb-conn-inherit', s.connInherit);
      applyConnVisibility();
    }
  }

  function addSettingsUI() {
    if (document.getElementById('so-next-beat-settings')) return;
    const container = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!container) return;

    const div = document.createElement('div');
    div.id = 'so-next-beat-settings';
    div.className = 'so-next-beat-settings';
    div.innerHTML = `
      <h4>🧭 下一拍建议（配套故事神谕，独立扩展 v${VERSION}）</h4>
      <label class="checkbox_label">
        <input id="so_next_beat_enabled" type="checkbox">
        每条新回复自动生成（默认关；手动点更省 API）
      </label>
      <label class="checkbox_label">
        <input id="so_next_beat_chip" type="checkbox">
        在对应回复下方显示建议（结果展示位）
      </label>
      <label class="checkbox_label">
        <input id="so_next_beat_toast" type="checkbox">
        额外用右下角浮窗提示
      </label>
      <label class="checkbox_label">
        <input id="so_next_beat_float" type="checkbox">
        悬浮窗常驻（折叠成 🧭 圆标）
      </label>
      <p style="opacity:0.7; font-size:0.85em;">
        也可以点输入框旁 🪄 菜单里的「下一拍建议」打开小窗口；连接设置也住在那个窗口里。
      </p>
    `;
    container.appendChild(div);
    syncSettingsUI();

    const bindToggle = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        const s = loadSettings();
        s[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
        if (key === 'showFloat') applyFloatVisibility();
      });
    };
    bindToggle('so_next_beat_enabled', 'enabled');
    bindToggle('so_next_beat_chip', 'showChip');
    bindToggle('so_next_beat_toast', 'showToast');
    bindToggle('so_next_beat_float', 'showFloat');
  }

  // HTML 属性转义
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // -------------------------------------------------------------------------
  // 等 story-oracle
  // -------------------------------------------------------------------------

  function waitForStoryOracle(callback) {
    if (window.StoryOracleAPI) { callback(); return; }
    document.addEventListener('story-oracle-ready', callback, { once: true });
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (window.StoryOracleAPI) { clearInterval(timer); callback(); }
      else if (tries > 30) { clearInterval(timer); console.warn('[next-beat] 等待故事神谕超时'); }
    }, 500);
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  jQuery(async () => {
    waitForStoryOracle(() => {
      const api = window.StoryOracleAPI;
      if (!api) {
        console.warn('[next-beat] 没有检测到故事神谕（StoryOracleAPI），本扩展不生效');
        return;
      }
      if (typeof api.isCompatible === 'function' && !api.isCompatible(1)) {
        console.warn('[next-beat] 故事神谕接口版本不兼容，本扩展跳过');
        return;
      }
      addSettingsUI();
      bindEvents();
      watchWandMenu();
      refreshChips();
      applyFloatVisibility();
      console.log('[next-beat] 已加载（v' + VERSION + '）');
    });
  });
})();
