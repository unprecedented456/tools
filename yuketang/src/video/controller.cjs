'use strict';

// 视频对象：独立管理播放状态、原生控件、补播与暂停恢复。
function createVideoAutomation(ports, options = {}) {
  const Course = ports.core;
  const controlsKey = `player-controls:${location.origin}`;

  const storedControls = GM_getValue(controlsKey, {});

  let controls = storedControls && typeof storedControls === 'object' ? storedControls : {};

  let autoResume = true;

  const foregroundKey = `foreground-mask:${location.origin}`;

  let foregroundMask = GM_getValue(foregroundKey, true) !== false;

  const foregroundRecords = new Map();

  let speed = ports.app.CONFIG.speed;

  let state = null;

  let stateId = 0;

  const observed = new WeakSet();

  function saveControls(updates) {
    const next = { ...controls, ...updates };
    if (JSON.stringify(next) === JSON.stringify(controls)) return true;
    try {
      GM_setValue(controlsKey, next);
      controls = next;
      ports.ui.memorySummary();
      ports.app.trace('controls.saved', { kinds: Object.keys(updates) });
      return true;
    } catch (error) {
      ports.app.trace('controls.save.error', { name: error.name });
      ports.ui.feedback('控件设置未能保存，请检查油猴存储权限', 'error');
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

  function mediaState(video) {
    return video ? {
      paused: video.paused, ended: video.ended, seeking: video.seeking,
      readyState: video.readyState, playbackRate: video.playbackRate,
      muted: video.muted, volume: video.volume,
      currentTime: Math.round((video.currentTime || 0) * 10) / 10,
      errorCode: video.error?.code || null,
    } : null;
  }

  function playbackStatus(video) {
    return `${video.paused ? '已暂停' : '播放中'} · 实际${video.playbackRate}倍速 · ${video.muted || video.volume === 0 ? '静音' : '有声音'}`;
  }

  function descriptorOf(object, key) {
    for (let target = object; target; target = Object.getPrototypeOf(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
    }
    return null;
  }

  function nativeForeground(doc) {
    const record = foregroundRecords.get(doc);
    const read = key => {
      const descriptor = record?.originals.get(key)?.inherited || descriptorOf(doc, key);
      try { return descriptor?.get ? descriptor.get.call(doc) : descriptor?.value; } catch { return undefined; }
    };
    const focus = read('hasFocus');
    return { hidden: !!read('hidden'), state: read('visibilityState') || 'unknown',
      focused: typeof focus === 'function' ? (() => { try { return focus.call(doc); } catch { return null; } })() : null };
  }

  function notifyVisibility(record) {
    const EventClass = record.doc.defaultView?.Event;
    if (!EventClass || !record.doc.dispatchEvent) return;
    record.notifying = true;
    try { record.doc.dispatchEvent(new EventClass('visibilitychange')); }
    catch (error) { ports.app.trace('foreground.notify.error', { name: error.name }); }
    finally { record.notifying = false; }
  }

  function releaseForeground(record) {
    record.active = false;
    for (const [key, original] of record.originals) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(record.doc, key);
        const ours = original.getter ? descriptor?.get === original.getter : descriptor?.value === original.value;
        if (!ours) continue;
        if (original.own) Object.defineProperty(record.doc, key, original.own);
        else delete record.doc[key];
      } catch (error) { ports.app.trace('foreground.restore.error', { key, name: error.name }); }
    }
    for (const name of ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange', 'blur', 'focusout']) {
      record.doc.defaultView?.removeEventListener?.(name, record.handler, true);
    }
    foregroundRecords.delete(record.doc);
    notifyVisibility(record);
  }

  function syncForegroundMask(docs, hasVideo) {
    const active = ports.app.enabled && foregroundMask && hasVideo;
    // raw 优先在页面环境执行；unsafeWindow 用于管理器提供页面对象时的明确访问。
    const pageDocs = docs.map(doc => doc === document && typeof unsafeWindow === 'object' ? unsafeWindow.document : doc);
    for (const [doc, record] of foregroundRecords) if (!active || !pageDocs.includes(doc)) releaseForeground(record);
    if (active) for (const doc of pageDocs) {
      if (foregroundRecords.has(doc)) continue;
      const record = { doc, originals: new Map(), active: false, notifying: false, blockedEvents: 0, error: null };
      foregroundRecords.set(doc, record);
      try {
        const fields = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
        for (const key of ['webkitHidden', 'mozHidden', 'msHidden']) if (key in doc) fields[key] = false;
        for (const key of ['webkitVisibilityState', 'mozVisibilityState', 'msVisibilityState']) if (key in doc) fields[key] = 'visible';
        for (const [key, value] of Object.entries(fields)) {
          const original = { own: Object.getOwnPropertyDescriptor(doc, key), inherited: descriptorOf(doc, key) };
          if (key === 'hasFocus') {
            original.value = value;
            Object.defineProperty(doc, key, { configurable: true, value });
          } else {
            original.getter = () => value;
            Object.defineProperty(doc, key, { configurable: true, get: original.getter });
          }
          record.originals.set(key, original);
        }
        record.handler = event => {
          if (!record.active || record.notifying) return;
          const visibility = /visibilitychange$/.test(event.type);
          const windowBlur = (event.type === 'blur' || event.type === 'focusout') && (event.target === doc.defaultView || event.target === doc);
          if ((visibility && nativeForeground(doc).hidden) || windowBlur) {
            event.stopImmediatePropagation();
            record.blockedEvents += 1;
            if (record.blockedEvents <= 3 || record.blockedEvents % 20 === 0) ports.app.trace('foreground.event.blocked', { type: event.type, count: record.blockedEvents });
          }
        };
        for (const name of ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange', 'msvisibilitychange', 'blur', 'focusout']) {
          doc.defaultView?.addEventListener?.(name, record.handler, true);
        }
        record.active = doc.hidden === false && doc.visibilityState === 'visible' && doc.hasFocus();
        if (!record.active) throw new Error('ForegroundVerificationFailed');
        ports.app.trace('foreground.applied', { native: nativeForeground(doc) });
        notifyVisibility(record);
      } catch (error) {
        releaseForeground(record);
        record.error = error.name;
        // 保留失败结果，直到用户切换开关，避免每秒重复修改属性。
        foregroundRecords.set(doc, record);
        ports.app.trace('foreground.apply.error', { name: error.name });
      }
    }
    const records = [...foregroundRecords.values()];
    const applied = records.length && records.every(record => record.active && record.doc.hidden === false &&
      record.doc.visibilityState === 'visible' && record.doc.hasFocus());
    ports.ui.shadow.getElementById('foreground-status').textContent = !foregroundMask ? '前台伪装：已关闭'
      : !ports.app.enabled ? '前台伪装：已随自动化暂停'
      : !hasVideo ? '前台伪装：等待视频' : applied ? '前台伪装：页面读取已生效 · 实际窗口不切换'
      : '前台伪装：应用失败，请导出调试记录';
  }

  function toggleForegroundMask() {
    foregroundMask = !foregroundMask;
    ports.ui.shadow.getElementById('foreground-mask').checked = foregroundMask;
    try { GM_setValue(foregroundKey, foregroundMask); }
    catch (error) { ports.app.trace('foreground.save.error', { name: error.name }); ports.ui.feedback('开关已切换，但未能保存，下次刷新可能恢复默认', 'error'); }
    syncForegroundMask(ports.platform.documents(), !!state?.video.isConnected);
    ports.app.trace('foreground.toggle', { enabled: foregroundMask });
  }

  function source(video) {
    return video.currentSrc || video.src || video.querySelector('source')?.src || '';
  }

  function current(s) {
    return ports.app.enabled && s === state && s.video.isConnected &&
      s.route === location.href && s.source === source(s.video);
  }

  function pickVideo(docs) {
    const candidates = docs.flatMap(doc => [...doc.querySelectorAll('video')]).filter(ports.platform.visible);
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
        : ports.platform.available(el));
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
      .filter(el => ports.platform.available(el) && isTwoSpeed(el));
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
    if (!menu.xt || !menu.root || !menu.option || ports.platform.available(menu.option)) return;
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
    ports.app.trace('menu.expand', { before, after: controlChain(menu.option, menu.root), visible: ports.platform.available(menu.option) });
  }

  function controlChain(el, stop) {
    const result = [];
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (['body', 'html'].includes(el.localName) || el.contains?.(state?.video)) break;
      const css = el.ownerDocument.defaultView.getComputedStyle(el);
      result.push({ tag: el.localName, className: String(el.className || '').slice(0, 160), visible: ports.platform.visible(el),
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
    ports.app.trace('menu.hover', { target: ports.platform.controlInfo(menu), position });
  }

  function inputPosition(el) {
    const rect = el.getBoundingClientRect();
    return { clientX: (rect.left || 0) + rect.width / 2, clientY: (rect.top || 0) + rect.height / 2, button: 0, buttons: 0 };
  }

  function selectRateOption(s, option) {
    const parent = option.closest('li, [role="option"], [role="menuitem"], [data-rate], [data-speed]');
    const target = parent && isTwoSpeed(parent) ? parent : option;
    if (!ports.platform.available(target)) {
      ports.app.trace('menu.option.blocked', { reason: 'hidden-or-disabled', target: ports.platform.controlInfo(target) });
      return;
    }
    ports.app.trace('menu.option.click', { attempt: s.rateUiAttempts, target: ports.platform.controlInfo(target), input: 'positioned-pointer-mouse' });
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
        ports.app.trace('menu.motion', { enter: enterPosition, move: position,
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
      ports.app.trace('rate.property.write', { reason, attempt: s.rateDirectAttempts, media: mediaState(s.video) });
    } catch (error) {
      ports.app.trace('rate.property.error', { reason, name: error.name });
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
        ports.app.trace('mute.click', { attempt: s.muteUiAttempts, media: mediaState(v) });
        button.click();
      } else ports.ui.status('静音按钮标记已失效或被隐藏，请显示播放器控制栏或重新标记');
    }
    s.rateUiKind = menu.xt ? 'xt' : 'marked';
    if (speed !== 2 || (!controls.rate2 && !controls.rateMenu && !menu.xt)) return;
    if (s.rateCheckAt && now >= s.rateCheckAt) {
      s.rateCheckAt = 0;
      ports.app.trace('rate.verify', { applied: v.playbackRate === speed, media: mediaState(v) });
      releaseRateMenu(s);
      if (v.playbackRate !== speed) {
        if (!menu.xt) setRateProperties(s, 'menu-did-not-change-rate');
        else ports.ui.status('倍速菜单操作后仍为1倍速，已记录控件结构供排查');
      }
    }
    if (v.playbackRate === 2) { s.rateUiPending = false; return; }
    if (s.rateUiPending) {
      if (now - s.rateUiOpenedAt < 200) return;
      expandXtMenu(s, menu);
      const option = menu.xt ? (ports.platform.available(menu.option) ? menu.option : null) : twoSpeedOption(s, true);
      if (option) {
        s.rateUiPending = false;
        s.nextRateUiAt = now + 3000;
        selectRateOption(s, option);
      }
      if (s.rateUiPending && now - s.rateUiOpenedAt >= ports.app.CONFIG.menuWaitMs) {
        s.rateUiPending = false;
        s.nextRateUiAt = now + 3000;
        ports.app.trace('menu.timeout', { attempt: s.rateUiAttempts, chain: controlChain(menu.option || menu.opener) });
        releaseRateMenu(s);
        ports.ui.status('未找到已标记的2倍速选项，请显示控制栏或重新标记');
      }
      return;
    }
    if (s.rateUiAttempts >= 3 || now < s.nextRateUiAt) return;
    const option = menu.xt ? (ports.platform.available(menu.option) ? menu.option : null) : twoSpeedOption(s);
    if (option) {
      s.rateUiAttempts += 1;
      s.nextRateUiAt = now + 3000;
      selectRateOption(s, option);
    } else if (menu.opener && (menu.xt || ports.platform.available(menu.opener))) {
      // 下一轮再选择选项，兼容菜单异步挂载。通过网站自身事件同步播放器状态。
      s.rateUiAttempts += 1;
      s.rateUiPending = true;
      s.rateUiOpenedAt = now;
      ports.app.trace('menu.opener.click', { target: ports.platform.controlInfo(menu.opener), kind: s.rateUiKind });
      menu.opener.click();
      hoverMenu(menu.opener);
      if (menu.xt && menu.root) hoverMenu(menu.root);
      expandXtMenu(s, menu);
    } else ports.ui.status('倍速菜单标记已失效或被隐藏，请显示控制栏或重新标记');
  }

  function configure(s) {
    if (!current(s) || ports.app.selecting || !s.initialized) return;
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
      ports.ui.status('播放器拒绝设置倍速，保留页面允许的速度');
    }
  }

  async function play(s, userGesture = false, recovery = false) {
    if (!current(s) || s.advanced || s.completion.percent === 100 || s.pending || s.video.ended || s.endedAt !== null) return;
    if (!userGesture && (!s.initialized || s.blocked || s.manualPause ||
      (!recovery && (s.started || s.attempted)) || Date.now() < s.nextResumeAt)) return;
    if (s.video.readyState < 2 || s.video.seeking || s.video.error) return;
    s.pending = true;
    s.attempted = true;
    s.nextResumeAt = Date.now() + ports.app.CONFIG.resumeRetryMs;
    ports.app.trace(recovery ? 'watchdog.resume' : 'play.attempt', { media: mediaState(s.video) });
    try {
      configure(s);
      await s.video.play();
      if (current(s)) {
        s.blocked = false;
        s.manualPause = false;
        s.started = true;
        ports.app.trace('play.resolved', { media: mediaState(s.video) });
        ports.ui.status(playbackStatus(s.video));
      }
    } catch (error) {
      if (current(s)) {
        ports.app.trace('play.rejected', { name: error.name, media: mediaState(s.video) });
        if (error.name === 'AbortError') {
          s.blocked = false;
          s.attempted = false;
          ports.ui.status('播放器正在加载或切换，稍后重试播放');
          return;
        }
        s.blocked = true;
        ports.ui.status(error.name === 'NotAllowedError'
          ? '浏览器阻止自动播放，请点“继续播放”'
          : `播放未能启动：${error.name}；页面就绪后点“继续播放”`);
      }
    } finally { s.pending = false; }
  }

  function completionValue(el, allowBare = false) {
    if (!el?.isConnected || el === ports.ui.host || ports.ui.host.contains(el) ||
      el.closest?.('.nav-progress, xt-progress, xt-volumebutton, .xt_video_player_progress')) return null;
    const text = (el.textContent || '').replace(/\s+/g, '').trim();
    if (/课程|整课|总体/.test(text) || text.length > 50) return null;
    const match = text.match(allowBare ? /^(?:(?:当前)?视频)?(?:学习)?(?:完成度|完成进度|已完成)?[:：]?(\d+(?:\.\d+)?)%$/
      : /^(?:(?:当前)?视频)?(?:学习)?(?:完成度|完成进度|已完成)[:：]?(\d+(?:\.\d+)?)%$/);
    if (!match) return null;
    const value = Number(match[1]);
    return value >= 0 && value <= 100 ? value : null;
  }

  function readCompletion(s, docs) {
    // 人工标记的右上角完成度优先，唯一匹配才采用；失效后退回目录。
    if (controls.completion) {
      try {
        const nodes = docs.flatMap(doc => [...doc.querySelectorAll(controls.completion)]);
        if (nodes.length === 1) {
          const percent = completionValue(nodes[0], true);
          if (percent !== null) return { percent, source: 'marked-video' };
        }
      } catch { /* 页面结构更新后可重新识别 */ }
    }
    // 自动文字识别严格限于包含当前 video 的小范围容器，排除页面导航与讲稿。
    let scope = s.video.parentElement;
    for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
      if (['body', 'html', 'main'].includes(scope.localName) || scope.querySelector?.('.nav-progress, .leaf-item')) break;
      const nodes = [...scope.querySelectorAll('[class*="progress"], [class*="complet"], [class*="finish"]')];
      const values = nodes.map(el => completionValue(el)).filter(value => value !== null);
      if (values.length && new Set(values).size === 1) return { percent: values[0], source: 'video-label' };
    }
    const catalog = ports.platform.catalogSnapshot(docs);
    const item = catalog.items[catalog.index];
    if (item?.type !== 'video') return { percent: null, source: 'unknown' };
    const row = item.element.closest('.leaf-item') || item.element;
    const badge = row.querySelector('.leaf-item-status');
    if (!badge) return { percent: null, source: 'unknown' };
    if (badge.querySelector('.icon-yuanquangou-mianzhuang')) return { percent: 100, source: 'catalog-done' };
    const pie = badge.querySelector('.status-pie');
    const raw = pie?.style?.getPropertyValue('--p')?.trim();
    if (raw && /^\d+(?:\.\d+)?$/.test(raw) && Number(raw) <= 100) return { percent: Number(raw), source: 'catalog-pie' };
    return { percent: null, source: 'unknown' };
  }

  function updateCompletion(s, docs) {
    const value = readCompletion(s, docs);
    if (value.percent !== s.completion.percent || value.source !== s.completion.source) {
      ports.app.trace('completion.changed', { ...value, previous: s.completion.percent,
        hidden: nativeForeground(s.video.ownerDocument).hidden, replayCount: s.replayCount });
    }
    s.completion = value;
    ports.ui.shadow.getElementById('completion').textContent = value.percent === null
      ? '当前视频完成度：未识别 · 可在“设置 → 视频播放与控件”中点选'
      : `当前视频完成度：${value.percent}%${s.replayCount ? ` · 第${s.replayCount}次补播` : ''}`;
  }

  async function replay(s, docs) {
    if (!current(s) || s.advanced || s.pending || s.replayStopped || s.blocked || !s.video.ended ||
      s.video.readyState < 2 || s.video.seeking || s.video.error || ports.platform.pauseBlocker(docs)) return;
    const percent = s.completion.percent;
    if (percent === null || percent >= 100) return;
    if (s.replayBaseline !== null) {
      s.stagnantReplays = percent > s.replayBaseline ? 0 : s.stagnantReplays + 1;
    }
    if (s.stagnantReplays >= ports.app.CONFIG.maxStagnantReplays || s.replayCount >= ports.app.CONFIG.maxReplays) {
      s.skipReason = 'replay-limit';
      ports.app.trace('replay.limit', { percent, replayCount: s.replayCount, stagnantReplays: s.stagnantReplays });
      ports.ui.feedback(`完成度${percent}%，补播多次仍未完成，自动跳过`, 'error');
      advance(s, docs);
      return;
    }
    s.pending = true;
    s.replayBaseline = percent;
    s.replayCount += 1;
    ports.app.trace('replay.attempt', { percent, replayCount: s.replayCount, hidden: nativeForeground(s.video.ownerDocument).hidden });
    try {
      // 用户授权的正常从头补播；只在自然结束后回到0，绝不向前跳过内容。
      s.video.currentTime = 0;
      s.endedAt = null;
      configure(s);
      await s.video.play();
      if (current(s) && !s.advanced) {
        s.endedAt = null;
        s.blocked = false;
        s.manualPause = false;
        s.started = true;
        ports.app.trace('replay.started', { percent, replayCount: s.replayCount });
        ports.ui.status(`完成度${percent}%，正在从头补播 · 第${s.replayCount}次`);
      }
    } catch (error) {
      if (current(s)) {
        s.blocked = true;
        s.replayStopped = true;
        ports.app.trace('replay.rejected', { name: error.name });
        ports.ui.status(`重播未能启动：${error.name}，请点“继续播放”重试`);
      }
    } finally { s.pending = false; }
  }

  function advance(s, docs) {
    const incomplete = s.completion.percent !== 100;
    if (!current(s) || s.advanced || (incomplete && s.skipReason !== 'replay-limit') || ports.platform.pauseBlocker(docs)) return;
    if (!s.video.paused) s.video.pause();
    if (ports.app.videoFinished(s, docs)) return;
    const catalogNext = ports.app.nextCatalogVideo(docs);
    if (catalogNext.handled) {
      if (catalogNext.blocked) return;
      s.advanced = true;
      ports.app.trace(incomplete ? 'completion.skipped' : 'completion.confirmed', {
        ...s.completion, replayCount: s.replayCount, reason: incomplete ? s.skipReason : null, hasNext: !!catalogNext.target,
      });
      if (catalogNext.target) {
        if (incomplete) ports.ui.status(`完成度${s.completion.percent}%，补播多次未完成，已跳过并进入下一视频`);
        ports.platform.clickNavigation(catalogNext.target);
      }
      return;
    }
    const next = ports.platform.nextTarget(docs);
    if (!next) {
      ports.ui.status(incomplete ? '补播多次未完成，等待可用的下一视频或下一节按钮；可在“设置 → 视频播放与控件”中标记'
        : '完成度100%：未找到唯一可用的下一节按钮；可标记按钮，或已到最后一节');
      return;
    }
    s.advanced = true;
    ports.app.trace(incomplete ? 'completion.skipped' : 'completion.confirmed', {
      ...s.completion, replayCount: s.replayCount, reason: incomplete ? s.skipReason : null, hasNext: true,
    });
    ports.ui.status(incomplete ? `完成度${s.completion.percent}%，补播多次未完成，已跳过并进入下一节` : '完成度100%，正在通过页面按钮进入下一节');
    ports.platform.clickNavigation(next);
  }

  function handleEnded(s, docs) {
    if (s.replayStopped || s.pending) return;
    const remaining = ports.app.CONFIG.endWaitMs - (Date.now() - s.endedAt);
    if (remaining > 0) {
      ports.ui.status(`视频已结束，等待页面保存进度 · ${Math.ceil(remaining / 1000)}秒`);
      return;
    }
    if (s.completion.percent === null) {
      ports.ui.status('视频已播完，但未识别完成度；请在“设置 → 视频播放与控件”中点选视频完成度');
      return;
    }
    void replay(s, docs);
  }

  function bind(video) {
    if (observed.has(video)) return;
    observed.add(video);
    video.addEventListener('loadedmetadata', () => {
      ports.app.safeTick();
      if (state?.video === video && !state.started) {
        state.attempted = false;
        if (!state.blocked) void play(state);
      }
    });
    for (const name of ['play', 'playing', 'pause', 'waiting', 'stalled', 'canplay', 'loadedmetadata', 'emptied', 'error', 'ratechange', 'volumechange', 'ended']) {
      video.addEventListener(name, () => {
        if (state?.video === video) ports.app.trace(`media.${name}`, { media: mediaState(video) });
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
      // 已确认完成后的导航不能被延迟到达的 playing 事件撤销。
      ports.ui.status(playbackStatus(video));
    });
    video.addEventListener('pause', () => {
      if (state?.video !== video || !current(state) || video.ended || state.endedAt !== null) return;
      if (state.started) {
        state.pauseAt = Date.now();
        state.manualPause = !autoResume;
        ports.ui.status(autoResume ? '检测到暂停，等待2秒后尝试恢复' : '视频已暂停，自动恢复已关闭');
      }
    });
    video.addEventListener('ratechange', () => {
      if (state?.video !== video || !current(state) || !state.initialized || ports.app.selecting || video.playbackRate === speed) return;
      state.rateResets += 1;
      if (speed === 2 && (controls.rate2 || controls.rateMenu)) return;
      if (state.rateResets >= 3) {
        state.rateLimited = true;
        ports.ui.status('倍速被重置，请在“设置 → 视频播放与控件”中设置倍速控件');
      } else configure(state);
    });
    video.addEventListener('ended', () => {
      const s = state;
      if (!s || s.video !== video || !current(s) || !video.ended || !s.started || s.endedAt !== null) return;
      s.endedAt = Date.now();
      ports.ui.status('视频已自然结束，等待页面保存进度');
    });
    video.addEventListener('error', () => {
      if (state?.video === video) ports.ui.status('视频加载失败，请先检查页面或网络');
    });
  }

  function recoverPause(s, docs) {
    if (!autoResume || s.manualPause || s.blocked || s.pending || !s.initialized || s.video.ended || s.video.seeking || s.video.error) return;
    const now = Date.now();
    if (s.pauseAt === null) s.pauseAt = now;
    if (now - s.pauseAt < ports.app.CONFIG.resumeDelayMs || now < s.nextResumeAt || s.video.readyState < 2) return;
    if (ports.platform.pauseBlocker(docs)) {
      ports.ui.status('页面有弹窗／弹题，请处理后继续；自动恢复暂缓');
      return;
    }
    s.resumeHistory = s.resumeHistory.filter(at => now - at < 60000);
    if (s.resumeHistory.length >= 6) {
      s.nextResumeAt = s.resumeHistory[0] + 60000;
      ports.ui.status('暂停过于频繁，暂缓恢复；请查看调试记录');
      ports.app.trace('watchdog.cooldown');
      return;
    }
    s.resumeHistory.push(now);
    void play(s, false, true);
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
    if (ports.app.selecting) return;
    releaseRateMenu(state);
    ports.app.selecting = true;
    let menuSelector = '';
    let stage = 0;
    const docs = ports.platform.documents();
    ports.ui.status(kind === 'rate'
      ? '先点击播放器当前倍速按钮（如1.00X），再在展开菜单中选择2倍速；Esc取消'
      : '请点击播放器的扬声器静音按钮（此次照常切换静音）；Esc取消');
    const cleanup = () => {
      clearTimeout(timer);
      ports.app.selecting = false;
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
        doc.removeEventListener('pointerover', captureHover, true);
      }
    };
    const cancel = event => {
      if (event.key === 'Escape') { cleanup(); ports.ui.status('已取消控件标记'); }
    };
    const saveMenu = el => {
      menuSelector = ports.platform.cssPath(el);
      stage = 1;
      // 入口先单独保存：选项每次才挂载时，可在展开后按文字动态查找2倍速。
      if (!saveControls({ rateMenu: menuSelector })) return;
      ports.ui.status('倍速入口已记录，请保持菜单展开并点击上拉菜单里的2倍速；无需返回脚本面板');
    };
    const rateLabel = el => /^(?:\d+(?:\.\d+)?\s*[x×倍]|倍速|播放速度)$/i.test((el.textContent || '').trim());
    const captureHover = event => {
      if (kind !== 'rate' || stage !== 0 || event.composedPath().includes(ports.ui.host)) return;
      const el = labelElement(event.target, rateLabel);
      if (el && ports.platform.available(el)) saveMenu(el);
    };
    const choose = event => {
      if (event.composedPath().includes(ports.ui.host)) return;
      const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
      let el = target.closest('button, a, [role="button"]') || target;
      if (target.closest('video') || !ports.platform.available(el)) return;
      if (kind === 'rate' && stage === 0) {
        el = labelElement(target, rateLabel) || el;
        saveMenu(el);
        return; // 不阻止原点击，让网站照常打开菜单。
      }
      if (kind === 'rate') {
        el = labelElement(target, isTwoSpeed);
        if (!el) { ports.ui.status('入口已记录，请在展开的上拉菜单中选择2倍速；Esc可结束标记并自动查找'); return; }
        if (!saveControls({ rateMenu: menuSelector, rate2: ports.platform.cssPath(el) })) return;
      } else if (!saveControls({ mute: ports.platform.cssPath(el) })) return;
      resetUiAttempts();
      cleanup();
      ports.ui.status(kind === 'rate' ? '已保存2倍速控件；之后优先通过播放器菜单设置' : '已保存静音按钮；之后优先通过播放器按钮静音');
      ports.ui.feedback(kind === 'rate' ? '倍速控件已记住，刷新后自动复用；正在验证效果' : '静音控件已记住，刷新后自动复用；正在验证效果');
      // 原始点击继续执行，保证播放器内部状态也按正常手动操作更新。
    };
    const timer = setTimeout(() => { cleanup(); ports.ui.status('标记已超时，请重试'); }, 60000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
      if (kind === 'rate') doc.addEventListener('pointerover', captureHover, true);
    }
  }

  function markNext() {
    if (ports.app.selecting) return;
    ports.app.selecting = true;
    ports.ui.status('请在30秒内点击页面的下一节按钮（此次仅记录位置）；Esc取消');
    const docs = ports.platform.documents();
    const cleanup = () => {
      clearTimeout(timer);
      ports.app.selecting = false;
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
      }
    };
    const cancel = event => {
      if (event.key === 'Escape') { cleanup(); ports.ui.status('已取消标记'); }
    };
    const choose = event => {
      if (event.composedPath().includes(ports.ui.host)) return;
      const el = event.target.closest('button, a, [role="button"], .next, .next-btn, .next-button') || event.target;
      event.preventDefault();
      event.stopImmediatePropagation();
      ports.platform.savedSelector = ports.platform.cssPath(el);
      GM_setValue(ports.platform.storageKey, ports.platform.savedSelector);
      ports.ui.memorySummary();
      ports.ui.feedback('下一节控件已记住，刷新后自动复用');
      cleanup();
      ports.ui.status('已保存下一节按钮位置；页面布局改变后请重新标记');
    };
    const timer = setTimeout(() => { cleanup(); ports.ui.status('标记已超时，可再次点击“标记下一节按钮”'); }, 30000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
    }
  }

  function markCompletion() {
    if (ports.app.selecting) return;
    ports.app.selecting = true;
    const docs = ports.platform.documents();
    ports.ui.status('请点击视频右上角的完成度百分比；此次只记录位置，Esc取消');
    const cleanup = () => {
      ports.app.selecting = false;
      clearTimeout(timer);
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
      }
    };
    const cancel = event => { if (event.key === 'Escape') { cleanup(); ports.ui.status('已取消完成度识别'); } };
    const choose = event => {
      if (event.composedPath().includes(ports.ui.host)) return;
      let el = event.target.nodeType === 3 ? event.target.parentElement : event.target;
      let value = null;
      for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
        value = completionValue(el, true);
        if (value !== null) break;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (value === null) { ports.ui.status('未读到有效的视频完成度，请点选百分比文字；Esc取消'); return; }
      if (!saveControls({ completion: ports.platform.cssPath(el) })) { cleanup(); return; }
      cleanup();
      ports.app.trace('completion.marked', { percent: value });
      ports.ui.feedback(`完成度位置已记住，当前${value}%；刷新后自动复用`);
      ports.ui.status(`已识别当前视频完成度${value}%`);
    };
    const timer = setTimeout(() => { cleanup(); ports.ui.status('完成度识别已超时'); }, 60000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
    }
  }

  function resume() {
    if (!ports.app.enabled || ports.app.selecting) return;
    if (ports.app.courseMode !== 'video' && ports.app.courseRun?.error) { ports.app.courseRun.error = null; ports.app.courseRun.nextAt = 0; }
    ports.app.safeTick();
    if (!state) return;
    state.manualPause = false;
    state.blocked = false;
    state.pauseAt = null;
    state.nextResumeAt = 0;
    state.resumeHistory = [];
    state.replayStopped = false;
    state.stagnantReplays = 0;
    state.replayBaseline = null;
    state.replayCount = 0;
    resetUiAttempts();
    if (state.video.ended) {
      if (state.advanced) ports.ui.status('下一节尚未加载，请检查页面；避免重复跳转，请手动点击一次下一节');
      else ports.app.safeTick();
      return;
    }
    void play(state, true);
  }

  function toggleAutoResume() {
    autoResume = !autoResume;
    ports.ui.shadow.getElementById('auto-resume').checked = autoResume;
    if (state?.video.paused && !state.video.ended) {
      state.manualPause = !autoResume;
      state.pauseAt = Date.now();
    }
    ports.app.trace('watchdog.toggle', { autoResume });
    ports.ui.status(autoResume ? '自动恢复已开启；主动暂停请点“暂停自动化”' : '自动恢复已关闭');
  }

  function changeSpeed() {
    speed = speed === 2 ? 1 : 2;
    ports.ui.speedNode.textContent = `${speed}×`;
    if (state) { resetUiAttempts(); configure(state); }
    ports.ui.status(`目标速度已改为${speed}倍速`);
  }

  function tick(docs) {
    const video = pickVideo(docs);
    syncForegroundMask(docs, !!video);
    if (!video) {
      releaseRateMenu(state);
      state = null;
      ports.ui.status('等待页面出现视频（跨域播放器无法直接控制）');
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
        completion: { percent: null, source: 'unknown' }, replayCount: 0,
        replayBaseline: null, stagnantReplays: 0, replayStopped: false, skipReason: null,
      };
      bind(video);
      ports.app.trace('video.discovered', { media: mediaState(video) });
      ports.ui.shadow.getElementById('completion').textContent = '当前视频完成度：等待页面就绪';
    }
    if (state.advanced) return;
    if (video.readyState < 1) {
      state.readySince = null;
      state.initialized = false;
      ports.ui.status('等待视频元数据和播放器加载');
      return;
    }
    if (state.readySince === null) state.readySince = Date.now();
    if (!state.initialized) {
      const remaining = ports.app.CONFIG.startupWaitMs - (Date.now() - state.readySince);
      if (remaining > 0 || video.readyState < 2) {
        ports.ui.status(`等待播放器稳定 · ${Math.max(0, Math.ceil(remaining / 1000))}秒`);
        return;
      }
      state.initialized = true;
      ports.app.trace('video.initialized');
      ports.ui.status('播放器已就绪');
    }
    updateCompletion(state, docs);
    if (state.completion.percent === 100) { advance(state, docs); return; }
    if (state.skipReason) { advance(state, docs); return; }
    if (state.replayStopped) return;
    if (video.ended && state.endedAt === null && state.started) state.endedAt = Date.now();
    if (state.endedAt !== null) handleEnded(state, docs);
    else if (!state.manualPause) {
      configure(state);
      if (!video.paused) { state.started = true; state.pauseAt = null; }
      else if (state.started) recoverPause(state, docs);
      else if (!ports.platform.pauseBlocker(docs)) void play(state);
    }
  }

  function suspend(docs) { syncForegroundMask(docs, false); releaseRateMenu(state); state = null; }

  function release() { releaseRateMenu(state); for (const record of [...foregroundRecords.values()]) releaseForeground(record); }

  function clearControlMarkers() {
    controls = {}; GM_setValue(controlsKey, controls);
    ports.ui.memorySummary(); resetUiAttempts(); ports.ui.status('已清除播放器控件标记');
  }

  function catalogCompletion(item) {
    const row = item?.element && (item.element.closest?.('.leaf-item') || item.element), badge = row?.querySelector?.('.leaf-item-status');
    if (!badge) return null;
    if (badge.querySelector('.icon-yuanquangou-mianzhuang')) return 100;
    const value = badge.querySelector('.status-pie')?.style?.getPropertyValue('--p')?.trim();
    return value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 100 ? Number(value) : null;
  }

  const api = {
    get catalogCompletion() { return catalogCompletion; },
    get clearControlMarkers() { return clearControlMarkers; },
    get release() { return release; },
    get suspend() { return suspend; },
    get tick() { return tick; },
    get autoResume() { return autoResume; }, set autoResume(value) { autoResume = value; },
    get changeSpeed() { return changeSpeed; },
    get controlChain() { return controlChain; },
    get controls() { return controls; }, set controls(value) { controls = value; },
    get controlsKey() { return controlsKey; },
    get current() { return current; },
    get foregroundMask() { return foregroundMask; }, set foregroundMask(value) { foregroundMask = value; },
    get foregroundRecords() { return foregroundRecords; },
    get markCompletion() { return markCompletion; },
    get markNext() { return markNext; },
    get markPlayerControl() { return markPlayerControl; },
    get markedControl() { return markedControl; },
    get mediaState() { return mediaState; },
    get nativeForeground() { return nativeForeground; },
    get playbackStatus() { return playbackStatus; },
    get releaseRateMenu() { return releaseRateMenu; },
    get resetUiAttempts() { return resetUiAttempts; },
    get resume() { return resume; },
    get speed() { return speed; }, set speed(value) { speed = value; },
    get speedMenu() { return speedMenu; },
    get state() { return state; }, set state(value) { state = value; },
    get syncForegroundMask() { return syncForegroundMask; },
    get toggleAutoResume() { return toggleAutoResume; },
    get toggleForegroundMask() { return toggleForegroundMask; },
  };
  if (options.testing) api.testing = {
    get controlsKey() { return controlsKey; },
    get storedControls() { return storedControls; },
    get controls() { return controls; }, set controls(value) { controls = value; },
    get autoResume() { return autoResume; }, set autoResume(value) { autoResume = value; },
    get foregroundKey() { return foregroundKey; },
    get foregroundMask() { return foregroundMask; }, set foregroundMask(value) { foregroundMask = value; },
    get foregroundRecords() { return foregroundRecords; },
    get speed() { return speed; }, set speed(value) { speed = value; },
    get state() { return state; }, set state(value) { state = value; },
    get observed() { return observed; },
    get stateId() { return stateId; }, set stateId(value) { stateId = value; },
    get saveControls() { return saveControls; }, set saveControls(value) { saveControls = value; },
    get rememberXtControls() { return rememberXtControls; }, set rememberXtControls(value) { rememberXtControls = value; },
    get mediaState() { return mediaState; }, set mediaState(value) { mediaState = value; },
    get playbackStatus() { return playbackStatus; }, set playbackStatus(value) { playbackStatus = value; },
    get descriptorOf() { return descriptorOf; }, set descriptorOf(value) { descriptorOf = value; },
    get nativeForeground() { return nativeForeground; }, set nativeForeground(value) { nativeForeground = value; },
    get notifyVisibility() { return notifyVisibility; }, set notifyVisibility(value) { notifyVisibility = value; },
    get releaseForeground() { return releaseForeground; }, set releaseForeground(value) { releaseForeground = value; },
    get syncForegroundMask() { return syncForegroundMask; }, set syncForegroundMask(value) { syncForegroundMask = value; },
    get toggleForegroundMask() { return toggleForegroundMask; }, set toggleForegroundMask(value) { toggleForegroundMask = value; },
    get source() { return source; }, set source(value) { source = value; },
    get current() { return current; }, set current(value) { current = value; },
    get pickVideo() { return pickVideo; }, set pickVideo(value) { pickVideo = value; },
    get markedControl() { return markedControl; }, set markedControl(value) { markedControl = value; },
    get isTwoSpeed() { return isTwoSpeed; }, set isTwoSpeed(value) { isTwoSpeed = value; },
    get labelElement() { return labelElement; }, set labelElement(value) { labelElement = value; },
    get twoSpeedOption() { return twoSpeedOption; }, set twoSpeedOption(value) { twoSpeedOption = value; },
    get speedMenu() { return speedMenu; }, set speedMenu(value) { speedMenu = value; },
    get releaseRateMenu() { return releaseRateMenu; }, set releaseRateMenu(value) { releaseRateMenu = value; },
    get expandXtMenu() { return expandXtMenu; }, set expandXtMenu(value) { expandXtMenu = value; },
    get controlChain() { return controlChain; }, set controlChain(value) { controlChain = value; },
    get hoverMenu() { return hoverMenu; }, set hoverMenu(value) { hoverMenu = value; },
    get inputPosition() { return inputPosition; }, set inputPosition(value) { inputPosition = value; },
    get selectRateOption() { return selectRateOption; }, set selectRateOption(value) { selectRateOption = value; },
    get setRateProperties() { return setRateProperties; }, set setRateProperties(value) { setRateProperties = value; },
    get nativeSettings() { return nativeSettings; }, set nativeSettings(value) { nativeSettings = value; },
    get configure() { return configure; }, set configure(value) { configure = value; },
    get play() { return play; }, set play(value) { play = value; },
    get completionValue() { return completionValue; }, set completionValue(value) { completionValue = value; },
    get readCompletion() { return readCompletion; }, set readCompletion(value) { readCompletion = value; },
    get updateCompletion() { return updateCompletion; }, set updateCompletion(value) { updateCompletion = value; },
    get replay() { return replay; }, set replay(value) { replay = value; },
    get advance() { return advance; }, set advance(value) { advance = value; },
    get handleEnded() { return handleEnded; }, set handleEnded(value) { handleEnded = value; },
    get bind() { return bind; }, set bind(value) { bind = value; },
    get recoverPause() { return recoverPause; }, set recoverPause(value) { recoverPause = value; },
    get resetUiAttempts() { return resetUiAttempts; }, set resetUiAttempts(value) { resetUiAttempts = value; },
    get markPlayerControl() { return markPlayerControl; }, set markPlayerControl(value) { markPlayerControl = value; },
    get markNext() { return markNext; }, set markNext(value) { markNext = value; },
    get markCompletion() { return markCompletion; }, set markCompletion(value) { markCompletion = value; },
    get resume() { return resume; }, set resume(value) { resume = value; },
    get toggleAutoResume() { return toggleAutoResume; }, set toggleAutoResume(value) { toggleAutoResume = value; },
    get changeSpeed() { return changeSpeed; }, set changeSpeed(value) { changeSpeed = value; }
  };
  return api;
}
module.exports = createVideoAutomation;
