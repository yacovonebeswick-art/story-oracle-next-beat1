// ============================================================================
// 故事神谕 · 下一拍建议（配套扩展，独立文件，不修改 story-oracle 原版任何代码）
//
// 功能：
//   主聊天里“正文模型”写出新的一条回复后，本插件自动：
//     1) 识别出其中的“正文”内容（尽量剥掉状态栏/变量块/思维链等结构）；
//     2) 调用一次故事神谕自己已配置好的连接（经由官方 Hook API 的 api.run()），
//        让模型给出“一句最适合玩家现在发给 AI、能自然过渡到下一拍”的指令/发言；
//     3) 把这句建议显示在该条回复下方，点一下即可填入输入框（不会自动发送，
//        你可以先编辑再发）。
//
// 依赖：story-oracle 在 1.21.0+ 暴露的 window.StoryOracleAPI（及 story-oracle-ready 事件）。
//   参考文档：仓库 docs/superpowers/specs/2026-07-05-story-oracle-hook-api-design.md
//
// ⚠ 重要说明：
//   我没能拿到 story-oracle 的实际源码，所以下面对 api.run() 的调用方式是按 README
//   里“逃生阀 api.run() + api.appendReply()（onSend 覆盖不到时才用）”这句描述做的
//   最合理猜测：假设 api.run(promptText) 返回一个 Promise，resolve 出模型回复的文本
//   （或一个带 text/content 字段的对象）。如果实际签名不同，请把仓库里那份
//   hook-api-design.md 贴给我，我可以按真实签名精确改掉 requestNextBeatOption() 这一处。
// ============================================================================

(function () {
  'use strict';

  const MODULE_ID = 'story-oracle-next-beat';
  const DEFAULTS = { enabled: true };

  function getCtx() {
    return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
      ? SillyTavern.getContext()
      : null;
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

  // ---- 第一步：从原始回复里剥出“正文” ----------------------------------
  function stripStructure(raw) {
    if (!raw) return '';
    let text = raw;

    // 常见正文包裹标签，优先只取里面的内容
    const wrap = text.match(/<(content|正文|gametxt|narrative)>([\s\S]*?)<\/\1>/i);
    if (wrap) text = wrap[2];

    text = text
      // 思维链
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
      // 变量更新区块（各种写法都尽量兜一下）
      .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
      .replace(/<JSONPatch[^>]*>[\s\S]*?<\/JSONPatch>/gi, '')
      .replace(/<update>[\s\S]*?<\/update>/gi, '')
      // 参谋方案块（防止误把幕后指令当正文）
      .replace(/<StoryPlan>[\s\S]*?<\/StoryPlan>/gi, '')
      // 图片生成标记
      .replace(/\[IMG_GEN\][\s\S]*?\[\/IMG_GEN\]/gi, '')
      // 剩余的 HTML/状态面板标签，整体去掉（只留文字）
      .replace(/<[a-zA-Z!][^>]*>/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }

  // ---- 第二步：调用一次 API，生成“下一拍”玩家指令建议 -------------------
  async function requestNextBeatOption(narrativeText) {
    const api = window.StoryOracleAPI;
    if (!api || typeof api.run !== 'function') {
      console.warn(`[${MODULE_ID}] 未检测到可用的 StoryOracleAPI.run，跳过本次建议`);
      return null;
    }

    const prompt =
      '下面是主线剧情刚刚写出的一段正文（已尽量去除状态栏/变量等结构内容），' +
      '只把它当参考，不要复述或评论它：\n\n' +
      '"""\n' + narrativeText.slice(-4000) + '\n"""\n\n' +
      '请只给出一句话：这句话是“玩家”接下来最适合发送给 AI 的指令或发言，' +
      '要能让剧情顺着刚才这段正文的走向，自然过渡到下一拍。' +
      '直接写出这句话本身（可以是角色的行动、台词，也可以是简短的旁白式指令），' +
      '不要解释、不要加引号、不要编号、不要任何前后缀说明。';

    try {
      const result = await api.run(prompt);
      let text = '';
      if (typeof result === 'string') {
        text = result;
      } else if (result && typeof result === 'object') {
        text = result.text || result.content || result.reply || '';
      }
      text = String(text || '').trim();
      // 去掉模型可能自己加的引号
      text = text.replace(/^["“'「]+/, '').replace(/["”'」]+$/, '').trim();
      return text || null;
    } catch (err) {
      console.error(`[${MODULE_ID}] 调用失败：`, err);
      return null;
    }
  }

  // ---- 第三步：把建议显示在这条回复下面 ---------------------------------
  function renderSuggestionChip(messageId, suggestionText) {
    const $mes = $(`.mes[mesid="${messageId}"]`);
    if (!$mes.length) return;

    $mes.find('.so-next-beat-chip').remove();

    const $chip = $('<div class="so-next-beat-chip" title="点一下：填入输入框，可编辑后再发送"></div>');
    $chip.append('🧭 下一拍建议：');
    $chip.append($('<span class="so-next-beat-text"></span>').text(suggestionText));

    $chip.on('click', () => {
      const $input = $('#send_textarea');
      if ($input.length) {
        $input.val(suggestionText).trigger('input').focus();
      }
    });

    const $target = $mes.find('.mes_block .mes_text').first();
    if ($target.length) {
      $target.after($chip);
    } else {
      $mes.append($chip);
    }
  }

  // ---- 事件绑定：主聊天每来一条新的 AI 回复就跑一次 -----------------------
  const processedKeys = new Set();

  function shouldProcessMessage(ctx, messageId) {
    const msg = ctx.chat && ctx.chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return false;
    return true;
  }

  async function onCharacterMessageRendered(messageId) {
    const settings = loadSettings();
    if (!settings.enabled) return;

    const ctx = getCtx();
    if (!ctx || !shouldProcessMessage(ctx, messageId)) return;

    const msg = ctx.chat[messageId];
    const swipeId = msg.swipe_id || 0;
    const key = `${ctx.chatId || ''}:${messageId}:${swipeId}`;
    if (processedKeys.has(key)) return;
    processedKeys.add(key);

    const narrative = stripStructure(msg.mes);
    if (!narrative || narrative.length < 10) return;

    const suggestion = await requestNextBeatOption(narrative);
    if (suggestion) {
      renderSuggestionChip(messageId, suggestion);
    }
  }

  function bindEvents() {
    const ctx = getCtx();
    if (!ctx || !ctx.eventSource || !ctx.event_types) {
      setTimeout(bindEvents, 500);
      return;
    }
    ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  }

  // ---- 设置面板：一个开关，默认开 ----------------------------------------
  function addSettingsUI() {
    const settings = loadSettings();
    const html = `
      <div class="so-next-beat-settings">
        <h4>🧭 下一拍建议（配套故事神谕，独立扩展）</h4>
        <label class="checkbox_label">
          <input id="so_next_beat_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
          正文生成后自动建议一句“下一拍”的玩家指令
        </label>
      </div>
    `;
    const $container = $('#extensions_settings2, #extensions_settings').first();
    if ($container.length) {
      $container.append(html);
      $('#so_next_beat_enabled').on('change', function () {
        const s = loadSettings();
        s.enabled = $(this).prop('checked');
        saveSettings();
      });
    }
  }

  function waitForStoryOracle(callback) {
    if (window.StoryOracleAPI) {
      callback();
      return;
    }
    window.addEventListener('story-oracle-ready', callback, { once: true });
    // 兜底：万一事件在本脚本加载前就已触发过
    setTimeout(() => {
      if (window.StoryOracleAPI) callback();
    }, 3000);
  }

  jQuery(async () => {
    waitForStoryOracle(() => {
      const api = window.StoryOracleAPI;
      if (!api) {
        console.warn(`[${MODULE_ID}] 没有检测到故事神谕（StoryOracleAPI），本扩展不生效`);
        return;
      }
      if (typeof api.isCompatible === 'function' && !api.isCompatible(1)) {
        console.warn(`[${MODULE_ID}] 故事神谕接口版本不兼容，本扩展跳过`);
        return;
      }
      addSettingsUI();
      bindEvents();
      console.log(`[${MODULE_ID}] 已加载`);
    });
  });
})();
