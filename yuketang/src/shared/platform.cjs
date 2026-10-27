'use strict';

// 公共页面适配：目录、导航、可见性与验证检测。
function createPlatform(ports, options = {}) {
  const Course = ports.core;
  const storageKey = `next-selector:${location.origin}`;

  let savedSelector = GM_getValue(storageKey, '');

  const inputObserved = new WeakSet();

  const controlInputEvents = [];

  let catalogHint = null;

  const catalogTrackingDocs = new WeakSet();
  let catalogCycle = false;
  let cycleCatalog = null;

  function beginCatalogCycle() { catalogCycle = true; cycleCatalog = null; }
  function endCatalogCycle() { catalogCycle = false; cycleCatalog = null; }
  function invalidateCatalog() { cycleCatalog = null; }

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
      const entry = { at: Date.now(), stateId: ports.video.state?.id || null, type: event.type, trusted: event.isTrusted === true,
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

  function routeResourceType(url) {
    const match = String(url).match(/\/(video|homework|assignment|exercise|exam|examination|test|article|text|document|forum|discussion)(?:\/|[?#]|$)/i);
    if (!match) return null;
    return Course.resourceType(match[1]);
  }

  function catalogRouteKey(value = location.href) {
    const url = new URL(value);
    return url.pathname.replace(/\/$/, '') + (url.searchParams.has('node_id') ? `?node_id=${encodeURIComponent(url.searchParams.get('node_id'))}` : '');
  }

  function rememberCatalogRoute(item) {
    if (!item?.chapter) return;
    try {
      const key = `course-catalog-routes:${Course.courseId(location.href)}`, saved = GM_getValue(key, {}), route = catalogRouteKey();
      if (saved[route]?.id === item.id) return;
      saved[route] = { id: item.id, type: item.type, chapterKey: item.chapter.key, at: Date.now() };
      const bounded = Object.fromEntries(Object.entries(saved).sort((a, b) => b[1].at - a[1].at).slice(0, 200));
      GM_setValue(key, bounded);
    } catch { ports.app.trace('catalog.route.save.failed'); }
  }

  function pendingCatalogNavigation(item, target) {
    invalidateCatalog();
    catalogHint = { route: location.href, element: target, id: item?.id, pending: item ? {
      from: catalogRouteKey(), course: Course.courseId(location.href), type: item.type, at: Date.now(),
    } : null };
  }

  function catalogNavigationWaiting() { return !!catalogHint?.pending && Date.now() - catalogHint.pending.at <= 15000; }

  function trackCatalogClicks(doc) {
    if (catalogTrackingDocs.has(doc) || !doc.addEventListener) return;
    catalogTrackingDocs.add(doc);
    doc.addEventListener('click', event => {
      if (!event.isTrusted || event.composedPath?.().includes(ports.ui.host)) return;
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      if (!target || ports.ui.host.contains(target)) return;
      const catalog = catalogSnapshot([doc]);
      const matches = catalog.items.filter(item => item.element === target || item.element.contains?.(target));
      if (matches.length === 1) pendingCatalogNavigation(matches[0], matches[0].element);
    }, true);
  }

  function catalogSnapshot(docs) {
    if (catalogCycle && cycleCatalog?.route === location.href && cycleCatalog.docs.length === docs.length && cycleCatalog.docs.every((doc, index) => doc === docs[index])) return cycleCatalog.snapshot;
    const entries = [];
    const chapterOrdinals = new WeakMap();
    const sidebarSelector = 'aside, nav, [role="tree"], [class*="catalog"], [class*="directory"], [class*="sidebar"]';
    for (const doc of docs) {
      trackCatalogClicks(doc);
      const video = doc.querySelector('video');
      const videoLeft = video?.getBoundingClientRect().left;
      const raw = [...doc.querySelectorAll('a[href], [data-resource-type], [data-leaf-type], [role="treeitem"], li, [class*="leaf"], [class*="resource"], [class*="task"]')];
      const badges = [...doc.querySelectorAll('span, small, em, i, div')]
        .filter(el => /^(视频|作业|考试|图文|讨论)$/.test((el.textContent || '').trim()) && !el.closest?.('.leaf-item-title'));
      for (const badge of badges) {
        let row = badge.parentElement;
        for (let depth = 0; row && depth < 2 && (row.textContent || '').trim() === (badge.textContent || '').trim(); depth++) row = row.parentElement;
        if (row) raw.push(row);
      }
      // 将标签、标题和图标统一到真正的目录行，避免选中标记落在被去重的父节点上。
      for (const row of new Set(raw.map(node => node.closest?.('.leaf-item') || node))) {
        if (!row.isConnected || row === ports.ui.host || ports.ui.host.contains(row) || row.contains?.(video)) continue;
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
            const coursePrefix = value => value.replace(/\/(video|homework|assignment|exercise|exam|examination|test|article|text|document|forum|discussion)(?:\/.*)?$/i, '');
            if (url.origin !== location.origin || coursePrefix(url.pathname) !== coursePrefix(new URL(location.href).pathname)) continue;
          } catch { continue; }
        }
        const explicit = row.getAttribute('data-resource-type') || row.getAttribute('data-leaf-type') || '';
        const label = explicit || text.match(/^(视频|作业|考试|图文|讨论)/)?.[1] || '';
        const type = routeResourceType(href) || Course.resourceType(label);
        if (!type) continue;
        // 按实际叶子行计数；同一行内的类型标签可能还有同名子节点。
        // 章节容器包含多条资源时仍排除，资源标题不充当类型标签。
        // 常见的叶子行没有嵌套叶子，行内标签必然属于同一个资源，避免对每行遍历全部标签。
        if (!row.classList?.contains('leaf-item') || row.querySelector?.('.leaf-item')) {
          const childResources = new Set(badges.filter(badge => row.contains?.(badge)).map(badge => badge.closest?.('.leaf-item') || badge));
          if (childResources.size > 1) continue;
        }
        const chapter = Course.chapterOf(row);
        const leaf = row.closest?.('.leaf-item') || row;
        const title = Course.text(leaf.querySelector('.leaf-item-title')?.textContent || text.replace(/^(视频|作业|考试|图文|讨论)\s*/, ''));
        const chapterRoot = row.closest?.('.nav-item.is-first');
        let ordinal = -1;
        if (chapterRoot) {
          let ordinals = chapterOrdinals.get(chapterRoot);
          if (!ordinals) { ordinals = new Map([...(chapterRoot.querySelectorAll?.('.leaf-item') || [])].map((node, index) => [node, index])); chapterOrdinals.set(chapterRoot, ordinals); }
          ordinal = ordinals.get(leaf) ?? -1;
        }
        entries.push({ element: row, type, href, text, chapter, title,
          id: `${chapter?.key || 'unknown'}:${type}:${Course.fingerprint(title)}:${ordinal}` });
      }
    }
    let items;
    if (entries.every(entry => 'parentElement' in entry.element)) {
      // 通过祖先链找到容器，避免每个目录项与所有其他项两两比较。
      const elements = new Set(entries.map(entry => entry.element)), containers = new Set(), seen = new Set();
      for (const entry of entries) for (let parent = entry.element.parentElement; parent; parent = parent.parentElement) if (elements.has(parent)) containers.add(parent);
      items = entries.filter(entry => { if (containers.has(entry.element) || seen.has(entry.element)) return false; seen.add(entry.element); return true; });
    } else {
      // 兼容非标准DOM适配器，保留原本的包含关系判定。
      items = entries.filter((entry, index) => !entries.some((other, j) => j !== index &&
        (other.element === entry.element ? j < index : entry.element.contains?.(other.element))));
    }
    items.sort((a, b) => a.element.compareDocumentPosition?.(b.element) & 4 ? -1 : 1);
    const activeSelector = '[aria-current="page"], [aria-selected="true"], .active, .is-active, .current, .selected';
    const currentUrl = new URL(location.href);
    const ids = [currentUrl.searchParams.get('node_id'), currentUrl.pathname.match(/\/[^/]+\/([^/]+)\/?$/)?.[1]].filter(Boolean);
    const indexed = items.map((item, index) => ({ item, index }));
    const pageType = routeResourceType(location.href);
    const pageTitles = [...new Set(docs.map(doc => Course.text(doc.querySelector('.learning-space-control-unit .control-left .unit-title')?.textContent)).filter(Boolean))];
    const titleMatches = indexed.filter(({ item }) => item.type === pageType && pageTitles.includes(item.title));
    let method = 'resource-link';
    let matches = indexed.filter(({ item }) => {
      if (item.href) {
        try {
          const url = new URL(item.href, location.href);
          if (url.origin === currentUrl.origin && url.pathname === currentUrl.pathname &&
            (!url.searchParams.has('node_id') || url.searchParams.get('node_id') === currentUrl.searchParams.get('node_id'))) return true;
        } catch { /* 无效目录链接 */ }
      }
      return ['data-node-id', 'data-leaf-id', 'data-id'].some(attr => ids.includes(item.element.getAttribute(attr)));
    });
    if (matches.length !== 1) { method = 'active-marker'; matches = indexed.filter(({ item }) => {
      const active = item.element.matches?.(activeSelector) ? item.element
        : item.element.querySelector(activeSelector) || item.element.closest(activeSelector);
      return active && items.filter(other => active === other.element || active.contains?.(other.element)).length <= 1;
    }); }
    if (matches.length !== 1 && titleMatches.length === 1) { method = 'unique-page-title'; matches = titleMatches; }
    const pending = catalogHint?.pending;
    if (matches.length !== 1 && pending && Date.now() - pending.at <= 15000 &&
      pending.course === Course.courseId(location.href) && pending.from !== catalogRouteKey() && pending.type === pageType) {
      const navigated = indexed.filter(({ item }) => item.id === catalogHint.id && (!pageTitles.length || pageTitles.includes(item.title)));
      if (navigated.length === 1) { matches = navigated; method = 'observed-navigation'; }
    }
    if (matches.length !== 1 && !pending && catalogHint?.route === location.href) {
      method = 'manual-marker'; matches = indexed.filter(({ item }) => item.element === catalogHint.element);
    }
    if (matches.length !== 1) {
      const remembered = GM_getValue(`course-catalog-routes:${Course.courseId(location.href)}`, {})[catalogRouteKey()];
      const known = remembered && indexed.filter(({ item }) => item.id === remembered.id && item.type === pageType &&
        item.chapter?.key === remembered.chapterKey && (!pageTitles.length || pageTitles.includes(item.title)));
      if (known?.length === 1) { matches = known; method = 'remembered-route'; }
    }
    const index = matches.length === 1 ? matches[0].index : -1;
    if (index >= 0) {
      rememberCatalogRoute(items[index]);
      // 真实URL已完成跳转，后续刷新通过路由记忆恢复，不依赖旧DOM对象。
      if (pending && pending.from !== catalogRouteKey() && pending.course === Course.courseId(location.href) &&
        items[index].id === catalogHint.id) catalogHint = { route: location.href, element: items[index].element, id: items[index].id };
    }
    const snapshot = { items, index, resolution: { method: index >= 0 ? method : 'unresolved', pageType,
      titleCandidates: titleMatches.length, chapterItems: items.filter(item => item.chapter).length,
      navigationPending: !!pending && Date.now() - pending.at <= 15000 } };
    if (catalogCycle) cycleCatalog = { route: location.href, docs: [...docs], snapshot };
    return snapshot;
  }

  function resourceLocked(element) {
    return !!element.closest('[disabled], [aria-disabled="true"], .is-disabled, .disabled, .locked') ||
      !!(element.closest('.leaf-item') || element).querySelector('.icon-suoding');
  }

  function moduleCompleted(item) {
    const row = item?.element && (item.element.closest?.('.leaf-item') || item.element);
    return !!row?.querySelector?.('.leaf-item-status')?.querySelector?.('.icon-yuanquangou-mianzhuang');
  }

  function clickNavigation(target, item = null) {
    item ||= catalogSnapshot(documents()).items.find(candidate => candidate.element === target);
    pendingCatalogNavigation(item, target);
    try { target.click(); } finally { invalidateCatalog(); }
  }

  function nextTarget(docs) {
    const selectors = [savedSelector, ...ports.app.CONFIG.nextSelectors].filter(Boolean);
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
        if (!available(el) || el === ports.ui.host || ports.ui.host.contains(el)) continue;
        const labels = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')];
        if (!labels.some(label => nextLabel.test((label || '').replace(/[\s>›»→]/g, '')))) continue;
        found.add(el.closest('button, a, [role="button"]') || el);
      }
    }
    const targets = [...found].filter(available);
    // 多个独立候选时要求标记，防止误点。
    return targets.length === 1 ? targets[0] : null;
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

  function humanVerification(docs) {
    const selectors = 'iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], [id*="captcha"], [class*="captcha"], .geetest_panel, .geetest_holder, .nc-container, .yidun_popup, [data-human-verification]';
    const wording = /人机验证|安全验证|拖动滑块|滑块验证|点击.*验证|完成.*验证|verify you are human|security verification/i;
    for (const doc of docs) {
      if ([...doc.querySelectorAll(selectors)].some(el => visible(el) &&
        !['passed', 'success', 'verified'].includes(el.getAttribute('data-human-verification')) &&
        !/^(?:验证成功|验证通过|已通过验证|verification successful|verified successfully)[!！。✓✔√\s]*$/i.test((el.textContent || '').trim()))) return true;
      if ([...doc.querySelectorAll('[role="dialog"], [aria-modal="true"], .el-dialog__wrapper')].some(el => visible(el) && wording.test((el.textContent || '').slice(0, 1200)))) return true;
    }
    return false;
  }

  function pauseBlocker(docs) {
    return docs.some(doc => [...doc.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .el-dialog__wrapper, .ant-modal-wrap')].some(visible));
  }

  function markCatalogItem() {
    if (ports.app.selecting) return;
    const docs = documents();
    const initial = catalogSnapshot(docs);
    if (initial.index >= 0) {
      ports.app.trace('catalog.already-recognized', { count: initial.items.length, index: initial.index });
      ports.ui.status('目录已自动识别，无需手动设置');
      return;
    }
    ports.app.selecting = true;
    ports.ui.status('请点击左侧目录中当前正在查看的那一项');
    const cleanup = () => {
      ports.app.selecting = false;
      clearTimeout(timer);
      for (const doc of docs) {
        doc.removeEventListener('click', choose, true);
        doc.removeEventListener('keydown', cancel, true);
      }
    };
    const cancel = event => { if (event.key === 'Escape') { cleanup(); ports.ui.status('已取消目录识别'); } };
    const choose = event => {
      if (event.composedPath().includes(ports.ui.host)) return;
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
        ports.app.trace('catalog.mark.miss', { count: catalog.items.length, tag: target.localName, className: String(target.className || '').slice(0, 120) });
        ports.ui.status('此次未识别，已退出设置；可导出调试文件定位');
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      catalogHint = { route: location.href, element: item.element };
      rememberCatalogRoute(item);
      cleanup();
      ports.app.trace('catalog.marked', { type: item.type, count: catalog.items.length });
      ports.ui.status('目录已识别，将继续当前任务模式');
    };
    const timer = setTimeout(() => { cleanup(); ports.ui.status('目录识别已超时'); }, 60000);
    for (const doc of docs) {
      doc.addEventListener('click', choose, true);
      doc.addEventListener('keydown', cancel, true);
    }
  }

  function clearNextMarker() {
    savedSelector = ''; GM_setValue(storageKey, '');
    ports.ui.memorySummary(); ports.ui.status('已清除标记，恢复自动识别');
  }

  const api = {
    get beginCatalogCycle() { return beginCatalogCycle; },
    get endCatalogCycle() { return endCatalogCycle; },
    get moduleCompleted() { return moduleCompleted; },
    get clearNextMarker() { return clearNextMarker; },
    get documents() { return documents; },
    get visible() { return visible; },
    get available() { return available; },
    get observeControlInput() { return observeControlInput; },
    get controlInfo() { return controlInfo; },
    get routeResourceType() { return routeResourceType; },
    get catalogRouteKey() { return catalogRouteKey; },
    get rememberCatalogRoute() { return rememberCatalogRoute; },
    get pendingCatalogNavigation() { return pendingCatalogNavigation; },
    get catalogNavigationWaiting() { return catalogNavigationWaiting; },
    get trackCatalogClicks() { return trackCatalogClicks; },
    get catalogSnapshot() { return catalogSnapshot; },
    get resourceLocked() { return resourceLocked; },
    get clickNavigation() { return clickNavigation; },
    get nextTarget() { return nextTarget; },
    get cssPath() { return cssPath; },
    get humanVerification() { return humanVerification; },
    get pauseBlocker() { return pauseBlocker; },
    get markCatalogItem() { return markCatalogItem; },
    get storageKey() { return storageKey; },
    get savedSelector() { return savedSelector; }, set savedSelector(value) { savedSelector = value; },
    get inputObserved() { return inputObserved; },
    get controlInputEvents() { return controlInputEvents; },
    get catalogHint() { return catalogHint; }, set catalogHint(value) { catalogHint = value; },
    get catalogTrackingDocs() { return catalogTrackingDocs; }
  };
  if (options.testing) api.testing = {
    get documents() { return documents; }, set documents(value) { documents = value; },
    get visible() { return visible; }, set visible(value) { visible = value; },
    get available() { return available; }, set available(value) { available = value; },
    get observeControlInput() { return observeControlInput; }, set observeControlInput(value) { observeControlInput = value; },
    get controlInfo() { return controlInfo; }, set controlInfo(value) { controlInfo = value; },
    get routeResourceType() { return routeResourceType; }, set routeResourceType(value) { routeResourceType = value; },
    get catalogRouteKey() { return catalogRouteKey; }, set catalogRouteKey(value) { catalogRouteKey = value; },
    get rememberCatalogRoute() { return rememberCatalogRoute; }, set rememberCatalogRoute(value) { rememberCatalogRoute = value; },
    get pendingCatalogNavigation() { return pendingCatalogNavigation; }, set pendingCatalogNavigation(value) { pendingCatalogNavigation = value; },
    get catalogNavigationWaiting() { return catalogNavigationWaiting; }, set catalogNavigationWaiting(value) { catalogNavigationWaiting = value; },
    get trackCatalogClicks() { return trackCatalogClicks; }, set trackCatalogClicks(value) { trackCatalogClicks = value; },
    get catalogSnapshot() { return catalogSnapshot; }, set catalogSnapshot(value) { catalogSnapshot = value; },
    get resourceLocked() { return resourceLocked; }, set resourceLocked(value) { resourceLocked = value; },
    get clickNavigation() { return clickNavigation; }, set clickNavigation(value) { clickNavigation = value; },
    get nextTarget() { return nextTarget; }, set nextTarget(value) { nextTarget = value; },
    get cssPath() { return cssPath; }, set cssPath(value) { cssPath = value; },
    get humanVerification() { return humanVerification; }, set humanVerification(value) { humanVerification = value; },
    get pauseBlocker() { return pauseBlocker; }, set pauseBlocker(value) { pauseBlocker = value; },
    get markCatalogItem() { return markCatalogItem; }, set markCatalogItem(value) { markCatalogItem = value; },
    get storageKey() { return storageKey; },
    get savedSelector() { return savedSelector; }, set savedSelector(value) { savedSelector = value; },
    get inputObserved() { return inputObserved; },
    get controlInputEvents() { return controlInputEvents; },
    get catalogHint() { return catalogHint; }, set catalogHint(value) { catalogHint = value; },
    get catalogTrackingDocs() { return catalogTrackingDocs; }
  };
  return api;
}
module.exports = createPlatform;
