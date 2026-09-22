// ============================================================================
// 故事神谕 · 下一拍建议（独立插件，不改 story-oracle 任何代码）
// v2.1.0
//
// 功能：
//   主聊天每收到一条新的 AI 回复后，本插件自动：
//     1) 通过 story-oracle 的 unsafe.eval 读到「当前正在引导的序列」以及
//        「当前 active 拍」的 goal（= 玩家接下来要开启的这一拍）；
//     2) 复用它自己那两个剥离函数（stripMechanismBlocks / stripReasoningTags）
//        得到干净的正文；
//     3) 调一次 story-oracle 已配置好的连接（api.run），让模型写出「一句最适合
//        玩家现在发送、能自然把剧情推进到本拍目标」的指令；
//     4) 把这句话贴在对应 AI 回复下方（chip）+ 悬浮窗同步显示，点一下即填入
//        输入框（不自动发送，可编辑）。
//
// v2.1.0 新增：
//   - 中心面板可拖动（按住标题栏拖）+ 位置记忆 + ⌖ 一键复位
//   - 面板手机适配：宽度 min(340px, 100vw-16px)、高度 dvh、顶部不贴边
//   - 悬浮窗（opt-in）：常驻一角，折叠成 🧭 圆标，收到新建议自己冒出来；
//     可拖动、位置记忆、有未读建议时呼吸光
//
// 关键修复（相对社区版 v1.2.0）：
//   - maxTokens 从 300 提到 4096 地板（300 会被 reasoning 模型的思考 token 吃光，
//     输出被截在半句——社区版实测 bug）；
//   - 用 unsafe.eval 复用 story-oracle 的剥离逻辑，不再自己手写正则；
//   - 读到 active 拍的 goal 并喂进 prompt，让建议能真正对上「下一拍」；
//   - 加 AbortController + 240s 超时；
//   - 加「同一楼只处理一次」的持久去重（存 chat_metadata，刷新后仍认得）；
//   - 加「最新一条生效」的并发控制；
//   - 加全量重挂（MESSAGE_SWIPED / MESSAGE_EDITED / MESSAGE_DELETED / CHAT_CHANGED）；
//   - lastSuggestion 按聊天隔离；
//   - 魔杖菜单入口改用 MutationObserver 补挂。
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const VERSION = '2.1.0';

  const DEFAULTS = {
    enabled: true,          // 每条新回复自动生成建议
    showChip: true,         // 在回复下方显示 chip
    showToast: false,       // 右下角 toast（默认关）
    showFloat: false,       // 悬浮窗（默认关，opt-in）
  };

  const MIN_OUTPUT_TOKENS = 4096;      // reasoning 模型思考也吃 max_tokens
  const REQUEST_TIMEOUT_MS = 240000;   // 与 story-oracle 本体一致
  const MIN_NARRATIVE_LEN = 10;

  const DONE_META_KEY = MODULE_ID + '_done';
  const DONE_KEEP_MAX = 400;

  let lastByChat = {};                 // { [chatKey]: { suggestion, beatInfo, messageId, at } }
  let panelEl = null;
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
  // 持久去重（存 chat_metadata，页面刷新后仍有效）
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

  function isDone(key) {
    return readDoneSet().has(key);
  }

  // -------------------------------------------------------------------------
  // unsafe.eval 封装
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

  // -------------------------------------------------------------------------
  // 复用 story-oracle 的剥离逻辑
  // -------------------------------------------------------------------------

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
  // 读序列状态
  // -------------------------------------------------------------------------

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
  // Prompt
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

    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ctl = new AbortController();
    currentAbort = ctl;
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, REQUEST_TIMEOUT_MS);

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
      text = text.replace(/^["“'「『]+/, '').replace(/["”'」』]+$/, '').trim();
      return text || null;
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
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

    const anchor = $mes.querySelector('.mes_text');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    } else {
      $mes.appendChild(chip);
    }
  }

  // -------------------------------------------------------------------------
  // 全量重挂 chip
  // -------------------------------------------------------------------------

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
  // lastSuggestion（按聊天隔离）
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

  function getLast() {
    return lastByChat[chatKey()] || null;
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
    const settings = loadSettings();

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
        <label class="checkbox_label so-nb-toggle-row">
          <input type="checkbox" id="so-nb-panel-float" ${settings.showFloat ? 'checked' : ''}>
          悬浮窗常驻（折叠成 🧭 圆标，收到新建议自己冒出来）
        </label>
        <p class="so-nb-panel-label-hint">拖动圆标 / 标题栏可移动；位置会记住。</p>
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

    // —— 位置记忆 ——
    (function applyStoredPos() {
      const p = loadPanelPos();
      if (!p) return;
      panelEl.style.left = p.left + 'px';
      panelEl.style.top = p.top + 'px';
      panelEl.style.transform = 'scale(0.96)';
    })();

    // —— 重置位置 ——
    panelEl.querySelector('#so-nb-panel-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      clearPanelPos();
      panelEl.style.left = '';
      panelEl.style.top = '';
      panelEl.style.transform = '';
    });

    // —— 拖动 ——
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
          const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          panelEl.addEventListener('click', swallow, { capture: true, once: true });
          setTimeout(() => panelEl.removeEventListener('click', swallow, { capture: true }), 300);
        }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();

    // —— 关闭 / 开关 ——
    panelEl.querySelector('.so-nb-panel-close').addEventListener('click', () => togglePanel(false));

    const bindToggle = (id, key) => {
      const el = panelEl.querySelector(id);
      el.addEventListener('change', function () {
        const s = loadSettings();
        s[key] = this.checked;
        saveSettings();
        syncSettingsUI();
        if (key === 'showChip') refreshChips();
        if (key === 'showFloat') applyFloatVisibility();
      });
    };
    bindToggle('#so-nb-panel-enabled', 'enabled');
    bindToggle('#so-nb-panel-chip', 'showChip');
    bindToggle('#so-nb-panel-toast', 'showToast');
    bindToggle('#so-nb-panel-float', 'showFloat');

    panelEl.querySelector('#so-nb-panel-use').addEventListener('click', () => {
      const entry = getLast();
      if (entry && entry.suggestion) {
        fillInput(entry.suggestion);
        togglePanel(false);
      } else {
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
          notifyFloatNewSuggestion(suggestion);
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
  // 悬浮窗（v2.1.0）
  // -------------------------------------------------------------------------

  const FLOAT_ID = 'so-nb-float';
  const FLOAT_POS_KEY = MODULE_ID + '_float_pos';
  let floatEl = null;
  let floatCollapsed = true;
  let floatFresh = false;

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
      <div class="so-nb-float-badge" title="🧭 下一拍建议（点开）">🧭</div>
      <div class="so-nb-float-body">
        <div class="so-nb-float-head" id="so-nb-float-drag-handle">
          <span class="so-nb-float-title">🧭 下一拍建议</span>
          <span class="so-nb-float-icon-btn" id="so-nb-float-collapse" title="折叠">—</span>
          <span class="so-nb-float-icon-btn" id="so-nb-float-close" title="关闭悬浮窗">×</span>
        </div>
        <div class="so-nb-float-content" id="so-nb-float-content">（暂无建议）</div>
        <div class="so-nb-float-actions">
          <button type="button" class="so-next-beat-btn so-next-beat-use" id="so-nb-float-use">使用这句</button>
          <button type="button" class="so-next-beat-btn" id="so-nb-float-regen">重生成</button>
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
      if (floatCollapsed) {
        setFloatCollapsed(false);
        floatFresh = false;
        floatEl.classList.remove('so-nb-float-fresh');
      }
    });

    floatEl.querySelector('#so-nb-float-collapse').addEventListener('click', () => setFloatCollapsed(true));
    floatEl.querySelector('#so-nb-float-close').addEventListener('click', () => setFloatVisible(false));

    floatEl.querySelector('#so-nb-float-use').addEventListener('click', () => {
      const entry = getLast();
      if (entry && entry.suggestion) {
        fillInput(entry.suggestion);
      } else {
        setFloatContent('（还没有建议——等一条新的正文回复，或点「重生成」）');
      }
    });

    floatEl.querySelector('#so-nb-float-regen').addEventListener('click', async () => {
      const btn = floatEl.querySelector('#so-nb-float-regen');
      const old = btn.textContent;
      btn.textContent = '生成中…';
      btn.disabled = true;
      try {
        const ctx = getCtx();
        if (!ctx || !ctx.chat || !ctx.chat.length) { setFloatContent('（找不到聊天）'); return; }
        let idx = -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
          const m = ctx.chat[i];
          if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) { idx = i; break; }
        }
        if (idx === -1) { setFloatContent('（找不到可用的 AI 回复）'); return; }
        const narrative = cleanNarrative(ctx.chat[idx].mes);
        if (!narrative || narrative.length < MIN_NARRATIVE_LEN) { setFloatContent('（这条回复没有可用的正文）'); return; }
        const beatInfo = getActiveBeatInfo();
        const suggestion = await requestNextBeatOption(narrative, beatInfo);
        if (suggestion) {
          setLast({ suggestion, beatInfo, messageId: idx });
          renderChip(idx, suggestion, beatInfo);
          showSuggestionToast(suggestion);
          setFloatContent(suggestion);
        } else {
          setFloatContent('（这次没能生成，看看浏览器控制台）');
        }
      } finally {
        btn.textContent = old;
        btn.disabled = false;
      }
    });

    wireFloatDrag();
    return floatEl;
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
    const el = floatEl.querySelector('#so-nb-float-content');
    if (el) el.textContent = text || '（暂无建议）';
  }

  function setFloatVisible(on) {
    const s = loadSettings();
    s.showFloat = !!on;
    saveSettings();
    syncSettingsUI();
    applyFloatVisibility();
  }

  function applyFloatVisibility() {
    const s = loadSettings();
    if (!s.showFloat) {
      if (floatEl) floatEl.classList.add('so-nb-float-hidden');
      return;
    }
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    const entry = getLast();
    if (entry && entry.suggestion) {
      setFloatContent(entry.suggestion);
      setFloatCollapsed(false);
    } else {
      setFloatContent('（暂无建议）');
      setFloatCollapsed(true);
    }
  }

  function notifyFloatNewSuggestion(suggestion) {
    const s = loadSettings();
    if (!s.showFloat) return;
    const el = ensureFloat();
    el.classList.remove('so-nb-float-hidden');
    setFloatContent(suggestion);
    if (floatCollapsed) {
      floatFresh = true;
      el.classList.add('so-nb-float-fresh');
    } else {
      floatFresh = false;
      el.classList.remove('so-nb-float-fresh');
    }
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

    if (isDone(key)) return;

    const narrative = cleanNarrative(m.mes);
    if (!narrative || narrative.length < MIN_NARRATIVE_LEN) return;

    markDone(key);

    const beatInfo = getActiveBeatInfo();
    const myKey = key;
    lastRequestKey = myKey;

    const suggestion = await requestNextBeatOption(narrative, beatInfo);

    if (lastRequestKey !== myKey) return;
    if (!suggestion) return;
    const cur = ctx.chat[messageId];
    if (!cur || ((cur.swipe_id || 0) !== swipeId)) return;

    setLast({ suggestion, beatInfo, messageId });
    renderChip(messageId, suggestion, beatInfo);
    showSuggestionToast(suggestion);
    notifyFloatNewSuggestion(suggestion);
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
  // 魔杖菜单入口
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
    item.addEventListener('click', () => togglePanel(true));
    menu.appendChild(item);
    return true;
  }

  function watchWandMenu() {
    if (!injectWandButton()) {
      const mo = new MutationObserver(() => {
        if (injectWandButton()) mo.disconnect();
      });
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
  // 设置面板
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
      <label class="checkbox_label">
        <input id="so_next_beat_float" type="checkbox">
        悬浮窗常驻（折叠成 🧭 圆标）
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
        if (key === 'showFloat') applyFloatVisibility();
      });
    };
    bindToggle('so_next_beat_enabled', 'enabled');
    bindToggle('so_next_beat_chip', 'showChip');
    bindToggle('so_next_beat_toast', 'showToast');
    bindToggle('so_next_beat_float', 'showFloat');
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
      applyFloatVisibility();
      console.log('[next-beat] 已加载（v' + VERSION + '）');
    });
  });
})();
