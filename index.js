// ============================================================================
// 故事神谕 · 下一拍建议（独立插件，不改 story-oracle 任何代码）
// v2.0.0
//
// 功能：
//   主聊天每收到一条新的 AI 回复后，本插件自动：
//     1) 通过 story-oracle 的 unsafe.eval 读到「当前正在引导的序列」以及
//        「当前 active 拍」的 goal（= 玩家接下来要开启的这一拍）；
//     2) 复用它自己那两个剥离函数（stripMechanismBlocks / stripReasoningTags）
//        得到干净的正文；
//     3) 调一次 story-oracle 已配置好的连接（api.run），让模型写出「一句最适合
//        玩家现在发送、能自然把剧情推进到本拍目标」的指令；
//     4) 把这句话贴在对应 AI 回复下方（chip）+ 面板里同步显示，点一下即填入
//        输入框（不自动发送，可编辑）。
//
// 关键修复（v2.0.0 相对社区 v1.2.0）：
//   - maxTokens 从 300 提到 4096 地板（300 会被 reasoning 模型的思考 token 吃光，
//     输出被截在半句——社区版实测 bug）；
//   - 用 unsafe.eval 复用 story-oracle 的剥离逻辑，不再自己手写正则（避免两套
//     规则漂移，社区版 <json_patch> / <story_plan> 都漏了）；
//   - 读到 active 拍的 goal 并喂进 prompt，让建议能真正对上「下一拍」；
//   - 加 AbortController + 240s 超时（社区版一旦发出就无法中断）；
//   - 加「同一楼只处理一次」的持久去重（社区版刷新页面会全量重跑历史消息）；
//   - 加「最新一条生效」的并发控制（社区版连掷 5 次会并发 5 个请求）；
//   - 加全量重挂（MESSAGE_SWIPED / MESSAGE_EDITED / MESSAGE_DELETED / CHAT_CHANGED）
//     ——楼层被别的扩展重画后 chip 会自己补回来；
//   - lastSuggestion 按聊天隔离（社区版切聊天会串味）；
//   - 魔杖菜单入口改用 MutationObserver 补挂（社区版 setInterval 每 3 秒轮询）。
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const VERSION = '2.0.0';

  const DEFAULTS = {
    enabled: true,          // 每条新回复自动生成建议
    showChip: true,         // 在回复下方显示 chip
    showToast: false,       // 右下角 toast（默认关，chip 已够）
  };

  // 生成一句话不需要长输出；但 reasoning 模型会把思考算进 max_tokens，
  // 300 会被思考吃光（社区版实测 bug）。4096 与 story-oracle 本体所有后台
  // 调用的地板一致；max_tokens 是上限不是预扣，成本不变。
  const MIN_OUTPUT_TOKENS = 4096;
  const REQUEST_TIMEOUT_MS = 240000;   // 与 story-oracle 本体的 POST_REPLY_CALL_TIMEOUT_MS 一致
  const MIN_NARRATIVE_LEN = 10;

  // 持久去重键前缀（存 chat_metadata，页面刷新后仍有效）
  const DONE_META_KEY = MODULE_ID + '_done';
  const DONE_KEEP_MAX = 400;           // 每个聊天最多记 400 条，超出丢最旧

  // 面板 / chip 上的进度 / 建议按聊天隔离
  let lastByChat = {};                 // { [chatKey]: { suggestion, beatInfo, messageId, at } }
  let panelEl = null;
  let currentAbort = null;             // 当前在途请求（新请求发起时 abort 上一个）
  let lastRequestKey = null;           // 最新一次请求的身份（防竞态：只有最后发出的那个能落地）

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

  function loadSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    ctx.extensionSettings[MODULE_ID] = Object.assign(
      {},
      DEFAULTS,
      ctx.extensionSettings[MODULE_ID] || {},
    );
    return ctx.extensionSettings[MODULE_ID];
  }

  function saveSettings() {
    const ctx = getCtx();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
      ctx.saveSettingsDebounced();
    }
  }

  // -------------------------------------------------------------------------
  // 持久去重（替换社区版的内存 Set）
  // -------------------------------------------------------------------------
  // key 形如 `${chatKey}:${messageId}:${swipeId}`；存 chat_metadata。
  // 页面刷新后仍认得，避免把历史消息重跑一遍（社区版的最大行为 bug）。

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
    // 上限保护：只留最近 N 条
    while (arr.length > DONE_KEEP_MAX) arr.shift();
    md[DONE_META_KEY] = arr;
    try {
      const save = ctx.saveMetadataDebounced || ctx.saveMetadata;
      if (typeof save === 'function') save.call(ctx);
    } catch (e) { /* ignore */ }
  }

  function isDone(key) {
    return readDoneSet().has(key);
  }

  // -------------------------------------------------------------------------
  // 复用 story-oracle 的剥离逻辑（unsafe.eval）
  // -------------------------------------------------------------------------
  // 不再自己手写正则 —— 社区版漏了 <json_patch>、<story_plan> 等变体，
  // 与 story-oracle 本体两套规则必然漂移。这里直接调它自己的两个函数，
  // 剥出来的正文与它内部使用的完全一致。

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

  // -------------------------------------------------------------------------
  // 读序列状态（unsafe.eval）
  // -------------------------------------------------------------------------
  // 返回 null（没有序列）或：
  //   { seqTitle, progress, beatTitle, goal, seed, why, cursor, total }
  // goal 取【当前 active 拍】—— 玩家接下来要开启的那一拍。

  function getActiveBeatInfo() {
    const seq = apiSafeEval(
      '(typeof getSeq === "function" ? getSeq() : null)',
      null,
    );
    if (!seq || !Array.isArray(seq.beats) || !seq.beats.length) return null;
    const active = apiSafeEval(
      '(typeof seqActiveBeat === "function" ? seqActiveBeat(getSeq()) : null)',
      null,
    );
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
  // Prompt 组装
  // -------------------------------------------------------------------------

  const SYSTEM_PROMPT =
    '你是一个为角色扮演游戏生成「玩家下一步指令」的助手。' +
    '用户会给你：当前剧情的最后一段正文，以及（如果有）当前正在引导的剧情序列中的某一拍目标。' +
    '你只输出【一句话】——玩家接下来最适合发送给 AI 的指令。' +
    '要求：' +
    '1) 用第一人称「我」；' +
    '2) 具体到可以立刻发送（带时间 / 地点 / 动作 / 台词中的一两样）；' +
    '3) 若给了拍目标，这句话必须能把剧情自然推向那个目标；' +
    '4) 不要复述或评论正文；' +
    '5) 不要加引号、不要编号、不要任何前后缀说明；' +
    '6) 只说这一句话本身。';

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
      parts.push('【刚写完的正文（仅供参考，不要复述）】');
      parts.push('"""');
      parts.push(narrativeText.slice(-4000));
      parts.push('"""');
      parts.push('');
      parts.push('请输出一句「玩家」接下来要发送给 AI 的指令，' +
        '必须能把剧情自然推向上面那个【本拍目标】，' +
        '风格参考：「到了5月26日早晨，第一食堂的空气有些凝重，我端着茶缸，走进了杨厂长的会议室。」' +
        '只输出这一句话本身。');
    } else {
      parts.push('【刚写完的正文（仅供参考，不要复述）】');
      parts.push('"""');
      parts.push(narrativeText.slice(-4000));
      parts.push('"""');
      parts.push('');
      parts.push('请输出一句「玩家」接下来最适合发送给 AI 的指令，' +
        '要能让剧情顺着刚才这段正文自然过渡到下一步。' +
        '只输出这一句话本身。');
    }
    return parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // 调 API
  // -------------------------------------------------------------------------

  async function requestNextBeatOption(narrativeText, beatInfo) {
    const api = window.StoryOracleAPI;
    if (!api || typeof api.run !== 'function') {
      console.warn('[next-beat] StoryOracleAPI.run 不可用，跳过');
      return null;
    }

    // 并发控制：新请求发起时 abort 上一个在途请求
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ctl = new AbortController();
    currentAbort = ctl;
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, REQUEST_TIMEOUT_MS);

    // maxTokens：地板 4096（reasoning 模型思考也吃 max_tokens）
    let userMax = 0;
    try {
      if (typeof api.getSettings === 'function') {
        const s = api.getSettings();
        if (s && Number.isFinite(Number(s.maxTokens))) userMax = Number(s.maxTokens);
      }
    } catch (e) { /* ignore */ }
    const maxTokens = Math.max(userMax, MIN_OUTPUT_TOKENS);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(narrativeText, beatInfo) },
    ];

    try {
      const result = await api.run(messages, {
        stream: false,
        maxTokens,
        signal: ctl.signal,
      });
      let text = '';
      if (typeof result === 'string') text = result;
      else if (result && typeof result === 'object') {
        text = result.text || result.content || result.reply || '';
      }
      text = String(text || '').trim();
      // 模型偶尔会自己套引号；只剥成对的首尾引号，不误伤台词里的引号
      text = text.replace(/^["“'「『]+/, '').replace(/["”'」』]+$/, '').trim();
      return text || null;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // 主动中断或新请求顶替 —— 静默
        return null;
      }
      console.error('[next-beat] 调用失败：', err);
      return null;
    } finally {
      clearTimeout(timer);
      if (currentAbort === ctl) currentAbort = null;
    }
  }

  // -------------------------------------------------------------------------
  // 输入框填入
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
  // Chip（贴在 AI 回复下方）
  // -------------------------------------------------------------------------

  function chipIdFor(messageId) { return 'so-next-beat-chip-' + messageId; }

  function removeChip(messageId) {
    const el = document.getElementById(chipIdFor(messageId));
    if (el) el.remove();
  }

  function removeAllChips() {
    document.querySelectorAll('.so-next-beat-chip').forEach((el) => el.remove());
  }

  function renderChip(messageId, suggestionText, beatInfo) {
    const settings = loadSettings();
    if (!settings.showChip) return;
    const $mes = document.querySelector('.mes[mesid="' + messageId + '"]');
    if (!$mes) return;

    removeChip(messageId);

    const chip = document.createElement('div');
    chip.id = chipIdFor(messageId);
    chip.className = 'so-next-beat-chip';
    chip.title = '点一下：填入输入框（可编辑后再发送）';

    const label = document.createElement('span');
    label.className = 'so-next-beat-chip-label';
    label.textContent = beatInfo && beatInfo.goal
      ? `🧭 下一拍建议 · 第 ${beatInfo.progress} 拍`
      : '🧭 下一拍建议';
    chip.appendChild(label);

    const textEl = document.createElement('span');
    textEl.className = 'so-next-beat-chip-text';
    textEl.textContent = suggestionText;
    chip.appendChild(textEl);

    chip.addEventListener('click', () => {
      if (fillInput(suggestionText)) {
        chip.classList.add('so-next-beat-chip-used');
      }
    });

    // 插到 .mes_text 之后（与 story-oracle 自己的 ✂️ 入口同一挂载哲学：
    // 挂在 .mes 一层、不进 .mes_text 内部，被 AI 输出正则 / 酒馆助手重画
    // .mes_text 时不会连带被清掉）
    const anchor = $mes.querySelector('.mes_text');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    } else {
      $mes.appendChild(chip);
    }
  }

  // -------------------------------------------------------------------------
  // 全量重挂：楼层被别的扩展重画后，把已知 chip 补回来
  // -------------------------------------------------------------------------
  // 与 story-oracle 的 refreshFixChatEntry 同一策略 —— 每次相关事件都全量重挂。

  function rehangChips() {
    const key = chatKey();
    const entry = lastByChat[key];
    if (!entry || !entry.suggestion || entry.messageId == null) return;
    renderChip(entry.messageId, entry.suggestion, entry.beatInfo || null);
  }

  function refreshChips() {
    removeAllChips();
    rehangChips();
    updatePanel();
  }

  // -------------------------------------------------------------------------
  // Toast（可选，默认关）
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

  function showSuggestionToast(suggestionText) {
    const settings = loadSettings();
    if (!settings.showToast) return;
    const el = ensureToastContainer();
    el.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'so-next-beat-label';
    label.textContent = '🧭 下一拍建议';
    el.appendChild(label);

    const body = document.createElement('div');
    body.className = 'so-next-beat-body';
    body.textContent = suggestionText;
    el.appendChild(body);

    const row = document.createElement('div');
    row.className = 'so-next-beat-row';

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'so-next-beat-btn so-next-beat-use';
    useBtn.textContent = '使用';
    useBtn.addEventListener('click', () => { fillInput(suggestionText); hideSuggestionToast(); });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'so-next-beat-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', hideSuggestionToast);

    row.appendChild(useBtn);
    row.appendChild(closeBtn);
    el.appendChild(row);
    el.classList.add('so-next-beat-show');
  }

  // -------------------------------------------------------------------------
  // 按聊天隔离的 lastSuggestion
  // -------------------------------------------------------------------------

  function setLast(entry) {
    const key = chatKey();
    lastByChat[key] = Object.assign({ at: Date.now() }, entry || {});
    // 上限保护：只留最近 30 个聊天
    const keys = Object.keys(lastByChat);
    if (keys.length > 30) {
      keys.sort((a, b) => (lastByChat[a].at || 0) - (lastByChat[b].at || 0));
      for (let i = 0; i < keys.length - 30; i++) delete lastByChat[keys[i]];
    }
    updatePanel();
  }

  function getLast() {
    return lastByChat[chatKey()] || null;
  }

  // -------------------------------------------------------------------------
  // 浮动面板
  // -------------------------------------------------------------------------

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    const settings = loadSettings();

    panelEl = document.createElement('div');
    panelEl.id = 'so-next-beat-panel';
    panelEl.innerHTML = `
      <div class="so-nb-panel-header">
        <span>🧭 下一拍建议</span>
        <span class="so-nb-panel-close" title="关闭">×</span>
      </div>
      <div class="so-nb-panel-body">
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-enabled" ${settings.enabled ? 'checked' : ''}>
          正文生成后自动生成建议
        </label>
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-chip" ${settings.showChip ? 'checked' : ''}>
          在回复下方显示建议
        </label>
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-toast" ${settings.showToast ? 'checked' : ''}>
          额外用右下角浮窗提示
        </label>
        <div class="so-nb-panel-label">当前拍：</div>
        <div class="so-nb-panel-beat" id="so-nb-panel-beat">（未在引导序列中）</div>
        <div class="so-nb-panel-label">最近一次建议：</div>
        <div class="so-nb-panel-suggestion" id="so-nb-panel-suggestion">（暂无）</div>
        <div class="so-nb-panel-row">
          <button type="button" id="so-nb-panel-use" class="so-next-beat-btn so-next-beat-use">使用这句</button>
          <button type="button" id="so-nb-panel-regen" class="so-next-beat-btn">针对最新回复生成</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('.so-nb-panel-close').addEventListener('click', () => togglePanel(false));

    const bindToggle = (id, key) => {
      const el = panelEl.querySelector(id);
      el.addEventListener('change', function () {
        const s = loadSettings();
        s[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
      });
    };
    bindToggle('#so-nb-panel-enabled', 'enabled');
    bindToggle('#so-nb-panel-chip', 'showChip');
    bindToggle('#so-nb-panel-toast', 'showToast');

    panelEl.querySelector('#so-nb-panel-use').addEventListener('click', () => {
      const entry = getLast();
      if (entry && entry.suggestion) {
        fillInput(entry.suggestion);
        togglePanel(false);
      } else {
        // N3：空建议时点「使用这句」有反馈，不是静默无反应
        setPanelSuggestion('（还没有建议——等一条新的正文回复，或点右边「针对最新回复生成」）');
      }
    });

    panelEl.querySelector('#so-nb-panel-regen').addEventListener('click', async () => {
      const ctx = getCtx();
      if (!ctx || !ctx.chat || !ctx.chat.length) return;
      let idx = -1;
      for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) {
          idx = i; break;
        }
      }
      if (idx === -1) { setPanelSuggestion('（找不到可用的 AI 回复）'); return; }

      const btn = panelEl.querySelector('#so-nb-panel-regen');
      const old = btn.textContent;
      btn.textContent = '生成中…';
      btn.disabled = true;
      try {
        const m = ctx.chat[idx];
        const narrative = cleanNarrative(m.mes);
        if (!narrative || narrative.length < MIN_NARRATIVE_LEN) {
          setPanelSuggestion('（这条回复没有可用的正文）');
          return;
        }
        const beatInfo = getActiveBeatInfo();
        const suggestion = await requestNextBeatOption(narrative, beatInfo);
        if (suggestion) {
          setLast({ suggestion, beatInfo, messageId: idx });
          renderChip(idx, suggestion, beatInfo);
          showSuggestionToast(suggestion);
        } else {
          setPanelSuggestion('（这次没能生成，看看浏览器控制台）');
        }
      } finally {
        btn.textContent = old;
        btn.disabled = false;
      }
    });

    return panelEl;
  }

  function setPanelSuggestion(text) {
    if (!panelEl || !panelEl.isConnected) return;
    const el = panelEl.querySelector('#so-nb-panel-suggestion');
    if (el) el.textContent = text;
  }

  function setPanelBeat(text) {
    if (!panelEl || !panelEl.isConnected) return;
    const el = panelEl.querySelector('#so-nb-panel-beat');
    if (el) el.textContent = text;
  }

  function updatePanel() {
    if (!panelEl || !panelEl.isConnected) return;
    const entry = getLast();
    if (entry && entry.suggestion) {
      setPanelSuggestion(entry.suggestion);
      const b = entry.beatInfo;
      if (b && b.goal) {
        setPanelBeat(`第 ${b.progress} 拍${b.beatTitle ? ' · ' + b.beatTitle : ''}\n目标：${b.goal}`);
      } else {
        setPanelBeat('（未在引导序列中）');
      }
    } else {
      setPanelSuggestion('（暂无）');
      const b = getActiveBeatInfo();
      if (b && b.goal) {
        setPanelBeat(`第 ${b.progress} 拍${b.beatTitle ? ' · ' + b.beatTitle : ''}\n目标：${b.goal}`);
      } else {
        setPanelBeat('（未在引导序列中）');
      }
    }
  }

  function togglePanel(forceShow) {
    const el = ensurePanel();
    const show = forceShow !== undefined ? forceShow : !el.classList.contains('so-nb-panel-show');
    el.classList.toggle('so-nb-panel-show', show);
    if (show) updatePanel();
  }

  // -------------------------------------------------------------------------
  // 触发：每条新的 AI 回复
  // -------------------------------------------------------------------------

  function isAiMessage(ctx, messageId) {
    const m = ctx && ctx.chat && ctx.chat[messageId];
    if (!m || m.is_user || m.is_system) return false;
    return typeof m.mes === 'string' && m.mes.trim().length > 0;
  }

  async function onMessageRendered(messageId) {
    const settings = loadSettings();
    if (!settings.enabled) return;

    const ctx = getCtx();
    if (!ctx || !isAiMessage(ctx, messageId)) return;

    const m = ctx.chat[messageId];
    const swipeId = m.swipe_id || 0;
    const key = `${chatKey()}:${messageId}:${swipeId}`;

    // 持久去重：页面刷新后不再重跑历史消息
    if (isDone(key)) return;

    const narrative = cleanNarrative(m.mes);
    if (!narrative || narrative.length < MIN_NARRATIVE_LEN) return;

    // 在发起请求前就标记 done —— 即使请求失败也不重跑（用户可点面板「针对最新回复生成」重试）
    markDone(key);

    const beatInfo = getActiveBeatInfo();
    const myKey = key;   // 闭包捕获
    lastRequestKey = myKey;

    const suggestion = await requestNextBeatOption(narrative, beatInfo);

    // 竞态守卫：只有最新一次请求的结果能落地（连掷多条时旧的静默丢弃）
    if (lastRequestKey !== myKey) return;
    if (!suggestion) return;
    // 二次核对：这条消息还在、还是同一条 swipe
    const cur = ctx.chat[messageId];
    if (!cur || ((cur.swipe_id || 0) !== swipeId)) return;

    setLast({ suggestion, beatInfo, messageId });
    renderChip(messageId, suggestion, beatInfo);
    showSuggestionToast(suggestion);
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
      // 别的扩展可能重画了楼层 —— chip 全量重挂
      setTimeout(refreshChips, 50);
    });
    // 楼层重画 / 换 swipe / 编辑 / 删除 / 切聊天 —— 全量重挂 chip（复用 story-oracle 自身的策略）
    ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED'].forEach((name) => {
      if (et[name]) on(et[name], () => setTimeout(refreshChips, 30));
    });
    if (et.CHAT_CHANGED) on(et.CHAT_CHANGED, () => {
      // 切聊天：清掉当前挂的 chip（chips 是按当前聊天的 messageId 定位的，换了聊天就没有意义）
      removeAllChips();
      // 把新聊天里已存在的那一条 chip 挂回来（如果有）
      setTimeout(rehangChips, 100);
      updatePanel();
    });
  }

  // -------------------------------------------------------------------------
  // 魔杖菜单入口（MutationObserver 补挂，不用轮询）
  // -------------------------------------------------------------------------

  const WAND_ID = 'so-next-beat-wand-button';

  function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(WAND_ID) && menu.contains(document.getElementById(WAND_ID))) return true;

    // 已经存在于别处（被搬动过）→ 清掉重建
    const old = document.getElementById(WAND_ID);
    if (old) old.remove();

    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-compass"></i><span>下一拍建议</span>';
    item.addEventListener('click', () => togglePanel(true));
    menu.appendChild(item);
    return true;
  }

  function watchWandMenu() {
    if (!injectWandButton()) {
      // 菜单还没建 —— 用 MutationObserver 盯着 body，出现就挂
      const mo = new MutationObserver(() => {
        if (injectWandButton()) mo.disconnect();
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return;
    }
    // 菜单在了 —— 盯住它，被别的扩展重画时补挂
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
      const mo = new MutationObserver(() => { injectWandButton(); });
      mo.observe(menu, { childList: true, subtree: true });
    }
  }

  // -------------------------------------------------------------------------
  // 设置面板（ST 扩展设置区）
  // -------------------------------------------------------------------------

  function syncSettingsUI() {
    const s = loadSettings();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    set('so_next_beat_enabled', s.enabled);
    set('so_next_beat_chip', s.showChip);
    set('so_next_beat_toast', s.showToast);
    if (panelEl && panelEl.isConnected) {
      set('so-nb-panel-enabled', s.enabled);
      set('so-nb-panel-chip', s.showChip);
      set('so-nb-panel-toast', s.showToast);
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
        正文生成后自动生成「下一拍」的玩家指令建议
      </label>
      <label class="checkbox_label">
        <input id="so_next_beat_chip" type="checkbox">
        在对应回复下方显示建议
      </label>
      <label class="checkbox_label">
        <input id="so_next_beat_toast" type="checkbox">
        额外用右下角浮窗提示
      </label>
      <p style="opacity:0.7; font-size:0.85em;">
        也可以点输入框旁 🪄 菜单里的「下一拍建议」打开小窗口。
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
      });
    };
    bindToggle('so_next_beat_enabled', 'enabled');
    bindToggle('so_next_beat_chip', 'showChip');
    bindToggle('so_next_beat_toast', 'showToast');
  }

  // -------------------------------------------------------------------------
  // 等 story-oracle 就绪
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
      console.log('[next-beat] 已加载（v' + VERSION + '）');
    });
  });
})();
