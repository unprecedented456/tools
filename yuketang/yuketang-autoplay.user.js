// ==UserScript==
// @name         雨课堂 · 2倍速静音连播
// @namespace    local.yuketang.playback
// @version      1.3.5
// @description  自动播放、2倍速、静音，视频自然结束后点击下一节；保留网站自身的进度处理。
// @match        https://*.yuketang.cn/*
// @match        https://yuketang.cn/*
// @match        https://yuketang.tsinghua.edu.cn/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    speed: 2,
    endWaitMs: 15000, // 留给网站处理 ended、保存进度；这不是上报成功的确认。
    pollMs: 1000,
    startupWaitMs: 4000,
    resumeDelayMs: 2000,
    resumeRetryMs: 3000,
    menuWaitMs: 6000,
    // 已知页面结构时可填写 CSS 选择器，例如 ['button[aria-label="下一视频"]']。
    nextSelectors: [],
  };
  const storageKey = `next-selector:${location.origin}`;
  const controlsKey = `player-controls:${location.origin}`;
  const storedControls = GM_getValue(controlsKey, {});
  let controls = storedControls && typeof storedControls === 'object' ? storedControls : {};
  let enabled = true;
  let autoResume = true;
  let selecting = false;
  let speed = CONFIG.speed;
  let state = null;
  let message = '等待页面出现视频';
  let lastTickAt = null;
  let lastError = null;
  let feedbackUntil = 0;
  const recentMessages = [];
  const debugEvents = [];
  const controlInputEvents = [];
  const inputObserved = new WeakSet();
  let lastSampleAt = 0;
  let lastFaultKey = '';
  let stateId = 0;
  let nonVideoRoute = '';
  let nonVideoSince = 0;
  let nonVideoAdvanced = false;
  let catalogHint = null;
  let lastCatalogCheckAt = -Infinity;
  let savedSelector = GM_getValue(storageKey, '');
  const observed = new WeakSet();

  const host = document.createElement('div');
  host.id = 'ykt-autoplay-assistant';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { position:fixed; right:16px; bottom:16px; z-index:2147483647; color-scheme:light; }
      * { box-sizing:border-box; } [hidden] { display:none!important; }
      section { width:300px; max-width:calc(100vw - 24px); max-height:calc(100vh - 32px); overflow:auto;
        border:1px solid #dce3df; border-radius:16px; background:#fff; color:#22332c;
        font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
        box-shadow:0 12px 40px #183b2522; }
      header { display:flex; align-items:center; gap:9px; padding:15px 16px; }
      strong { font-size:15px; font-weight:650; } #badge { margin-left:auto; color:#24734a; font-size:11px; }
      button { cursor:pointer; font:inherit; border:1px solid #dce3df; border-radius:8px;
        padding:8px 10px; background:#fff; color:#30473a; transition:background .15s; }
      button:hover { background:#f0f5f2; } button:focus-visible,input:focus-visible,summary:focus-visible { outline:2px solid #39805a; outline-offset:2px; }
      #collapse { border:0; padding:0 3px; font-size:19px; color:#79867e; line-height:24px; }
      .content { padding:0 16px 14px; } .state { padding:12px; border-radius:10px; background:#f2f7f4; }
      #actual { margin:0; font-weight:650; color:#1f6341; font-size:14px; }
      #status { margin:5px 0 0; font-size:12px; color:#697a70; overflow-wrap:anywhere; }
      #feedback { margin:0 16px 12px; padding:9px 12px; border-radius:8px; background:#eaf5ee; color:#21613f; font-size:12px; }
      #feedback[data-kind="error"] { background:#fff0eb; color:#9b4227; }
      #setup-result { margin:7px 0 0; font-size:12px; color:#627368; }
      .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:12px 0; }
      #toggle,.primary { background:#27764e; color:white; border-color:#27764e; }
      #toggle:hover,.primary:hover { background:#1e6340; }
      .row { display:flex; align-items:center; justify-content:space-between; min-height:38px; }
      #speed { padding:3px 12px; font-weight:650; } input[type=checkbox] { accent-color:#27764e; width:17px; height:17px; cursor:pointer; }
      .note { color:#7c8981; font-size:11px; margin:8px 0 0; }
      details { border-top:1px solid #e9eeeb; padding-top:10px; margin-top:10px; }
      summary { cursor:pointer; color:#627368; font-size:12px; }
      .setup { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:10px; }
      .setup button { font-size:12px; padding:7px 6px; }
      .debug-actions { display:flex; gap:8px; margin-top:10px; }
      .debug-actions button { flex:1; font-size:12px; }
      textarea { width:100%; height:180px; margin-top:10px; border:1px solid #dce3df; border-radius:8px;
        padding:8px; background:#f8faf9; color:#22332c; font:10px/1.5 monospace; resize:vertical; }
    </style>
    <section aria-label="雨课堂连播助手">
      <header><strong>雨课堂连播</strong><span id="badge">运行中</span>
        <button id="collapse" aria-label="收起面板" aria-expanded="true">−</button></header>
      <p id="feedback" role="status" aria-live="polite" hidden></p>
      <div class="content" id="panel-body">
        <div class="state"><p id="actual">等待视频</p><p id="status" aria-live="polite"></p><p id="setup-result">等待验证播放设置</p></div>
        <div class="actions"><button id="toggle">暂停</button><button id="resume">继续播放</button></div>
        <div class="row"><span>播放速度</span><button id="speed" title="点击切换1倍速或2倍速">2×</button></div>
        <label class="row" for="auto-resume"><span>暂停后自动恢复</span><input id="auto-resume" type="checkbox" checked></label>
        <p class="note">静音连播 · 自动跳过作业和考试</p>
        <details><summary>播放器适配</summary><p class="note" id="memory">控件设置自动保存，刷新或换视频后复用。</p>
          <div class="setup"><button id="mark-rate">设置倍速控件</button><button id="mark-mute">设置静音控件</button>
          <button id="pick-catalog">识别当前目录项</button><button id="pick">设置下一节按钮</button></div>
        </details>
        <details><summary>问题反馈</summary><p class="note">调试已自动开启。出问题后导出文件发给我即可。</p>
          <div class="debug-actions"><button class="primary" id="export-debug">导出调试文件</button><button id="diagnose">查看记录</button></div>
          <textarea id="diagnostics" aria-label="脚本诊断信息" readonly hidden></textarea>
          <p class="note">v1.3.5 · 学习进度以课程页面为准</p>
        </details>
      </div>
    </section>`;
  document.documentElement.append(host);
  const statusNode = shadow.getElementById('status');
  const toggleNode = shadow.getElementById('toggle');
  const speedNode = shadow.getElementById('speed');
  function feedback(text, kind = 'success') {
    const node = shadow.getElementById('feedback');
    node.textContent = text;
    node.setAttribute('data-kind', kind);
    node.hidden = false;
    feedbackUntil = Date.now() + 8000;
    trace('feedback', { text, kind });
  }
  function memorySummary() {
    const labels = [];
    if (controls.rateMenu || controls.rate2) labels.push('倍速');
    if (controls.mute) labels.push('静音');
    if (savedSelector) labels.push('下一节');
    shadow.getElementById('memory').textContent = labels.length
      ? `已记住：${labels.join('、')}。刷新或换视频后自动复用。`
      : '控件设置自动保存，刷新或换视频后复用。';
    shadow.getElementById('mark-rate').textContent = controls.rateMenu || controls.rate2 ? '重新设置倍速' : '设置倍速控件';
    shadow.getElementById('mark-mute').textContent = controls.mute ? '重新设置静音' : '设置静音控件';
    shadow.getElementById('pick').textContent = savedSelector ? '重新设置下一节' : '设置下一节按钮';
  }
  function saveControls(updates) {
    const next = { ...controls, ...updates };
    if (JSON.stringify(next) === JSON.stringify(controls)) return true;
    try {
      GM_setValue(controlsKey, next);
      controls = next;
      memorySummary();
      trace('controls.saved', { kinds: Object.keys(updates) });
      return true;
    } catch (error) {
      trace('controls.save.error', { name: error.name });
      feedback('控件设置未能保存，请检查油猴存储权限', 'error');
      return false;
    }
  }
  function rememberXtControls(s, menu) {
    if (!menu.xt) return;
    const doc = s.video.ownerDocument;
    const updates = {};
    for (const [kind, selector, target] of [
      ['rateMenu', 'xt-speedbutton xt-speedvalue', menu.opener],
      ['rate2', 'xt-speedbutton li[data-speed="2"]', menu.option],
    ]) {
      const matches = [...doc.querySelectorAll(selector)];
      if (target && matches.length === 1 && matches[0] === target) updates[kind] = selector;
    }
    // 扬声器图标由网站自己的点击事件处理，刷新后也无需再标记。
    const mute = [...doc.querySelectorAll('xt-volumebutton xt-icon')];
    if (mute.length === 1) updates.mute = 'xt-volumebutton xt-icon';
    if (Object.keys(updates).length) saveControls(updates);
  }
  function verifySettings() {
    if (feedbackUntil && Date.now() >= feedbackUntil) {
      shadow.getElementById('feedback').hidden = true;
      feedbackUntil = 0;
    }
    const result = shadow.getElementById('setup-result');
    if (!state?.initialized) { result.textContent = '等待验证播放设置'; return; }
    const s = state, v = s.video;
    if (!enabled || selecting) return;
    const applied = v.playbackRate === speed && (v.muted || v.volume === 0);
    if (!applied) {
      if (s.settingsConfirmed) feedback('播放设置发生变化，正在重新应用', 'error');
      s.settingsConfirmed = false;
      s.settingsReadyAt = null;
      result.textContent = '设置尚未生效 · 正在尝试应用';
      return;
    }
    if (s.settingsReadyAt == null) s.settingsReadyAt = Date.now();
    if (Date.now() - s.settingsReadyAt < 1000) { result.textContent = '正在确认倍速和静音'; return; }
    result.textContent = `设置成功 · ${speed}倍速 · 静音`;
    if (!s.settingsConfirmed) {
      s.settingsConfirmed = true;
      trace('settings.confirmed', { media: mediaState(v) });
      feedback(`设置成功：${speed}倍速、静音已生效`);
    }
  }
  function mediaState(video) {
    return video ? {
      paused: video.paused, ended: video.ended, seeking: video.seeking,
      readyState: video.readyState, playbackRate: video.playbackRate,
      muted: video.muted, volume: video.volume,
      currentTime: Math.round((video.currentTime || 0) * 10) / 10,
      errorCode: video.error?.code || null,
    } : null;
  }
  function trace(event, data = {}) {
    debugEvents.push({ at: Date.now(), event, stateId: state?.id || null, ...data });
    if (debugEvents.length > 400) debugEvents.shift();
  }
  function playbackStatus(video) {
    return `${video.paused ? '已暂停' : '播放中'} · 实际${video.playbackRate}倍速 · ${video.muted || video.volume === 0 ? '静音' : '有声音'}`;
  }
  function status(text) {
    if (message !== text) {
      recentMessages.push({ at: Date.now(), text });
      if (recentMessages.length > 20) recentMessages.shift();
      trace('status', { text });
    }
    message = text;
    const displayText = /^播放中 · 实际/.test(text) ? '将按目录顺序连播下一个视频' : text;
    if (statusNode.textContent !== displayText) statusNode.textContent = displayText;
  }

  // 只读取主文档及允许访问的同源 iframe，不绕过跨域限制。
  function documents() {
    const result = [];
    function collect(doc) {
      if (!doc || result.includes(doc)) return;
      result.push(doc);
      observeControlInput(doc);
      for (const frame of doc.querySelectorAll('iframe')) {
        try { collect(frame.contentDocument); } catch { /* 跨域 iframe */ }
      }
    }
    collect(document);
    return result;
  }
  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    // 父列表 opacity:0 时，li 自身的 opacity 仍然为1。
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (el.ownerDocument.defaultView.getComputedStyle(parent).opacity === '0') return false;
    }
    return true;
  }
  function available(el) {
    return visible(el) && !el.disabled && !el.closest('[disabled], [aria-disabled="true"], .is-disabled, .disabled');
  }
  function source(video) {
    return video.currentSrc || video.src || video.querySelector('source')?.src || '';
  }
  function current(s) {
    return enabled && s === state && s.video.isConnected &&
      s.route === location.href && s.source === source(s.video);
  }
  function pickVideo(docs) {
    const candidates = docs.flatMap(doc => [...doc.querySelectorAll('video')]).filter(visible);
    // 同时出现多个播放器时，优先已经播放的，再选面积最大的。
    return candidates.sort((a, b) => {
      const playing = v => !v.paused && !v.ended ? 1 : 0;
      const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
      return playing(b) - playing(a) || area(b) - area(a);
    })[0] || null;
  }
  function markedControl(s, selector, allowHidden = false) {
    if (!selector) return null;
    try {
      const matches = [...s.video.ownerDocument.querySelectorAll(selector)].filter(el => allowHidden
        ? el.isConnected && !el.disabled && !el.closest('[disabled], [aria-disabled="true"], .is-disabled, .disabled')
        : available(el));
      if (matches.length !== 1 || matches[0] === s.video || matches[0].contains?.(s.video)) return null;
      return matches[0];
    } catch { return null; }
  }
  function isTwoSpeed(el) {
    return /^(?:[✓✔√]?2(?:\.0+)?(?:[x×]|倍(?:速)?)|2\.0+)[✓✔√]?$/i.test((el.textContent || '').replace(/\s/g, ''));
  }
  function labelElement(target, match) {
    for (let el = target, depth = 0; el && depth < 4; el = el.parentElement, depth++) {
      if (match(el)) return el;
    }
    return null;
  }
  function twoSpeedOption(s, searchExpanded = false) {
    // 隐藏选项不能代表菜单已展开；播放器可能通过 innerText 读取选项。
    const marked = markedControl(s, controls.rate2);
    if (marked && isTwoSpeed(marked)) return marked;
    if (!searchExpanded) return null;
    const candidates = [...s.video.ownerDocument.querySelectorAll('li, [role="option"], [role="menuitem"], button, span, div')]
      .filter(el => available(el) && isTwoSpeed(el));
    const leaves = candidates.filter(el => !candidates.some(other => other !== el && el.contains?.(other)));
    return leaves.length === 1 ? leaves[0] : null;
  }
  function speedMenu(s) {
    const doc = s.video.ownerDocument;
    let opener = markedControl(s, controls.rateMenu, true);
    if (opener?.localName !== 'xt-speedvalue') {
      const candidates = [...doc.querySelectorAll('xt-speedvalue')].filter(el => el.isConnected);
      if (candidates.length === 1) opener = candidates[0];
    }
    if (opener?.localName !== 'xt-speedvalue') return { opener, xt: false };
    // XT 的文字入口和上拉列表是兄弟节点。只在这个小控件内查找，避免误选其他播放器。
    for (let root = opener.parentElement, depth = 0; root && depth < 6; root = root.parentElement, depth++) {
      if (root.contains(s.video) || ['body', 'html'].includes(root.localName)) break;
      const options = [...root.querySelectorAll('li, [role="option"], [role="menuitem"]')].filter(isTwoSpeed);
      if (options.length === 1) return { opener, root, option: options[0], xt: true };
    }
    return { opener, xt: true };
  }
  function releaseRateMenu(s) {
    for (const { el, changes } of s?.rateMenuStyles || []) {
      for (const change of changes) {
        // 网站已自行修改过的样式不回滚。
        if (el.style.getPropertyValue(change.name) !== change.applied || el.style.getPropertyPriority(change.name) !== 'important') continue;
        if (change.value) el.style.setProperty(change.name, change.value, change.priority);
        else el.style.removeProperty(change.name);
      }
    }
    if (s) s.rateMenuStyles = [];
  }
  function expandXtMenu(s, menu) {
    if (!menu.xt || !menu.root || !menu.option || available(menu.option)) return;
    const before = controlChain(menu.option, menu.root);
    // dispatchEvent 不会产生 CSS :hover。临时显示这个已确认属于倍速控件的列表，
    // 再点击网站原有选项；不修改播放器内部对象或伪造速度/学习进度。
    for (let el = menu.option.parentElement; el; el = el.parentElement) {
      const css = el.ownerDocument.defaultView.getComputedStyle(el);
      const values = { visibility: 'visible', opacity: '1', 'pointer-events': 'auto' };
      if (css.display === 'none') values.display = 'block';
      if (css.height === '0px') { values.height = 'auto'; values['max-height'] = 'none'; }
      if (css.overflow === 'hidden') values.overflow = 'visible';
      let record = s.rateMenuStyles.find(item => item.el === el);
      if (!record) { record = { el, changes: [] }; s.rateMenuStyles.push(record); }
      for (const [name, value] of Object.entries(values)) {
        if (!record.changes.some(change => change.name === name)) record.changes.push({ name,
          value: el.style.getPropertyValue(name), priority: el.style.getPropertyPriority(name), applied: value });
        el.style.setProperty(name, value, 'important');
      }
      if (el === menu.root) break;
    }
    trace('menu.expand', { before, after: controlChain(menu.option, menu.root), visible: available(menu.option) });
  }
  function controlChain(el, stop) {
    const result = [];
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (['body', 'html'].includes(el.localName) || el.contains?.(state?.video)) break;
      const css = el.ownerDocument.defaultView.getComputedStyle(el);
      result.push({ tag: el.localName, className: String(el.className || '').slice(0, 160), visible: visible(el),
        display: css.display, visibility: css.visibility, opacity: css.opacity, height: css.height,
        overflow: css.overflow, pointerEvents: css.pointerEvents });
      if (el === stop) break;
    }
    return result;
  }
  function hoverMenu(menu) {
    const view = menu.ownerDocument.defaultView;
    if (!view.MouseEvent || !menu.dispatchEvent) return;
    const position = inputPosition(menu);
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      menu.dispatchEvent(new view.MouseEvent(type, { ...position, bubbles: type !== 'mouseenter', cancelable: true, view }));
    }
    trace('menu.hover', { target: controlInfo(menu), position });
  }
  function inputPosition(el) {
    const rect = el.getBoundingClientRect();
    return { clientX: (rect.left || 0) + rect.width / 2, clientY: (rect.top || 0) + rect.height / 2, button: 0, buttons: 0 };
  }
  function observeControlInput(doc) {
    if (inputObserved.has(doc)) return;
    inputObserved.add(doc);
    let lastMoveAt = 0;
    const record = event => {
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      const root = target?.closest?.('xt-speedbutton');
      if (!root || root.localName !== 'xt-speedbutton') return;
      if (event.type === 'mousemove') {
        if (Date.now() - lastMoveAt < 500) return;
        lastMoveAt = Date.now();
      }
      const entry = { at: Date.now(), stateId: state?.id || null, type: event.type, trusted: event.isTrusted === true,
        button: event.button, buttons: event.buttons, which: event.which, detail: event.detail,
        clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType,
        target: controlInfo(target), path: (event.composedPath?.() || []).slice(0, 4).map(el => el.localName).filter(Boolean) };
      controlInputEvents.push(entry);
      if (controlInputEvents.length > 80) controlInputEvents.shift();
      Promise.resolve().then(() => { entry.defaultPrevented = event.defaultPrevented; });
    };
    for (const type of ['pointerover', 'pointerdown', 'pointerup', 'mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      doc.addEventListener(type, record, true);
    }
  }
  function controlInfo(el) {
    return el ? { tag: el.localName, className: String(el.className || '').slice(0, 160),
      role: el.getAttribute('role'), text: (el.textContent || '').trim().slice(0, 45), visible: visible(el),
      dataSpeed: el.getAttribute('data-speed'), keyt: el.getAttribute('keyt') } : null;
  }
  function selectRateOption(s, option) {
    const parent = option.closest('li, [role="option"], [role="menuitem"], [data-rate], [data-speed]');
    const target = parent && isTwoSpeed(parent) ? parent : option;
    if (!available(target)) {
      trace('menu.option.blocked', { reason: 'hidden-or-disabled', target: controlInfo(target) });
      return;
    }
    trace('menu.option.click', { attempt: s.rateUiAttempts, target: controlInfo(target), input: 'positioned-pointer-mouse' });
    s.rateCheckAt = Date.now() + 800;
    const view = target.ownerDocument.defaultView;
    if (target.dispatchEvent && view.MouseEvent) {
      // 先移动到已展开的选项，再发送左键按下/松开。click() 自身没有这个过程，
      // 默认 MouseEvent 的坐标、detail、buttons 也均为0。
      const root = target.closest('xt-speedbutton');
      if (root?.localName === 'xt-speedbutton') hoverMenu(root);
      const position = inputPosition(target);
      const enterPosition = { ...position };
      if (root?.localName === 'xt-speedbutton') {
        // XT speed() 的 mouseover 记录坐标，mousemove 计算位移 a，click 要求 a 非零。
        // 进入和移动若使用同一点，a 会被设为0，选项虽然可见也不会改变播放器状态。
        const rect = target.getBoundingClientRect();
        if (rect.width >= 8) enterPosition.clientX -= 2;
        else enterPosition.clientY -= Math.min(2, rect.height / 4);
        trace('menu.motion', { enter: enterPosition, move: position,
          distance: Math.hypot(position.clientX - enterPosition.clientX, position.clientY - enterPosition.clientY) });
      }
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const pointer = type.startsWith('pointer');
        if (pointer && !view.PointerEvent) continue;
        const EventType = pointer ? view.PointerEvent : view.MouseEvent;
        const pressed = type === 'pointerdown' || type === 'mousedown';
        const point = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'].includes(type) ? enterPosition : position;
        target.dispatchEvent(new EventType(type, { ...point, bubbles: !['pointerenter', 'mouseenter'].includes(type), cancelable: true,
          composed: true, view, buttons: pressed ? 1 : 0, detail: ['mousedown', 'mouseup', 'click'].includes(type) ? 1 : 0,
          ...(pointer ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {}) }));
      }
    } else target.click();
  }
  function setRateProperties(s, reason) {
    if (s.rateDirectAttempts >= 3) return;
    s.rateDirectAttempts += 1;
    try {
      s.video.defaultPlaybackRate = speed;
      s.video.playbackRate = speed;
      trace('rate.property.write', { reason, attempt: s.rateDirectAttempts, media: mediaState(s.video) });
    } catch (error) {
      trace('rate.property.error', { reason, name: error.name });
    }
  }
  function nativeSettings(s) {
    const v = s.video;
    const now = Date.now();
    const menu = speedMenu(s);
    rememberXtControls(s, menu);
    if (controls.mute && !v.muted && v.volume !== 0 && s.muteUiAttempts < 3 && now >= s.nextMuteUiAt) {
      const button = markedControl(s, controls.mute);
      if (button) {
        s.muteUiAttempts += 1;
        s.nextMuteUiAt = now + 3000;
        trace('mute.click', { attempt: s.muteUiAttempts, media: mediaState(v) });
        button.click();
      } else status('静音按钮标记已失效或被隐藏，请显示播放器控制栏或重新标记');
    }
    s.rateUiKind = menu.xt ? 'xt' : 'marked';
    if (speed !== 2 || (!controls.rate2 && !controls.rateMenu && !menu.xt)) return;
    if (s.rateCheckAt && now >= s.rateCheckAt) {
      s.rateCheckAt = 0;
      trace('rate.verify', { applied: v.playbackRate === speed, media: mediaState(v) });
      releaseRateMenu(s);
      if (v.playbackRate !== speed) {
        if (!menu.xt) setRateProperties(s, 'menu-did-not-change-rate');
        else status('倍速菜单操作后仍为1倍速，已记录控件结构供排查');
      }
    }
    if (v.playbackRate === 2) { s.rateUiPending = false; return; }
    if (s.rateUiPending) {
      if (now - s.rateUiOpenedAt < 200) return;
      expandXtMenu(s, menu);
      const option = menu.xt ? (available(menu.option) ? menu.option : null) : twoSpeedOption(s, true);
      if (option) {
        s.rateUiPending = false;
        s.nextRateUiAt = now + 3000;
        selectRateOption(s, option);
      }
      if (s.rateUiPending && now - s.rateUiOpenedAt >= CONFIG.menuWaitMs) {
        s.rateUiPending = false;
        s.nextRateUiAt = now + 3000;
        trace('menu.timeout', { attempt: s.rateUiAttempts, chain: controlChain(menu.option || menu.opener) });
        releaseRateMenu(s);
        status('未找到已标记的2倍速选项，请显示控制栏或重新标记');
      }
      return;
    }
    if (s.rateUiAttempts >= 3 || now < s.nextRateUiAt) return;
    const option = menu.xt ? (available(menu.option) ? menu.option : null) : twoSpeedOption(s);
    if (option) {
      s.rateUiAttempts += 1;
      s.nextRateUiAt = now + 3000;
      selectRateOption(s, option);
    } else if (menu.opener && (menu.xt || available(menu.opener))) {
      // 下一轮再选择选项，兼容菜单异步挂载。通过网站自身事件同步播放器状态。
      s.rateUiAttempts += 1;
      s.rateUiPending = true;
      s.rateUiOpenedAt = now;
      trace('menu.opener.click', { target: controlInfo(menu.opener), kind: s.rateUiKind });
      menu.opener.click();
      hoverMenu(menu.opener);
      if (menu.xt && menu.root) hoverMenu(menu.root);
      expandXtMenu(s, menu);
    } else status('倍速菜单标记已失效或被隐藏，请显示控制栏或重新标记');
  }
  function configure(s) {
    if (!current(s) || selecting || !s.initialized) return;
    const v = s.video;
    nativeSettings(s);
    // 标记后优先走网站控件，避免只改video属性却被播放器内部状态覆盖。
    if (!controls.mute) {
      v.muted = true;
      v.defaultMuted = true;
    }
    // 不循环播放，确保浏览器正常产生 ended。
    v.loop = false;
    if ((speed === 2 && (controls.rate2 || controls.rateMenu || s.rateUiKind === 'xt')) || s.rateLimited || v.playbackRate === speed) return;
    try {
      v.defaultPlaybackRate = speed;
      v.playbackRate = speed;
    } catch {
      s.rateLimited = true;
      status('播放器拒绝设置倍速，保留页面允许的速度');
    }
  }
  async function play(s, userGesture = false, recovery = false) {
    if (!current(s) || s.pending || s.video.ended || s.endedAt !== null) return;
    if (!userGesture && (!s.initialized || s.blocked || s.manualPause ||
      (!recovery && (s.started || s.attempted)) || Date.now() < s.nextResumeAt)) return;
    if (s.video.readyState < 2 || s.video.seeking || s.video.error) return;
    s.pending = true;
    s.attempted = true;
    s.nextResumeAt = Date.now() + CONFIG.resumeRetryMs;
    trace(recovery ? 'watchdog.resume' : 'play.attempt', { media: mediaState(s.video) });
    try {
      configure(s);
      await s.video.play();
      if (current(s)) {
        s.blocked = false;
        s.manualPause = false;
        s.started = true;
        trace('play.resolved', { media: mediaState(s.video) });
        status(playbackStatus(s.video));
      }
    } catch (error) {
      if (current(s)) {
        trace('play.rejected', { name: error.name, media: mediaState(s.video) });
        if (error.name === 'AbortError') {
          s.blocked = false;
          s.attempted = false;
          status('播放器正在加载或切换，稍后重试播放');
          return;
        }
        s.blocked = true;
        status(error.name === 'NotAllowedError'
          ? '浏览器阻止自动播放，请点“继续播放”'
          : `播放未能启动：${error.name}；页面就绪后点“继续播放”`);
      }
    } finally { s.pending = false; }
  }

  function routeResourceType(url) {
    const match = String(url).match(/\/(video|homework|assignment|exercise|exam|examination|test)(?:\/|[?#]|$)/i);
    if (!match) return null;
    return match[1].toLowerCase() === 'video' ? 'video' : /exam|test/i.test(match[1]) ? 'exam' : 'assignment';
  }
  function catalogSnapshot(docs) {
    const entries = [];
    const sidebarSelector = 'aside, nav, [role="tree"], [class*="catalog"], [class*="directory"], [class*="sidebar"]';
    for (const doc of docs) {
      const video = doc.querySelector('video');
      const videoLeft = video?.getBoundingClientRect().left;
      const raw = [...doc.querySelectorAll('a[href], [data-resource-type], [data-leaf-type], [role="treeitem"], li, [class*="leaf"], [class*="resource"], [class*="task"]')];
      const badges = [...doc.querySelectorAll('span, small, em, i, div')]
        .filter(el => /^(视频|作业|考试)$/.test((el.textContent || '').trim()));
      for (const badge of badges) {
        let row = badge.parentElement;
        for (let depth = 0; row && depth < 2 && (row.textContent || '').trim() === (badge.textContent || '').trim(); depth++) row = row.parentElement;
        if (row) raw.push(row);
      }
      for (const row of new Set(raw)) {
        if (!row.isConnected || row === host || host.contains(row) || row.contains?.(video)) continue;
        const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 250) continue;
        const rect = row.getBoundingClientRect();
        const leftBoundary = Number.isFinite(videoLeft) ? videoLeft + 8 : (doc.documentElement.clientWidth || 1200) * 0.55;
        const inSidebar = row.closest(sidebarSelector) ||
          (Number.isFinite(rect.right) && rect.right <= Math.min(leftBoundary, (doc.documentElement.clientWidth || 1200) * 0.55) &&
            (!Number.isFinite(videoLeft) || rect.left < videoLeft));
        if (!inSidebar) continue;
        const link = row.matches?.('a[href]') ? row : row.querySelector('a[href]');
        const href = link?.getAttribute('href') || '';
        if (href && routeResourceType(href)) {
          try {
            const url = new URL(href, location.href);
            const coursePrefix = value => value.replace(/\/(video|homework|assignment|exercise|exam|examination|test)(?:\/.*)?$/i, '');
            if (url.origin !== location.origin || coursePrefix(url.pathname) !== coursePrefix(new URL(location.href).pathname)) continue;
          } catch { continue; }
        }
        const explicit = row.getAttribute('data-resource-type') || row.getAttribute('data-leaf-type') || '';
        const label = explicit || text.match(/^(视频|作业|考试)/)?.[1] || '';
        const type = routeResourceType(href) || (/^(video|视频)$/i.test(label) ? 'video'
          : /^(homework|assignment|exercise|作业)$/i.test(label) ? 'assignment' : /^(exam|test|考试)$/i.test(label) ? 'exam' : null);
        if (!type) continue;
        // 章节容器可能同时包含若干视频和作业，不能当成一个资源条目。
        const childBadges = badges.filter(badge => row.contains?.(badge));
        if (childBadges.length > 1) continue;
        entries.push({ element: row, type, href, text });
      }
    }
    const items = entries.filter((entry, index) => !entries.some((other, j) => j !== index &&
      (other.element === entry.element ? j < index : entry.element.contains?.(other.element))));
    items.sort((a, b) => a.element.compareDocumentPosition?.(b.element) & 4 ? -1 : 1);
    const activeSelector = '[aria-current="page"], [aria-selected="true"], .active, .is-active, .current, .selected';
    const currentUrl = new URL(location.href);
    const ids = [currentUrl.searchParams.get('node_id'), currentUrl.pathname.match(/\/[^/]+\/([^/]+)\/?$/)?.[1]].filter(Boolean);
    let matches = items.map((item, index) => ({ item, index })).filter(({ item }) => {
      if (item.href) {
        try {
          const url = new URL(item.href, location.href);
          if (url.origin === currentUrl.origin && url.pathname === currentUrl.pathname &&
            (!url.searchParams.has('node_id') || url.searchParams.get('node_id') === currentUrl.searchParams.get('node_id'))) return true;
        } catch { /* 无效目录链接 */ }
      }
      return ['data-node-id', 'data-leaf-id', 'data-id'].some(attr => ids.includes(item.element.getAttribute(attr)));
    });
    if (matches.length !== 1) matches = items.map((item, index) => ({ item, index })).filter(({ item }) => {
      const active = item.element.matches?.(activeSelector) ? item.element
        : item.element.querySelector(activeSelector) || item.element.closest(activeSelector);
      return active && items.filter(other => active === other.element || active.contains?.(other.element)).length <= 1;
    });
    if (matches.length !== 1 && catalogHint?.route === location.href) {
      matches = items.map((item, index) => ({ item, index })).filter(({ item }) => item.element === catalogHint.element);
    }
    return { items, index: matches.length === 1 ? matches[0].index : -1 };
  }
  function nextCatalogVideo(docs) {
    const catalog = catalogSnapshot(docs);
    if (catalog.index < 0) return { handled: false };
    const following = catalog.items.slice(catalog.index + 1);
    const target = following.find(item => item.type === 'video');
    if (!target) {
      status('当前目录已没有后续视频');
      trace('navigation.finished', { count: catalog.items.length });
      return { handled: true };
    }
    if (target.element.closest('[disabled], [aria-disabled="true"], .is-disabled, .disabled, .locked')) {
      status('下一个视频暂不可用，等待课程解锁');
      return { handled: true, blocked: true };
    }
    const skipped = following.slice(0, following.indexOf(target)).length;
    status(skipped ? `已跳过${skipped}项作业／考试，进入下一个视频` : '正在进入下一个视频');
    trace('navigation.catalog', { from: catalog.index, skipped, destination: 'video' });
    return { handled: true, target: target.element };
  }
  function clickNavigation(target) {
    target.click();
    catalogHint = { route: location.href, element: target };
  }
  function skipAssessment(docs) {
    let type = routeResourceType(location.href);
    if (type === 'video') return false;
    if (!type) {
      const catalog = catalogSnapshot(docs);
      type = catalog.items[catalog.index]?.type;
    }
    if (type !== 'assignment' && type !== 'exam') return false;
    if (nonVideoRoute !== location.href) {
      nonVideoRoute = location.href;
      nonVideoSince = Date.now();
      nonVideoAdvanced = false;
      trace('navigation.assessment.detected', { type });
    }
    if (nonVideoAdvanced) return true;
    if (Date.now() - nonVideoSince < CONFIG.startupWaitMs) {
      status('已识别作业／考试，等待目录加载后跳过');
      return true;
    }
    const catalogNext = nextCatalogVideo(docs);
    const target = catalogNext.handled ? catalogNext.target : nextTarget(docs);
    if (target && !pauseBlocker(docs)) {
      nonVideoAdvanced = true;
      trace('navigation.assessment.skip', { method: catalogNext.handled ? 'catalog' : 'next-button' });
      clickNavigation(target);
    } else if (catalogNext.handled && !catalogNext.blocked && !target) {
      nonVideoAdvanced = true;
    } else if (!catalogNext.handled) status('已识别作业／考试，等待可用的目录或下一节按钮');
    return true;
  }
  function nextTarget(docs) {
    const selectors = [savedSelector, ...CONFIG.nextSelectors].filter(Boolean);
    for (const selector of selectors) {
      try {
        const matches = docs.flatMap(doc => [...doc.querySelectorAll(selector)]).filter(available);
        if (matches.length === 1) return matches[0];
      } catch { /* 失效的自定义选择器不影响文本识别。 */ }
    }
    // 避免“下一页”“下一题”以及任意包含“下一”字样的控件。
    const nextLabel = /^(?:播放)?下一(?:个)?(?:视频|节|讲|课)(?:[：:].*)?$/;
    const found = new Set();
    for (const doc of docs) {
      for (const el of doc.querySelectorAll('button, a, [role="button"], [title], [aria-label], .next, .next-btn, .next-button')) {
        if (!available(el) || el === host || host.contains(el)) continue;
        const labels = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')];
        if (!labels.some(label => nextLabel.test((label || '').replace(/[\s>›»→]/g, '')))) continue;
        found.add(el.closest('button, a, [role="button"]') || el);
      }
    }
    const targets = [...found].filter(available);
    // 多个独立候选时要求标记，防止误点。
    return targets.length === 1 ? targets[0] : null;
  }
  function advance(s, docs) {
    if (!current(s) || s.advanced || s.endedAt === null || !s.video.ended) return;
    const remaining = CONFIG.endWaitMs - (Date.now() - s.endedAt);
    if (remaining > 0) {
      status(`视频已结束，等待页面保存进度 · ${Math.ceil(remaining / 1000)}秒`);
      return;
    }
    const catalogNext = nextCatalogVideo(docs);
    if (catalogNext.handled) {
      if (catalogNext.blocked) return;
      s.advanced = true;
      if (catalogNext.target) clickNavigation(catalogNext.target);
      return;
    }
    const next = nextTarget(docs);
    if (!next) {
      status('已播完：未找到唯一可用的下一节按钮；可标记按钮，或已到最后一节');
      return;
    }
    s.advanced = true; // 当前视频最多点击一次，避免延迟渲染时连续跳课。
    status('正在通过页面按钮进入下一节');
    clickNavigation(next);
  }
  function bind(video) {
    if (observed.has(video)) return;
    observed.add(video);
    video.addEventListener('loadedmetadata', () => {
      safeTick();
      if (state?.video === video && !state.started) {
        state.attempted = false;
        if (!state.blocked) void play(state);
      }
    });
    for (const name of ['play', 'playing', 'pause', 'waiting', 'stalled', 'canplay', 'loadedmetadata', 'emptied', 'error', 'ratechange', 'volumechange', 'ended']) {
      video.addEventListener(name, () => {
        if (state?.video === video) trace(`media.${name}`, { media: mediaState(video) });
      });
    }
    video.addEventListener('playing', () => {
      if (state?.video !== video || !current(state)) return;
      state.started = true;
      state.manualPause = false;
      state.blocked = false;
      state.pauseAt = null;
      // 用户手动重播时重新等待自然结束。
      state.endedAt = null;
      state.advanced = false;
      status(playbackStatus(video));
    });
    video.addEventListener('pause', () => {
      if (state?.video !== video || !current(state) || video.ended || state.endedAt !== null) return;
      if (state.started) {
        state.pauseAt = Date.now();
        state.manualPause = !autoResume;
        status(autoResume ? '检测到暂停，等待2秒后尝试恢复' : '视频已暂停，自动恢复已关闭');
      }
    });
    video.addEventListener('ratechange', () => {
      if (state?.video !== video || !current(state) || !state.initialized || selecting || video.playbackRate === speed) return;
      state.rateResets += 1;
      if (speed === 2 && (controls.rate2 || controls.rateMenu)) return;
      if (state.rateResets >= 3) {
        state.rateLimited = true;
        status('倍速被重置，请展开“播放器适配”设置倍速控件');
      } else configure(state);
    });
    video.addEventListener('ended', () => {
      const s = state;
      if (!s || s.video !== video || !current(s) || !video.ended || !s.started || s.endedAt !== null) return;
      s.endedAt = Date.now();
      status('视频已自然结束，等待页面保存进度');
    });
    video.addEventListener('error', () => {
      if (state?.video === video) status('视频加载失败，请先检查页面或网络');
    });
  }
  function pauseBlocker(docs) {
    return docs.some(doc => [...doc.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .el-dialog__wrapper, .ant-modal-wrap')].some(visible));
  }
  function recoverPause(s, docs) {
    if (!autoResume || s.manualPause || s.blocked || s.pending || !s.initialized || s.video.ended || s.video.seeking || s.video.error) return;
    const now = Date.now();
    if (s.pauseAt === null) s.pauseAt = now;
    if (now - s.pauseAt < CONFIG.resumeDelayMs || now < s.nextResumeAt || s.video.readyState < 2) return;
    if (pauseBlocker(docs)) {
      status('页面有弹窗／弹题，请处理后继续；自动恢复暂缓');
      return;
    }
    s.resumeHistory = s.resumeHistory.filter(at => now - at < 60000);
    if (s.resumeHistory.length >= 6) {
      s.nextResumeAt = s.resumeHistory[0] + 60000;
      status('暂停过于频繁，暂缓恢复；请查看调试记录');
      trace('watchdog.cooldown');
      return;
    }
    s.resumeHistory.push(now);
    void play(s, false, true);
  }
  function tick() {
    if (!enabled || selecting) return;
    const docs = documents();
    if (skipAssessment(docs)) { releaseRateMenu(state); state = null; return; }
    const video = pickVideo(docs);
    if (!video) {
      releaseRateMenu(state);
      state = null;
      status('等待页面出现视频（跨域播放器无法直接控制）');
      return;
    }
    if (!state || state.video !== video || state.route !== location.href || state.source !== source(video)) {
      releaseRateMenu(state);
      state = {
        id: ++stateId, readySince: null, initialized: false, pauseAt: null, nextResumeAt: 0, resumeHistory: [],
        video, route: location.href, source: source(video), started: false,
        manualPause: false, blocked: false, attempted: false, pending: false,
        endedAt: null, advanced: false, rateLimited: false, rateResets: 0,
        rateUiAttempts: 0, rateUiPending: false, rateUiOpenedAt: 0, nextRateUiAt: 0, rateCheckAt: 0, rateDirectAttempts: 0,
        rateMenuStyles: [], rateUiKind: null,
        muteUiAttempts: 0, nextMuteUiAt: 0,
      };
      bind(video);
      trace('video.discovered', { media: mediaState(video) });
    }
    if (video.readyState < 1) {
      state.readySince = null;
      state.initialized = false;
      status('等待视频元数据和播放器加载');
      return;
    }
    if (state.readySince === null) state.readySince = Date.now();
    if (!state.initialized) {
      const remaining = CONFIG.startupWaitMs - (Date.now() - state.readySince);
      if (remaining > 0 || video.readyState < 2) {
        status(`等待播放器稳定 · ${Math.max(0, Math.ceil(remaining / 1000))}秒`);
        return;
      }
      state.initialized = true;
      trace('video.initialized');
      status('播放器已就绪');
    }
    if (state.endedAt !== null) advance(state, docs);
    else if (!state.manualPause) {
      configure(state);
      if (!video.paused) { state.started = true; state.pauseAt = null; }
      else if (state.started) recoverPause(state, docs);
      else if (!pauseBlocker(docs)) void play(state);
    }
  }

  function safeTick() {
    lastTickAt = Date.now();
    try {
      if (!host.isConnected) document.documentElement.append(host);
      tick();
      lastError = null;
    } catch (error) {
      lastError = { name: error.name, message: String(error.message) };
      trace('script.error', lastError);
      status(`脚本执行出错：${error.name}，请点“诊断信息”`);
    }
    const actual = shadow.getElementById('actual');
    const text = state?.video.isConnected ? playbackStatus(state.video) : '尚未找到视频';
    if (actual.textContent !== text) actual.textContent = text;
    verifySettings();
    if (!selecting && Date.now() - lastCatalogCheckAt >= 3000) {
      lastCatalogCheckAt = Date.now();
      try {
        const catalog = catalogSnapshot(documents());
        const button = shadow.getElementById('pick-catalog');
        button.textContent = catalog.index >= 0 ? '目录已识别' : '识别当前目录项';
        button.title = catalog.index >= 0 ? `已找到当前项，共${catalog.items.length}个资源，无需手动设置` : '仅在目录自动识别失败时使用';
      } catch (error) { trace('catalog.summary.error', { name: error.name }); }
    }
    if (Date.now() - lastSampleAt >= 10000) {
      lastSampleAt = Date.now();
      trace('sample', { enabled, selecting, autoResume, media: mediaState(state?.video) });
    }
    const faults = detectFaults();
    const key = JSON.stringify(faults);
    if (key !== lastFaultKey) {
      lastFaultKey = key;
      trace('faults.changed', { faults });
    }
  }

  function detectFaults() {
    const faults = [];
    if (!enabled) faults.push('AUTOMATION_DISABLED');
    if (lastError) faults.push('SCRIPT_EXCEPTION');
    if (!state) faults.push('NO_ACCESSIBLE_VIDEO');
    else {
      const v = state.video;
      if (!state.initialized) faults.push('PLAYER_INITIALIZING');
      if (state.blocked) faults.push('PLAY_REJECTED');
      if (v.error) faults.push('MEDIA_ERROR');
      if (state.initialized && !v.ended) {
        if (v.paused) faults.push('PLAYBACK_PAUSED');
        if (v.playbackRate !== speed) faults.push('RATE_NOT_APPLIED');
        if (!v.muted && v.volume !== 0) faults.push('MUTE_NOT_APPLIED');
        if (v.readyState < 2) faults.push('MEDIA_NOT_READY');
      }
      if (state.rateUiAttempts >= 3 && v.playbackRate !== speed) faults.push('RATE_UI_RETRY_LIMIT');
      if (state.muteUiAttempts >= 3 && !v.muted && v.volume !== 0) faults.push('MUTE_UI_RETRY_LIMIT');
    }
    return faults;
  }

  function diagnosticReport() {
    const docs = documents();
    const catalog = catalogSnapshot(docs);
    const videos = [];
    docs.forEach((doc, documentIndex) => {
      for (const video of doc.querySelectorAll('video')) {
        const rect = video.getBoundingClientRect();
        videos.push({
          documentIndex, selected: video === state?.video,
          visible: visible(video), width: rect.width, height: rect.height,
          paused: video.paused, ended: video.ended, readyState: video.readyState,
          playbackRate: video.playbackRate, muted: video.muted, volume: video.volume,
          currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        });
      }
    });
    // 只导出运行状态；不包含完整网址、视频地址、Cookie、账号或网页正文。
    const report = {
      scriptVersion: '1.3.5',
      scriptManager: typeof GM_info === 'object' ? GM_info.scriptHandler : 'unknown',
      status: message, enabled, selecting, autoResume, targetSpeed: speed,
      config: { startupWaitMs: CONFIG.startupWaitMs, resumeDelayMs: CONFIG.resumeDelayMs, menuWaitMs: CONFIG.menuWaitMs },
      panelConnected: host.isConnected,
      lastTickAgeMs: lastTickAt === null ? null : Date.now() - lastTickAt,
      lastError,
      documentCount: docs.length,
      iframeCount: docs.reduce((count, doc) => count + doc.querySelectorAll('iframe').length, 0),
      markedControls: { rateMenu: !!controls.rateMenu, rate2: !!controls.rate2, mute: !!controls.mute },
      speedMenu: state ? (() => {
        const menu = speedMenu(state);
        return { kind: menu.xt ? 'xt' : 'marked', opener: controlInfo(menu.opener),
          option: controlInfo(menu.option || markedControl(state, controls.rate2, true)),
          chain: controlChain(menu.option || menu.opener, menu.root) };
      })() : null,
      catalog: { count: catalog.items.length, currentIndex: catalog.index, types: catalog.items.slice(0, 100).map(item => item.type) },
      state: state ? {
        current: current(state), started: state.started, manualPause: state.manualPause,
        blocked: state.blocked, pending: state.pending, attempted: state.attempted,
        rateLimited: state.rateLimited, rateResets: state.rateResets,
        endedAt: state.endedAt, advanced: state.advanced,
        rateUiAttempts: state.rateUiAttempts, muteUiAttempts: state.muteUiAttempts,
        rateDirectAttempts: state.rateDirectAttempts, rateUiPending: state.rateUiPending,
        settingsConfirmed: !!state.settingsConfirmed,
        initialized: state.initialized, readySince: state.readySince, pauseAt: state.pauseAt,
        nextResumeAt: state.nextResumeAt, recentResumeCount: state.resumeHistory.length,
      } : null,
      faults: detectFaults(), videos, recentMessages, debugEvents, controlInputEvents,
    };
    return report;
  }
  function showDiagnostics() {
    const output = shadow.getElementById('diagnostics');
    output.hidden = false;
    output.value = JSON.stringify(diagnosticReport(), null, 2);
  }
  function exportDebug() {
    const blob = new Blob([JSON.stringify(diagnosticReport(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `yuketang-debug-${Date.now()}.json`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function cssPath(el) {
    // 优先保存控件自身的稳定特征，避免整页 nth-of-type 随布局变化而失效。
    const semantic = ['xt-speedbutton xt-speedvalue', 'xt-speedbutton li[data-speed="2"]',
      'xt-volumebutton xt-icon', '.btn-next', '.next-btn', '.next-button'];
    if (el.getAttribute?.('aria-label')) semantic.push(`${el.localName}[aria-label="${CSS.escape(el.getAttribute('aria-label'))}"]`);
    if (el.getAttribute?.('title')) semantic.push(`${el.localName}[title="${CSS.escape(el.getAttribute('title'))}"]`);
    for (const selector of semantic) {
      const matches = [...el.ownerDocument.querySelectorAll(selector)];
      if (matches.length === 1 && matches[0] === el) return selector;
    }
    const parts = [];
    while (el && el.nodeType === 1) {
      if (el.id) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      const tag = el.localName;
      const peers = el.parentElement ? [...el.parentElement.children].filter(e => e.localName === tag) : [el];
      parts.unshift(`${tag}:nth-of-type(${peers.indexOf(el) + 1})`);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function resetUiAttempts() {
    if (!state) return;
    releaseRateMenu(state);
    Object.assign(state, {
      rateUiAttempts: 0, rateUiPending: false, rateUiOpenedAt: 0, nextRateUiAt: 0, rateCheckAt: 0, rateDirectAttempts: 0,
      muteUiAttempts: 0, nextMuteUiAt: 0, rateLimited: false, rateResets: 0,
      settingsConfirmed: false, settingsReadyAt: null,
    });
  }
  function markPlayerControl(kind) {
    if (selecting) return;
    releaseRateMenu(state);
    selecting = true;
    let menuSelector = '';
    let stage = 0;
    const docs = documents();
    status(kind === 'rate'
      ? '先点击播放器当前倍速按钮（如1.00X），再在展开菜单中选择2倍速；Esc取消'
      : '请点击播放器的扬声器静音按钮（此次照常切换静音）；Esc取消');
    const cleanup = () => {
      clearTimeout(timer);
      selecting = false;
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
        doc.removeEventListener('pointerover', captureHover, true);
      }
    };
    const cancel = event => {
      if (event.key === 'Escape') { cleanup(); status('已取消控件标记'); }
    };
    const saveMenu = el => {
      menuSelector = cssPath(el);
      stage = 1;
      // 入口先单独保存：选项每次才挂载时，可在展开后按文字动态查找2倍速。
      if (!saveControls({ rateMenu: menuSelector })) return;
      status('倍速入口已记录，请保持菜单展开并点击上拉菜单里的2倍速；无需返回脚本面板');
    };
    const rateLabel = el => /^(?:\d+(?:\.\d+)?\s*[x×倍]|倍速|播放速度)$/i.test((el.textContent || '').trim());
    const captureHover = event => {
      if (kind !== 'rate' || stage !== 0 || event.composedPath().includes(host)) return;
      const el = labelElement(event.target, rateLabel);
      if (el && available(el)) saveMenu(el);
    };
    const choose = event => {
      if (event.composedPath().includes(host)) return;
      const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
      let el = target.closest('button, a, [role="button"]') || target;
      if (target.closest('video') || !available(el)) return;
      if (kind === 'rate' && stage === 0) {
        el = labelElement(target, rateLabel) || el;
        saveMenu(el);
        return; // 不阻止原点击，让网站照常打开菜单。
      }
      if (kind === 'rate') {
        el = labelElement(target, isTwoSpeed);
        if (!el) { status('入口已记录，请在展开的上拉菜单中选择2倍速；Esc可结束标记并自动查找'); return; }
        if (!saveControls({ rateMenu: menuSelector, rate2: cssPath(el) })) return;
      } else if (!saveControls({ mute: cssPath(el) })) return;
      resetUiAttempts();
      cleanup();
      status(kind === 'rate' ? '已保存2倍速控件；之后优先通过播放器菜单设置' : '已保存静音按钮；之后优先通过播放器按钮静音');
      feedback(kind === 'rate' ? '倍速控件已记住，刷新后自动复用；正在验证效果' : '静音控件已记住，刷新后自动复用；正在验证效果');
      // 原始点击继续执行，保证播放器内部状态也按正常手动操作更新。
    };
    const timer = setTimeout(() => { cleanup(); status('标记已超时，请重试'); }, 60000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
      if (kind === 'rate') doc.addEventListener('pointerover', captureHover, true);
    }
  }
  function markNext() {
    if (selecting) return;
    selecting = true;
    status('请在30秒内点击页面的下一节按钮（此次仅记录位置）；Esc取消');
    const docs = documents();
    const cleanup = () => {
      clearTimeout(timer);
      selecting = false;
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
      }
    };
    const cancel = event => {
      if (event.key === 'Escape') { cleanup(); status('已取消标记'); }
    };
    const choose = event => {
      if (event.composedPath().includes(host)) return;
      const el = event.target.closest('button, a, [role="button"], .next, .next-btn, .next-button') || event.target;
      event.preventDefault();
      event.stopImmediatePropagation();
      savedSelector = cssPath(el);
      GM_setValue(storageKey, savedSelector);
      memorySummary();
      feedback('下一节控件已记住，刷新后自动复用');
      cleanup();
      status('已保存下一节按钮位置；页面布局改变后请重新标记');
    };
    const timer = setTimeout(() => { cleanup(); status('标记已超时，可再次点击“标记下一节按钮”'); }, 30000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
    }
  }
  function markCatalogItem() {
    if (selecting) return;
    const docs = documents();
    const initial = catalogSnapshot(docs);
    if (initial.index >= 0) {
      trace('catalog.already-recognized', { count: initial.items.length, index: initial.index });
      status('目录已自动识别，无需手动设置');
      return;
    }
    selecting = true;
    status('请点击左侧目录中正在播放的那一项');
    const cleanup = () => {
      selecting = false;
      clearTimeout(timer);
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
      }
    };
    const cancel = event => { if (event.key === 'Escape') { cleanup(); status('已取消目录识别'); } };
    const choose = event => {
      if (event.composedPath().includes(host)) return;
      const catalog = catalogSnapshot(docs);
      const target = event.target.nodeType === 3 ? event.target.parentElement : event.target;
      let candidates = catalog.items.filter(entry => entry.element === target || entry.element.contains?.(target));
      // 名称、图标、可点击外框可能是兄弟节点，允许向上寻找只包含一个资源的条目外框。
      if (candidates.length !== 1) {
        for (let ancestor = target, depth = 0; ancestor && depth < 5; ancestor = ancestor.parentElement, depth++) {
          const inside = catalog.items.filter(entry => ancestor === entry.element || ancestor.contains?.(entry.element));
          if (inside.length === 1) { candidates = inside; break; }
          if (inside.length > 1) break;
        }
      }
      const item = candidates.length === 1 ? candidates[0] : null;
      if (!item) {
        cleanup();
        trace('catalog.mark.miss', { count: catalog.items.length, tag: target.localName, className: String(target.className || '').slice(0, 120) });
        status('此次未识别，已退出设置；可导出调试文件定位');
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      catalogHint = { route: location.href, element: item.element };
      cleanup();
      trace('catalog.marked', { type: item.type, count: catalog.items.length });
      status('目录已识别，连播会跳过作业和考试');
    };
    const timer = setTimeout(() => { cleanup(); status('目录识别已超时'); }, 60000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
    }
  }
  function toggle() {
    enabled = !enabled;
    toggleNode.textContent = enabled ? '暂停' : '开始';
    shadow.getElementById('badge').textContent = enabled ? '运行中' : '已暂停';
    if (!enabled) {
      releaseRateMenu(state);
      state?.video.pause();
      status('自动化已暂停');
    } else {
      if (state) state.manualPause = false;
      resume();
    }
  }
  function resume() {
    if (!enabled || selecting) return;
    safeTick();
    if (!state) return;
    state.manualPause = false;
    state.blocked = false;
    state.pauseAt = null;
    state.nextResumeAt = 0;
    state.resumeHistory = [];
    resetUiAttempts();
    // 不重播已结束的视频；允许重新查找此前未识别到的下一节按钮。
    if (state.video.ended) {
      if (state.advanced) status('下一节尚未加载，请检查页面；避免重复跳转，请手动点击一次下一节');
      return;
    }
    void play(state, true);
  }
  function toggleAutoResume() {
    autoResume = !autoResume;
    shadow.getElementById('auto-resume').checked = autoResume;
    if (state?.video.paused && !state.video.ended) {
      state.manualPause = !autoResume;
      state.pauseAt = Date.now();
    }
    trace('watchdog.toggle', { autoResume });
    status(autoResume ? '自动恢复已开启；主动暂停请点“暂停自动化”' : '自动恢复已关闭');
  }
  function changeSpeed() {
    speed = speed === 2 ? 1 : 2;
    speedNode.textContent = `${speed}×`;
    if (state) { resetUiAttempts(); configure(state); }
    status(`目标速度已改为${speed}倍速`);
  }
  shadow.getElementById('toggle').addEventListener('click', toggle);
  shadow.getElementById('resume').addEventListener('click', resume);
  shadow.getElementById('pick').addEventListener('click', markNext);
  shadow.getElementById('pick-catalog').addEventListener('click', markCatalogItem);
  shadow.getElementById('collapse').addEventListener('click', () => {
    const body = shadow.getElementById('panel-body');
    body.hidden = !body.hidden;
    const button = shadow.getElementById('collapse');
    button.textContent = body.hidden ? '+' : '−';
    button.setAttribute('aria-expanded', String(!body.hidden));
    button.setAttribute('aria-label', body.hidden ? '展开面板' : '收起面板');
  });
  shadow.getElementById('diagnose').addEventListener('click', showDiagnostics);
  shadow.getElementById('export-debug').addEventListener('click', exportDebug);
  shadow.getElementById('auto-resume').addEventListener('click', toggleAutoResume);
  shadow.getElementById('mark-rate').addEventListener('click', () => markPlayerControl('rate'));
  shadow.getElementById('mark-mute').addEventListener('click', () => markPlayerControl('mute'));
  speedNode.addEventListener('click', changeSpeed);
  GM_registerMenuCommand('暂停 / 启用自动化', toggle);
  GM_registerMenuCommand('标记下一节按钮', markNext);
  GM_registerMenuCommand('显示播放诊断信息', showDiagnostics);
  GM_registerMenuCommand('导出调试文件', exportDebug);
  GM_registerMenuCommand('清除播放器控件标记', () => {
    controls = {};
    GM_setValue(controlsKey, controls);
    memorySummary();
    resetUiAttempts();
    status('已清除播放器控件标记');
  });
  GM_registerMenuCommand('清除下一节按钮标记', () => {
    savedSelector = '';
    GM_setValue(storageKey, '');
    memorySummary();
    status('已清除标记，恢复自动识别');
  });
  status(message);
  memorySummary();
  if (controls.rateMenu || controls.rate2 || controls.mute || savedSelector) feedback('已加载记住的控件，播放器就绪后自动应用');
  document.defaultView.addEventListener?.('pagehide', () => releaseRateMenu(state));
  trace('script.start', { version: '1.3.5' });
  safeTick();
  setInterval(safeTick, CONFIG.pollMs);
})();
