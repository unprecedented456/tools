// 雨课堂讨论组件只读导出器 v1：在已打开讨论页的F12控制台运行。
// 不访问Cookie、存储、网络接口或框架内部状态；不点击网页操作控件。
(() => {
  'use strict';
  if (!/\/(?:forum|discussion)(?:\/|$)/i.test(document.location.pathname || new URL(document.location.href).pathname) && !document.querySelector('.forum-publish')) {
    throw new Error('当前不是讨论页：请在左侧目录单击“讨论”，等评论显示后，在该页控制台重新执行导出。');
  }
  const limits = { documents: 6, nodes: 12000, depth: 35, text: 150000, textNode: 2500 };
  const report = { format: 'yuketang-discussion-components', version: 1, exportedAt: new Date().toISOString(),
    limits, documents: [], inaccessibleFrames: 0, truncated: false,
    privacy: '不含Cookie、存储、表单值和URL查询参数；按字段过滤常见个人标识。评论正文仍可能含个人信息，请自行检查后分享。' };
  const redactText = value => String(value || '')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => safeUrl(value));
  function safeUrl(value, base) {
    try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : '[链接已省略]'; }
    catch { return '[链接已省略]'; }
  }
  const identity = /user[-_]?name|nickname|student[-_]?(?:id|name|number)|real[-_]?name|author|avatar|telephone|phone|e-?mail|(^|[\s_-])name($|[\s_-])/i;
  const secret = /password|passwd|token|secret|api[-_]?key|authorization|credential|captcha|verification/i;
  const formTags = new Set(['input', 'textarea', 'select']);
  const skippedTags = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'path']);
  const visited = new Set();
  let nodeCount = 0, textCount = 0;
  function serialize(node, doc, depth = 0) {
    if (++nodeCount > limits.nodes || depth > limits.depth) { report.truncated = true; return null; }
    if (node.nodeType === 3) {
      const raw = redactText(node.textContent).replace(/\s+/g, ' ').trim();
      if (!raw) return null;
      const allowed = Math.min(limits.textNode, Math.max(0, limits.text - textCount));
      const content = raw.slice(0, allowed); textCount += content.length;
      if (content.length < raw.length) report.truncated = true;
      return content ? { text: content, ...(content.length < raw.length ? { truncated: true } : {}) } : null;
    }
    if (node.nodeType !== 1 || skippedTags.has(node.localName)) return null;
    const tag = node.localName, className = typeof node.className === 'string' ? node.className : '';
    const identifier = `${className} ${node.id || ''}`;
    const result = { tag, ...(className ? { class: className.slice(0, 350) } : {}) };
    if (identity.test(identifier)) return { ...result, redacted: 'identity-field' };
    if (secret.test(identifier)) return { ...result, redacted: 'credential-or-verification-field' };
    if (node.id) result.id = node.id.slice(0, 150);
    const attributes = {};
    for (const name of ['role', 'type', 'placeholder', 'aria-label', 'aria-checked', 'aria-disabled', 'aria-expanded', 'aria-hidden', 'contenteditable', 'data-order', 'data-resource-type']) {
      const value = node.getAttribute(name);
      if (value !== null) attributes[name] = redactText(value).slice(0, 250);
    }
    if (Object.keys(attributes).length) result.attributes = attributes;
    if (node.hasAttribute('disabled')) result.disabled = true;
    try {
      const style = doc.defaultView.getComputedStyle(node);
      result.visible = !!node.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden';
    } catch { result.visible = null; }
    if (tag === 'a') result.link = safeUrl(node.getAttribute('href') || '', doc.baseURI);
    if (tag === 'img') { result.image = true; return result; }
    if (tag === 'iframe') { result.frame = true; return result; }
    if (formTags.has(tag) || node.isContentEditable || node.getAttribute('role') === 'textbox') {
      result.formContentOmitted = true; return result;
    }
    const children = [];
    for (const child of node.childNodes) {
      const serialized = serialize(child, doc, depth + 1);
      if (serialized) children.push(serialized);
      if (nodeCount >= limits.nodes) { report.truncated = true; break; }
    }
    if (children.length) result.children = children;
    return result;
  }
  function capture(doc) {
    if (!doc || visited.has(doc) || report.documents.length >= limits.documents) return;
    visited.add(doc);
    const record = { page: safeUrl(doc.location.href), readyState: doc.readyState,
      tree: serialize(doc.body || doc.documentElement, doc),
      hints: [...doc.querySelectorAll('[class*="forum"], [class*="comment"], [class*="reply"], [class*="publish"]')].slice(0, 150)
        .map(el => ({ tag: el.localName, class: String(el.className || '').slice(0, 250) })) };
    report.documents.push(record);
    for (const frame of doc.querySelectorAll('iframe')) {
      try { if (frame.contentDocument?.documentElement) capture(frame.contentDocument); else report.inaccessibleFrames++; }
      catch { report.inaccessibleFrames++; }
    }
  }
  capture(document);
  report.stats = { documents: report.documents.length, nodes: nodeCount, textCharacters: textCount };
  const file = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(file), link = document.createElement('a');
  link.href = url; link.download = `yuketang-discussion-components-${Date.now()}.json`;
  document.documentElement.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  console.info('讨论组件已导出。未填写或发送评论。请检查JSON后再分享。', report.stats, report.truncated ? '内容达到上限，可在评论较少时再导出一份。' : '');
  return report.stats;
})();
