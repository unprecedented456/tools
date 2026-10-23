const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'yuketang-autoplay.user.js'), 'utf8');

function fixture({ blocked = false, labels = ['下一视频'], nativeControls = false, boot = true, readyState = 2, hoverMenu = false, menuDelay = 0, playErrors = [], dynamicMenu = false, textRate = false, noOpOption = false, writableRate = false, catalog = [], initialUrl, noVideo = false, phantomHeader = false, xtMenu = false, blockedXt = false, strictInput = false, xtMotionGate = false, memory = new Map(), storageError = false } = {}) {
  let now = 100000;
  let interval;
  const elements = new Map();
  const listeners = new Map();
  const nativeNodes = new Map();
  const documentListeners = new Map();
  const savedValues = memory;
  let nativeMenuOpen = false;
  let nativeMenuReadyAt = 0;
  let dialogVisible = false;
  const downloads = [];
  const blobs = new Map();
  const location = { origin: 'https://pro.yuketang.cn', href: initialUrl || 'https://pro.yuketang.cn/course/video/1' };
  const element = (text = '') => ({
    textContent: text, isConnected: true, disabled: false, clicks: 0,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
    getAttribute: () => null,
    setAttribute() {},
    closest(selector) { return selector.includes('[disabled]') ? null : this; },
    addEventListener(name, handler) { this.handlers ??= {}; this.handlers[name] = handler; },
    click() { this.clicks += 1; this.handlers?.click?.({}); },
  });
  const doc = {
    querySelector(selector) { return selector === 'video' && !noVideo ? video : null; },
    addEventListener(name, handler) {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set());
      documentListeners.get(name).add(handler);
    },
    removeEventListener(name, handler) { documentListeners.get(name)?.delete(handler); },
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MouseEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } } },
    documentElement: { append(el) { el.isConnected = true; } },
    querySelectorAll(selector) {
      if (selector === 'video') return noVideo ? [] : [video];
      if (selector === 'iframe') return [];
      if (selector === 'xt-speedvalue') return xtMenu ? [nativeNodes.get('#native-speed-menu')] : [];
      if (xtMenu && selector === 'xt-speedbutton xt-speedvalue') return [nativeNodes.get('#native-speed-menu')];
      if (xtMenu && selector === 'xt-speedbutton li[data-speed="2"]') return [nativeNodes.get('#native-speed-2')];
      if (xtMenu && selector === 'xt-volumebutton xt-icon') return [nativeNodes.get('#native-mute')];
      if (selector.startsWith('button,')) return buttons;
      if (selector.startsWith('a[href],')) return phantomHeader ? [...catalogRows, phantomHeaderNode] : catalogRows;
      if (selector.startsWith('dialog[open]')) return dialogVisible ? [dialog] : [];
      if (selector.startsWith('li,')) return nativeNodes.has('#native-speed-2') && (!dynamicMenu || nativeMenuOpen && now >= nativeMenuReadyAt) ? [nativeNodes.get('#native-speed-2')] : [];
      if (selector === '#native-speed-2' && dynamicMenu && (!nativeMenuOpen || now < nativeMenuReadyAt)) return [];
      if (nativeNodes.has(selector)) return [nativeNodes.get(selector)];
      return [];
    },
  };
  const video = Object.assign(element(), {
    src: 'https://media.example/1.mp4', currentSrc: '', readyState,
    paused: true, ended: false, muted: false, playbackRate: 1, loop: true, playCalls: 0,
    querySelector: () => null,
    addEventListener(name, handler) {
      const handlers = listeners.get(name) || [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
    emit(name) { for (const fn of listeners.get(name) || []) fn({}); },
    async play() {
      this.playCalls += 1;
      if (playErrors.length) throw Object.assign(new Error('transient'), { name: playErrors.shift() });
      if (blocked) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      this.paused = false;
      this.emit('playing');
    },
    pause() { this.paused = true; this.emit('pause'); },
  });
  // 写入时间或调用网络接口都会直接令测试失败。
  Object.defineProperty(video, 'currentTime', { get: () => 42, set() { throw Error('不应改写播放时间'); } });
  const buttons = labels.map(label => Object.assign(element(label), { ownerDocument: doc }));
  video.ownerDocument = doc;
  video.getBoundingClientRect = () => ({ left: 400, right: 1200, width: 800, height: 450 });
  const dialog = Object.assign(element('弹题'), { ownerDocument: doc });
  const catalogRows = catalog.map((item, index) => {
    const row = Object.assign(element(`${item.type === 'video' ? '视频' : item.type === 'exam' ? '考试' : '作业'} ${item.name || index}`), {
      ownerDocument: doc, localName: 'a', order: index,
      querySelector: () => null,
      contains: () => false,
      getAttribute(attr) { return attr === 'href' ? item.href || null : attr === 'data-resource-type' ? item.type : null; },
      matches(selector) { return selector === 'a[href]' ? !!item.href : !!item.active; },
      closest(selector) {
        if (selector.startsWith('aside,')) return this;
        if (selector.includes('[disabled]')) return item.locked ? this : null;
        if (selector.includes('[aria-current')) return item.active ? this : null;
        return null;
      },
      compareDocumentPosition(other) { return this.order < other.order ? 4 : 2; },
      getBoundingClientRect: () => ({ left: 0, right: 300, width: 300, height: 40 }),
    });
    row.addEventListener('click', () => { if (item.href) location.href = new URL(item.href, location.href).href; });
    return row;
  });
  const phantomHeaderNode = Object.assign(element('视频 当前播放标题'), {
    ownerDocument: doc, localName: 'div', className: 'header-left',
    querySelector: () => null, contains: () => false, matches: () => false,
    getAttribute: attr => attr === 'data-resource-type' ? 'video' : null,
    closest(selector) { return selector.includes('[class*="left"]') ? this : null; },
    compareDocumentPosition: () => 2,
    getBoundingClientRect: () => ({ left: 420, right: 1200, width: 780, height: 40 }),
  });
  if (nativeControls) {
    // 模拟播放器：直接修改媒体属性会被内部设置覆盖，必须点击自己的控件。
    let actualRate = 1;
    let actualMuted = false;
    Object.defineProperties(video, {
      playbackRate: { configurable: true, get: () => actualRate, set(value) { actualRate = writableRate ? value : 1; } },
      muted: { configurable: true, get: () => actualMuted, set() { actualMuted = false; } },
    });
    const menu = Object.assign(element('1.00X'), { ownerDocument: doc });
    const option = Object.assign(element('2.00X'), { ownerDocument: doc });
    const mute = Object.assign(element('静音'), { ownerDocument: doc });
    option.getClientRects = () => nativeMenuOpen && now >= nativeMenuReadyAt ? [{}] : [];
    menu.addEventListener('click', () => { nativeMenuOpen = !nativeMenuOpen; nativeMenuReadyAt = now + menuDelay; });
    menu.dispatchEvent = event => {
      if (hoverMenu && event.type === 'mouseover') { nativeMenuOpen = true; nativeMenuReadyAt = now + menuDelay; }
    };
    option.addEventListener('click', () => { if (!noOpOption) actualRate = 2; nativeMenuOpen = false; });
    mute.addEventListener('click', () => { actualMuted = !actualMuted; });
    nativeNodes.set('#native-speed-menu', menu);
    nativeNodes.set('#native-speed-2', option);
    nativeNodes.set('#native-mute', mute);
    for (const [selector, el] of nativeNodes) {
      el.id = selector.slice(1);
      el.nodeType = 1;
      el.localName = 'button';
      el.closest = selector => selector === 'video' || selector.includes('[disabled]') ? null : el;
      el.click = function () {
        this.clicks += 1;
        let prevented = false;
        const event = {
          target: this, composedPath: () => [this, doc],
          preventDefault() { prevented = true; }, stopImmediatePropagation() {},
        };
        for (const fn of [...documentListeners.get('click') || []]) fn(event);
        if (!prevented) this.handlers?.click?.(event);
      };
    }
    if (xtMenu) {
      const style = () => {
        const values = new Map();
        return { getPropertyValue: key => values.get(key)?.value || '', getPropertyPriority: key => values.get(key)?.priority || '',
          setProperty(key, value, priority = '') { values.set(key, { value, priority }); }, removeProperty(key) { values.delete(key); } };
      };
      const root = Object.assign(element(), { localName: 'xt-speedbutton', ownerDocument: doc, style: style(), contains: el => [menu, list, option].includes(el), querySelectorAll: () => [option] });
      const list = Object.assign(element(), { localName: 'ul', ownerDocument: doc, style: style(), parentElement: root });
      menu.localName = 'xt-speedvalue'; menu.parentElement = root;
      option.localName = 'li'; option.parentElement = list;
      // 入口点击和合成悬停均不能触发 CSS :hover，复现实际日志。
      menu.handlers.click = () => {};
      menu.dispatchEvent = () => {};
      option.getClientRects = () => !blockedXt && list.style.getPropertyValue('display') === 'block' ? [{}] : [];
      option.handlers.click = () => { if (!noOpOption && option.getClientRects().length) actualRate = 2; };
      doc.defaultView.getComputedStyle = el => ({ display: el.style?.getPropertyValue('display') || (el === list ? 'none' : 'block'),
        visibility: 'visible', opacity: '1', height: 'auto', overflow: 'visible', pointerEvents: 'auto' });
      nativeNodes.set('#xt-list', list);
      nativeNodes.set('#xt-root', root);
      if (strictInput) {
        // 来自用户提供的 30101.8b622f27.js / speed()：
        // mouseover 记录 s,d；mousemove 设置 a=两点距离；click 仅在 a 非零时处理。
        let a = false, s = 0, d = 0;
        const motion = event => {
          if (event.type === 'mouseover') { s = event.clientX; d = event.clientY; }
          if (event.type === 'mousemove') a = Math.sqrt(Math.pow(event.clientX - s, 2) + Math.pow(event.clientY - d, 2));
          if (event.type === 'mouseout') { a = false; s = d = 0; }
        };
        root.dispatchEvent = event => { motion(event); return true; };
        doc.defaultView.PointerEvent = doc.defaultView.MouseEvent;
        option.closest = selector => selector === 'xt-speedbutton' ? root : selector.includes('[disabled]') ? null : option;
        const events = [];
        option.inputEvents = events;
        option.dispatchEvent = event => {
          event.target = option;
          event.composedPath = () => [option, list, root, doc];
          for (const handler of documentListeners.get(event.type) || []) handler(event);
          events.push(event);
          motion(event); // 选项的鼠标事件向倍速入口冒泡。
          if (event.type === 'click') {
            option.clicks += 1;
            const down = events.findLast(item => item.type === 'pointerdown');
            if ((!xtMotionGate || a) && event.detail === 1 && event.clientX > 0 && event.clientY > 0 && down?.buttons === 1) option.handlers.click(event);
          }
          return true;
        };
      }
    }
  }
  const host = {
    attachShadow: () => ({
      set innerHTML(_) {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    }),
    contains: () => false,
  };
  doc.createElement = tag => tag === 'a' ? {
    click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); }, remove() {},
  } : host;
  vm.runInNewContext(script, {
    document: doc, location,
    GM_getValue: (key, fallback) => savedValues.has(key) ? savedValues.get(key) : nativeControls === true && key.startsWith('player-controls:')
      ? { rateMenu: '#native-speed-menu', rate2: textRate ? '#stale-option' : '#native-speed-2', mute: '#native-mute' } : fallback,
    GM_setValue(key, value) { if (storageError) throw new Error('storage failed'); savedValues.set(key, value); }, GM_registerMenuCommand() {},
    CSS: { escape: value => value },
    Blob, URL: class extends URL { static createObjectURL(blob) { const id = `blob:${blobs.size}`; blobs.set(id, blob); return id; } static revokeObjectURL() {} },
    Date: { now: () => now },
    setInterval(fn) { interval = fn; }, setTimeout() {}, clearTimeout() {},
    fetch() { throw Error('不应自行请求进度接口'); },
  });
  if (boot) { now += 4000; interval(); }
  return {
    video, buttons, location, nativeNodes, savedValues, downloads, catalogRows, phantomHeaderNode,
    setDialog(value) { dialogVisible = value; },
    dispatchDoc(name, event) { for (const fn of [...documentListeners.get(name) || []]) fn(event); },
    tick(ms = 1000) { now += ms; interval(); },
    end() { video.ended = true; video.paused = true; video.emit('ended'); },
    ui(id) { return elements.get(id); },
    unblock() { blocked = false; },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('XT控件自动记忆稳定选择器，重新加载脚本后自动复用', async () => {
  const memory = new Map();
  const first = fixture({ nativeControls: 'unmarked', xtMenu: true, strictInput: true, xtMotionGate: true, memory });
  await settle(); first.tick(); first.tick();
  const saved = memory.get('player-controls:https://pro.yuketang.cn');
  assert.equal(saved.rateMenu, 'xt-speedbutton xt-speedvalue');
  assert.equal(saved.rate2, 'xt-speedbutton li[data-speed="2"]');
  assert.equal(saved.mute, 'xt-volumebutton xt-icon');
  const second = fixture({ nativeControls: 'unmarked', xtMenu: true, strictInput: true, xtMotionGate: true, memory });
  assert.match(second.ui('memory').textContent, /已记住：倍速、静音/);
  await settle(); second.tick(); second.tick();
  assert.equal(second.video.playbackRate, 2);
  assert.equal(second.video.muted, true);
  assert.match(second.ui('setup-result').textContent, /设置成功/);
});

test('实际效果稳定后才提示成功，提示不会被播放状态覆盖', async () => {
  const f = fixture();
  await settle();
  assert.doesNotMatch(f.ui('setup-result').textContent, /设置成功/);
  f.tick();
  assert.match(f.ui('setup-result').textContent, /设置成功 · 2倍速 · 静音/);
  assert.match(f.ui('feedback').textContent, /设置成功/);
  f.video.emit('playing');
  assert.match(f.ui('setup-result').textContent, /设置成功/);
  f.tick(9000);
  assert.equal(f.ui('feedback').hidden, true);
  assert.match(f.ui('setup-result').textContent, /设置成功/);
});

test('点击无效时不报设置成功，保存记忆与生效结果分开', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, strictInput: true, noOpOption: true });
  await settle(); for (let i = 0; i < 20; i++) f.tick();
  assert.match(f.ui('memory').textContent, /已记住/);
  assert.doesNotMatch(f.ui('setup-result').textContent, /设置成功/);
  f.ui('diagnose').click();
  assert.equal(JSON.parse(f.ui('diagnostics').value).state.settingsConfirmed, false);
});

test('保存失败时明确提示，不能声称已记住控件', async () => {
  const f = fixture({ nativeControls: 'unmarked', xtMenu: true, storageError: true });
  await settle();
  assert.match(f.ui('feedback').textContent, /未能保存/);
  assert.equal(f.savedValues.size, 0);
  assert.doesNotMatch(f.ui('memory').textContent, /已记住/);
});

test('下一节标记在重新加载后保留，显示记忆反馈', async () => {
  const memory = new Map();
  memory.set('next-selector:https://pro.yuketang.cn', '#saved-next');
  const f = fixture({ memory });
  await settle();
  assert.match(f.ui('memory').textContent, /已记住：下一节/);
  assert.match(f.ui('feedback').textContent, /已加载记住的控件/);
});

test('真实XT逻辑：零位移点击无效，非零位移才改变倍速', () => {
  const f = fixture({ nativeControls: true, xtMenu: true, strictInput: true, xtMotionGate: true, boot: false });
  const option = f.nativeNodes.get('#native-speed-2');
  f.nativeNodes.get('#xt-list').style.setProperty('display', 'block');
  const send = (type, x) => option.dispatchEvent({ type, clientX: x, clientY: 200, buttons: type === 'pointerdown' ? 1 : 0, detail: 1 });
  send('mouseover', 100); send('mousemove', 100); send('pointerdown', 100); send('click', 100);
  assert.equal(f.video.playbackRate, 1);
  send('mousemove', 102); send('click', 102);
  assert.equal(f.video.playbackRate, 2);
  f.video.playbackRate = 1;
  send('mouseover', 102); send('mousemove', 102); send('click', 102);
  assert.equal(f.video.playbackRate, 1); // 再次mouseover后，同点mousemove又将位移归零。
});

test('自动选择满足XT源码的非零位移条件，换视频后也能恢复2倍速', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, strictInput: true, xtMotionGate: true });
  await settle(); f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  f.video.src = 'https://media.example/next.mp4';
  f.video.playbackRate = 1;
  f.tick(); f.tick(4000); f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.state.rateDirectAttempts, 0);
  assert.equal(report.debugEvents.filter(event => event.event === 'rate.verify' && event.applied).length, 2);
});

test('XT补齐选项中心坐标、PointerEvent和左键状态后选择2倍速', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, strictInput: true });
  await settle();
  f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  const option = f.nativeNodes.get('#native-speed-2');
  const types = option.inputEvents.map(event => event.type);
  assert.ok(types.indexOf('pointerdown') < types.indexOf('pointerup'));
  assert.ok(types.indexOf('pointerup') < types.indexOf('click'));
  assert.equal(types.filter(type => type === 'click').length, 1);
  const down = option.inputEvents.find(event => event.type === 'pointerdown');
  assert.equal(down.buttons, 1);
  assert.equal(down.isPrimary, true);
  assert.equal(down.pointerType, 'mouse');
  assert.equal(option.inputEvents.at(-1).detail, 1);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.controlInputEvents.some(event => event.type === 'click' && event.clientX > 0 && event.trusted === false), true);
});

test('输入诊断区分真实手动事件，单独保存最近80条控件输入', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, strictInput: true });
  await settle(); f.tick(); f.tick();
  const option = f.nativeNodes.get('#native-speed-2');
  const root = f.nativeNodes.get('#xt-root');
  for (let i = 0; i < 100; i++) f.dispatchDoc('click', { target: option, type: 'click', isTrusted: true,
    button: 0, buttons: 0, detail: 1, clientX: 123, clientY: 456, composedPath: () => [option, root] });
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.controlInputEvents.length, 80);
  assert.equal(report.controlInputEvents.every(event => event.trusted), true);
});

test('XT CSS悬停上拉列表先显示再点击，选择后还原样式', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true });
  await settle();
  const option = f.nativeNodes.get('#native-speed-2');
  const list = f.nativeNodes.get('#xt-list');
  assert.equal(f.video.playbackRate, 1);
  assert.equal(option.clicks, 0);
  assert.equal(list.style.getPropertyValue('display'), 'block');
  f.tick();
  assert.equal(option.clicks, 1);
  assert.equal(f.video.playbackRate, 2);
  f.tick();
  assert.equal(list.style.getPropertyValue('display'), '');
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.debugEvents.some(e => e.event === 'menu.expand' && e.visible), true);
  assert.equal(report.debugEvents.find(e => e.event === 'menu.option.click').target.visible, true);
  assert.equal(report.debugEvents.some(e => e.event === 'rate.verify' && e.applied), true);
  assert.equal(report.state.rateDirectAttempts, 0);
});

test('自动识别未标记的XT入口，不要求重新标记上拉选项', async () => {
  const f = fixture({ nativeControls: 'unmarked', xtMenu: true });
  await settle();
  f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.nativeNodes.get('#native-speed-2').clicks, 1);
});

test('XT选项显示失败时禁止点击隐藏选项，不用属性写入冒充成功', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, blockedXt: true });
  await settle();
  for (let i = 0; i < 30; i++) f.tick();
  assert.equal(f.nativeNodes.get('#native-speed-2').clicks, 0);
  assert.equal(f.video.playbackRate, 1);
  assert.equal(f.nativeNodes.get('#xt-list').style.getPropertyValue('display'), '');
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.state.rateDirectAttempts, 0);
  assert.equal(report.debugEvents.filter(e => e.event === 'menu.timeout').length, 3);
});

test('XT展开期间暂停自动化立即恢复列表样式', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true });
  await settle();
  assert.equal(f.nativeNodes.get('#xt-list').style.getPropertyValue('display'), 'block');
  f.ui('toggle').click();
  assert.equal(f.nativeNodes.get('#xt-list').style.getPropertyValue('display'), '');
  assert.equal(f.nativeNodes.get('#native-speed-2').clicks, 0);
});

test('XT控件点击无效时验证失败，最多重试3次且恢复样式', async () => {
  const f = fixture({ nativeControls: true, xtMenu: true, noOpOption: true });
  await settle();
  for (let i = 0; i < 20; i++) f.tick();
  assert.equal(f.nativeNodes.get('#native-speed-2').clicks, 3);
  assert.equal(f.video.playbackRate, 1);
  assert.equal(f.nativeNodes.get('#xt-list').style.getPropertyValue('display'), '');
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.state.rateDirectAttempts, 0);
  assert.equal(report.debugEvents.filter(e => e.event === 'rate.verify' && !e.applied).length, 3);
});

test('初始化静音、2倍速并正常播放，不改时间或请求进度接口', async () => {
  const f = fixture();
  await settle();
  assert.equal(f.video.playCalls, 1);
  assert.equal(f.video.muted, true);
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.video.currentTime, 42);
  assert.equal(f.video.loop, false);
  f.tick(60000);
  assert.equal(f.buttons[0].clicks, 0);
});

test('自然结束后等待15秒，再仅点击一次原页面按钮', async () => {
  const f = fixture();
  await settle();
  f.end();
  f.tick(14999);
  assert.equal(f.buttons[0].clicks, 0);
  f.tick(1);
  assert.equal(f.buttons[0].clicks, 1);
  f.tick(60000);
  assert.equal(f.buttons[0].clicks, 1);
});

test('伪造ended事件但视频并未结束，不跳下一节', async () => {
  const f = fixture();
  await settle();
  f.video.emit('ended');
  f.tick(60000);
  assert.equal(f.buttons[0].clicks, 0);
});

test('网站自行切换路由时取消旧视频跳转', async () => {
  const f = fixture();
  await settle();
  f.end();
  f.location.href = 'https://pro.yuketang.cn/course/video/2';
  f.tick(16000);
  assert.equal(f.buttons[0].clicks, 0);
});

test('同一video节点换源后重新播放，旧视频不再跳转', async () => {
  const f = fixture();
  await settle();
  f.end();
  f.video.src = 'https://media.example/2.mp4';
  f.video.ended = false;
  f.tick(16000);
  f.tick(4000);
  await settle();
  assert.equal(f.buttons[0].clicks, 0);
  assert.equal(f.video.playCalls, 2);
  f.end();
  f.tick(15000);
  assert.equal(f.buttons[0].clicks, 1);
});

test('浏览器禁止自动播放后不反复重试，用户点击可继续', async () => {
  const f = fixture({ blocked: true });
  await settle();
  f.tick(); f.tick();
  assert.equal(f.video.playCalls, 1);
  assert.match(f.ui('status').textContent, /浏览器阻止/);
  f.unblock();
  f.ui('resume').click();
  await settle();
  assert.equal(f.video.playCalls, 2);
  assert.equal(f.video.paused, false);
});

test('关闭自动恢复后尊重暂停，用户仍可点击继续', async () => {
  const f = fixture();
  await settle();
  f.ui('auto-resume').click();
  f.video.pause();
  f.tick(30000);
  assert.equal(f.video.playCalls, 1);
  f.ui('resume').click();
  await settle();
  assert.equal(f.video.playCalls, 2);
});

test('不把下一页、下一题或含下一视频的长文本当作按钮', async () => {
  const f = fixture({ labels: ['下一页', '下一题', '这里介绍下一视频的内容'] });
  await settle();
  f.end(); f.tick(15000);
  assert.equal(f.buttons.reduce((n, b) => n + b.clicks, 0), 0);
});

test('多个候选或禁用按钮时停止跳转', async () => {
  const multiple = fixture({ labels: ['下一视频', '下一节'] });
  await settle();
  multiple.end(); multiple.tick(15000);
  assert.equal(multiple.buttons.reduce((n, b) => n + b.clicks, 0), 0);
  const disabled = fixture();
  await settle();
  disabled.buttons[0].disabled = true;
  disabled.end(); disabled.tick(15000);
  assert.equal(disabled.buttons[0].clicks, 0);
});

test('页面三次重置速度后不再强制倍速，可手动切换1倍速', async () => {
  const f = fixture();
  await settle();
  for (let i = 0; i < 3; i++) { f.video.playbackRate = 1; f.video.emit('ratechange'); }
  f.tick();
  assert.equal(f.video.playbackRate, 1);
  assert.match(f.ui('status').textContent, /倍速被重置/);
  f.ui('speed').click();
  assert.equal(f.video.playbackRate, 1);
});

test('暂停自动化后不会在视频结束时点击下一节', async () => {
  const f = fixture();
  await settle();
  f.ui('toggle').click();
  f.end(); f.tick(60000);
  assert.equal(f.buttons[0].clicks, 0);
  assert.equal(f.video.paused, true);
});

test('诊断报告显示实际媒体状态，且不导出视频地址', async () => {
  const f = fixture();
  await settle();
  f.video.playbackRate = 1;
  f.video.muted = false;
  f.ui('diagnose').click();
  const text = f.ui('diagnostics').value;
  const report = JSON.parse(text);
  assert.equal(report.scriptVersion, '1.3.5');
  assert.equal(report.targetSpeed, 2);
  assert.equal(report.videos[0].selected, true);
  assert.equal(report.videos[0].playbackRate, 1);
  assert.equal(report.videos[0].muted, false);
  assert.equal(text.includes('media.example'), false);
  assert.equal(text.includes('course/video'), false);
});

test('轮询发生属性设置异常时保留报错并允许导出诊断', async () => {
  const f = fixture();
  await settle();
  Object.defineProperty(f.video, 'muted', {
    get() { return false; },
    set() { throw Object.assign(new Error('setter denied'), { name: 'SecurityError' }); },
  });
  assert.doesNotThrow(() => f.tick());
  assert.match(f.ui('status').textContent, /SecurityError/);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.lastError.name, 'SecurityError');
  assert.equal(report.lastError.message, 'setter denied');
});

test('原始属性会被覆盖时，通过已标记控件设置2倍速和静音', async () => {
  const f = fixture({ nativeControls: true });
  await settle();
  assert.equal(f.video.playbackRate, 1);
  assert.equal(f.video.muted, true);
  assert.equal(f.nativeNodes.get('#native-speed-menu').clicks, 1);
  f.tick(); f.tick(); // 先展开入口，再等待菜单挂载并选择2倍速。
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.video.muted, true);
  assert.equal(f.nativeNodes.get('#native-speed-2').clicks, 1);
  f.tick(60000);
  assert.equal(f.nativeNodes.get('#native-mute').clicks, 1); // 已静音时不再切成有声音。
});

test('已标记控件在播放器再次恢复默认值时重新同步', async () => {
  const f = fixture({ nativeControls: true });
  await settle();
  f.tick(); f.tick();
  f.video.playbackRate = 1;
  f.video.muted = false;
  f.tick(3000);
  f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.video.muted, true);
  assert.equal(f.nativeNodes.get('#native-mute').clicks, 2);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.markedControls.rate2, true);
  assert.equal(report.state.rateUiAttempts, 2);
});

test('控件重试有上限，失效的静音操作不会每秒无限点击', async () => {
  const f = fixture({ nativeControls: true });
  await settle();
  f.nativeNodes.get('#native-mute').handlers.click = () => {};
  f.video.muted = false;
  for (let i = 0; i < 10; i++) f.tick(3000);
  assert.equal(f.nativeNodes.get('#native-mute').clicks, 3);
  assert.match(f.ui('actual').textContent, /有声音/);
});

test('正常播放提示以真实静音状态为准', async () => {
  const f = fixture();
  await settle();
  f.video.muted = false;
  f.video.volume = 1;
  f.video.emit('playing');
  f.ui('diagnose').click();
  assert.match(JSON.parse(f.ui('diagnostics').value).status, /有声音/);
});

test('首次标记保留网站原点击行为，保存后可自动重设倍速静音', async () => {
  const f = fixture({ nativeControls: 'unmarked' });
  await settle();
  f.ui('mark-rate').click();
  f.nativeNodes.get('#native-speed-menu').click();
  assert.match(f.ui('status').textContent, /入口已记录/);
  f.nativeNodes.get('#native-speed-2').click();
  assert.equal(f.video.playbackRate, 2);
  f.ui('mark-mute').click();
  f.nativeNodes.get('#native-mute').click();
  assert.equal(f.video.muted, true);
  const saved = f.savedValues.get('player-controls:https://pro.yuketang.cn');
  assert.equal(saved.rateMenu, '#native-speed-menu');
  assert.equal(saved.rate2, '#native-speed-2');
  assert.equal(saved.mute, '#native-mute');
  f.video.playbackRate = 1;
  f.video.muted = false;
  f.tick(); f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.video.muted, true);
});

test('视频就绪后等待4秒再启动，加载缓慢时不提前消耗播放次数', async () => {
  const f = fixture({ boot: false, readyState: 0 });
  f.tick(15000);
  assert.equal(f.video.playCalls, 0);
  f.video.readyState = 2;
  f.tick();
  f.tick(3999);
  assert.equal(f.video.playCalls, 0);
  f.tick(1);
  await settle();
  assert.equal(f.video.playCalls, 1);
});

test('检测到意外暂停后恢复，并记录恢复原因', async () => {
  const f = fixture();
  await settle();
  f.tick(1000);
  f.video.pause();
  f.tick(1999);
  assert.equal(f.video.playCalls, 1);
  f.tick(1);
  await settle();
  assert.equal(f.video.playCalls, 2);
  assert.equal(f.video.paused, false);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.debugEvents.some(e => e.event === 'watchdog.resume'), true);
});

test('即使漏掉pause事件，轮询也能发现并恢复暂停', async () => {
  const f = fixture();
  await settle();
  f.video.paused = true;
  f.tick();
  f.tick(3000);
  await settle();
  assert.equal(f.video.paused, false);
});

test('弹窗期间不恢复，关闭弹窗后再恢复', async () => {
  const f = fixture();
  await settle();
  f.setDialog(true);
  f.video.pause();
  f.tick(4000);
  await settle();
  assert.equal(f.video.playCalls, 1);
  f.setDialog(false);
  f.tick();
  await settle();
  assert.equal(f.video.playCalls, 2);
});

test('播放器未就绪、正在拖动或媒体出错时不强行恢复', async () => {
  const f = fixture();
  await settle();
  f.video.pause();
  f.video.readyState = 1;
  f.tick(4000);
  assert.equal(f.video.playCalls, 1);
  f.video.readyState = 2;
  f.video.seeking = true;
  f.tick(4000);
  assert.equal(f.video.playCalls, 1);
  f.video.seeking = false;
  f.video.error = { code: 2 };
  f.tick(4000);
  assert.equal(f.video.playCalls, 1);
});

test('AbortError作为加载瞬态错误延迟重试，而非永久禁止播放', async () => {
  const f = fixture({ playErrors: ['AbortError'] });
  await settle();
  assert.equal(f.video.playCalls, 1);
  f.tick(3000);
  await settle();
  assert.equal(f.video.playCalls, 2);
  assert.equal(f.video.paused, false);
});

test('频繁暂停触发恢复限流，不无限调用play', async () => {
  const f = fixture();
  await settle();
  for (let i = 0; i < 9; i++) {
    f.video.pause();
    f.tick(3000);
    await settle();
  }
  assert.equal(f.video.playCalls, 7); // 初次播放 + 60秒内6次恢复。
  assert.match(f.ui('status').textContent, /暂停过于频繁|检测到暂停/);
});

test('上拉菜单的选项4秒后才挂载时继续等待，不误关菜单', async () => {
  const f = fixture({ nativeControls: true, hoverMenu: true, menuDelay: 4000, dynamicMenu: true, textRate: true });
  await settle();
  f.tick(3000);
  assert.equal(f.video.playbackRate, 1);
  f.tick(1000);
  assert.equal(f.video.playbackRate, 2);
  assert.equal(f.nativeNodes.get('#native-speed-menu').clicks, 1);
});

test('悬停可记录倍速入口，再选择上拉选项完成标记', async () => {
  const f = fixture({ nativeControls: 'unmarked', hoverMenu: true });
  await settle();
  f.ui('mark-rate').click();
  const menu = f.nativeNodes.get('#native-speed-menu');
  f.dispatchDoc('pointerover', { target: menu, composedPath: () => [menu] });
  menu.dispatchEvent({ type: 'mouseover' });
  f.nativeNodes.get('#native-speed-2').click();
  const saved = f.savedValues.get('player-controls:https://pro.yuketang.cn');
  assert.equal(saved.rateMenu, '#native-speed-menu');
  assert.equal(saved.rate2, '#native-speed-2');
});

test('自动故障判断和事件日志有容量限制，可导出本地JSON文件', async () => {
  const f = fixture();
  await settle();
  f.video.playbackRate = 1;
  f.video.muted = false;
  for (let i = 0; i < 500; i++) f.video.emit('volumechange');
  f.ui('export-debug').click();
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].name, /^yuketang-debug-\d+\.json$/);
  const text = await f.downloads[0].blob.text();
  const report = JSON.parse(text);
  assert.equal(report.debugEvents.length, 400);
  assert.equal(report.faults.includes('RATE_NOT_APPLIED'), true);
  assert.equal(report.faults.includes('MUTE_NOT_APPLIED'), true);
  assert.equal(text.includes('media.example'), false);
});

test('视频结束后按目录直接选下一视频，跨过连续作业和考试', async () => {
  const f = fixture({ catalog: [
    { type: 'video', href: '/course/video/1' },
    { type: 'assignment', href: '/course/homework/2' },
    { type: 'exam', href: '/course/exam/3' },
    { type: 'video', href: '/course/video/4' },
  ] });
  await settle();
  f.end(); f.tick(15000);
  assert.deepEqual(f.catalogRows.map(row => row.clicks), [0, 0, 0, 1]);
  assert.equal(f.buttons[0].clicks, 0);
  assert.match(f.location.href, /video\/4$/);
});

test('从作业页面启动时等待目录加载，再进入下一视频', async () => {
  const f = fixture({ noVideo: true, initialUrl: 'https://pro.yuketang.cn/course/homework/2', catalog: [
    { type: 'video', href: '/course/video/1' },
    { type: 'assignment', href: '/course/homework/2' },
    { type: 'exam', href: '/course/exam/3' },
    { type: 'video', href: '/course/video/4' },
  ] });
  await settle();
  assert.equal(f.catalogRows[3].clicks, 1);
  assert.equal(f.catalogRows[1].clicks, 0);
  assert.equal(f.catalogRows[2].clicks, 0);
});

test('目录无法识别时，共用下一节按钮仍可依次跳过作业和考试', async () => {
  const f = fixture({ boot: false, noVideo: true, initialUrl: 'https://pro.yuketang.cn/course/homework/2' });
  f.buttons[0].handlers = { click() {
    f.location.href = f.location.href.includes('/homework/') ? 'https://pro.yuketang.cn/course/exam/3' : 'https://pro.yuketang.cn/course/video/4';
  } };
  f.tick(4000);
  assert.equal(f.buttons[0].clicks, 1);
  f.tick(); f.tick(4000);
  assert.equal(f.buttons[0].clicks, 2);
  f.tick(30000);
  assert.equal(f.buttons[0].clicks, 2);
});

test('最后一个视频后仅有作业考试时停止，不循环点下一节', async () => {
  const f = fixture({ catalog: [
    { type: 'video', href: '/course/video/1' },
    { type: 'assignment', href: '/course/homework/2' },
    { type: 'exam', href: '/course/exam/3' },
  ] });
  await settle();
  f.end(); f.tick(15000); f.tick(30000);
  assert.equal(f.buttons[0].clicks, 0);
  assert.equal(f.catalogRows.reduce((sum, row) => sum + row.clicks, 0), 0);
});

test('视频组件尚未加载时不会误判成作业并跳过', async () => {
  const f = fixture({ noVideo: true });
  f.tick(60000);
  assert.equal(f.buttons[0].clicks, 0);
});

test('下一个视频被锁定时等待解锁，不跳过它', async () => {
  const next = { type: 'video', href: '/course/video/4', locked: true };
  const f = fixture({ catalog: [{ type: 'video', href: '/course/video/1' }, next] });
  await settle();
  f.end(); f.tick(15000);
  assert.equal(f.catalogRows[1].clicks, 0);
  next.locked = false;
  f.tick();
  assert.equal(f.catalogRows[1].clicks, 1);
});

test('目录中的外部课程链接不会被当作下一视频', async () => {
  const f = fixture({ catalog: [
    { type: 'video', href: '/course/video/1' },
    { type: 'video', href: '/other-course/video/2' },
  ] });
  await settle();
  f.end(); f.tick(15000);
  assert.equal(f.catalogRows[1].clicks, 0);
  assert.equal(f.buttons[0].clicks, 0);
});

test('点击倍速选项没有效果时验证失败，再有限次使用媒体属性设置', async () => {
  const f = fixture({ nativeControls: true, noOpOption: true, writableRate: true });
  await settle();
  f.tick();
  assert.equal(f.video.playbackRate, 1);
  f.tick();
  assert.equal(f.video.playbackRate, 2);
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.state.rateDirectAttempts, 1);
  assert.equal(report.debugEvents.some(e => e.event === 'rate.verify' && !e.applied), true);
});

test('面板可收起再展开，后台自动化继续运行', async () => {
  const f = fixture();
  await settle();
  f.ui('collapse').click();
  assert.equal(f.ui('panel-body').hidden, true);
  f.ui('collapse').click();
  assert.equal(f.ui('panel-body').hidden, false);
  assert.equal(f.video.paused, false);
});

test('换到下一视频后重新验证失效的菜单点击，并再次设置2倍速', async () => {
  const f = fixture({ nativeControls: true, noOpOption: true, writableRate: true });
  await settle();
  f.tick(); f.tick();
  assert.equal(f.video.playbackRate, 2);
  f.video.src = 'https://media.example/next.mp4';
  f.video.playbackRate = 1;
  f.video.paused = false;
  f.tick();
  f.tick(4000); f.tick(); f.tick();
  await settle();
  assert.equal(f.video.playbackRate, 2);
  f.ui('diagnose').click();
  assert.equal(JSON.parse(f.ui('diagnostics').value).state.rateDirectAttempts, 1);
});

test('目录已自动定位时点击识别直接成功，不进入阻塞设置模式', async () => {
  const f = fixture({ catalog: [{ type: 'video', href: '/course/video/1' }, { type: 'video', href: '/course/video/2' }] });
  await settle();
  assert.equal(f.ui('pick-catalog').textContent, '目录已识别');
  f.ui('pick-catalog').click();
  assert.match(f.ui('status').textContent, /已自动识别/);
  f.ui('diagnose').click();
  assert.equal(JSON.parse(f.ui('diagnostics').value).selecting, false);
  f.end(); f.tick(15000);
  assert.equal(f.catalogRows[1].clicks, 1);
});

test('点击目录项的标题兄弟节点时，可匹配其共同外框', async () => {
  const f = fixture({ catalog: [{ type: 'video' }, { type: 'exam' }, { type: 'video' }] });
  await settle();
  const row = f.catalogRows[0];
  const wrapper = { nodeType: 1, localName: 'div', contains: target => target === row, parentElement: null };
  const title = { nodeType: 1, localName: 'span', parentElement: wrapper, contains: () => false };
  f.ui('pick-catalog').click();
  f.dispatchDoc('click', { target: title, composedPath: () => [title, wrapper], preventDefault() {}, stopImmediatePropagation() {} });
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.catalog.currentIndex, 0);
  assert.equal(report.selecting, false);
});

test('点击目录项外框也能识别，不要求正好点在文字上', async () => {
  const f = fixture({ catalog: [{ type: 'video' }, { type: 'video' }] });
  await settle();
  const row = f.catalogRows[0];
  const wrapper = { nodeType: 1, localName: 'div', contains: target => target === row, parentElement: null };
  f.ui('pick-catalog').click();
  f.dispatchDoc('click', { target: wrapper, composedPath: () => [wrapper], preventDefault() {}, stopImmediatePropagation() {} });
  f.ui('diagnose').click();
  assert.equal(JSON.parse(f.ui('diagnostics').value).catalog.currentIndex, 0);
});

test('点击含多个条目的章节区域不乱选，并退出设置恢复轮询', async () => {
  const f = fixture({ catalog: [{ type: 'video' }, { type: 'video' }] });
  await settle();
  const chapter = { nodeType: 1, localName: 'section', contains: target => f.catalogRows.includes(target), parentElement: null };
  f.ui('pick-catalog').click();
  f.dispatchDoc('click', { target: chapter, composedPath: () => [chapter], preventDefault() {}, stopImmediatePropagation() {} });
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.catalog.currentIndex, -1);
  assert.equal(report.selecting, false);
  assert.equal(report.debugEvents.some(entry => entry.event === 'catalog.mark.miss'), true);
});

test('视频区域的header-left标题不混入目录成为末尾假视频', async () => {
  const f = fixture({ phantomHeader: true, catalog: [{ type: 'video', href: '/course/video/1' }, { type: 'exam', href: '/course/exam/2' }] });
  await settle();
  f.ui('diagnose').click();
  const report = JSON.parse(f.ui('diagnostics').value);
  assert.equal(report.catalog.count, 2);
  assert.deepEqual(report.catalog.types, ['video', 'exam']);
  f.end(); f.tick(15000);
  assert.equal(f.phantomHeaderNode.clicks, 0);
});
