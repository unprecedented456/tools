// 在雨课堂页面的 Chrome DevTools Console 中执行。
// 只读事件注册信息，不调用处理函数，不读取事件附带的数据或账号信息。
(() => {
  const roots = [...document.querySelectorAll('xt-speedbutton')];
  if (!roots.length) throw new Error('未找到倍速组件，请等待播放器加载后重试');
  const nodes = new Set();
  for (const root of roots) {
    nodes.add(root);
    root.querySelectorAll('*').forEach(node => nodes.add(node));
    for (let node = root.parentElement; node; node = node.parentElement) {
      nodes.add(node);
      if (node.matches('.xt_video_player_container') || node === document.body) break;
    }
  }
  const handlers = [];
  for (const node of nodes) {
    for (const key of Object.getOwnPropertyNames(node).filter(key => /^jQuery\d/.test(key))) {
      const cache = Object.getOwnPropertyDescriptor(node, key)?.value;
      if (!cache || typeof cache !== 'object' || !cache.events) continue;
      for (const [type, list] of Object.entries(cache.events)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (typeof item.handler !== 'function') continue;
          handlers.push({ tag: node.localName, className: String(node.className || ''),
            dataSpeed: node.getAttribute('data-speed'), type, originalType: item.origType,
            selector: item.selector || null, source: Function.prototype.toString.call(item.handler) });
        }
      }
    }
  }
  if (!handlers.length) throw new Error('未读到 jQuery 内部处理函数，请把这条提示发给我');
  copy(JSON.stringify({ format: 'yuketang-handlers-v2', handlers }, null, 2));
  console.log(`已复制 ${handlers.length} 个实际事件处理函数，请直接粘贴到聊天中。`);
})();
