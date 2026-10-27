'use strict';

// 延迟连接对象端口，构造完成后再注册事件、启动循环。
// 构造顺序与旧版初始化顺序一致；不在构造时执行课程任务。
function composeFeatures(factories, core, dom, mountPanel, createPlatform, version, options = {}) {
  const ports = { core, dom, mountPanel: () => mountPanel(version), version };
  ports.platform = createPlatform(ports, options.platform);
  ports.app = factories.app(ports, options.app);
  ports.video = factories.video(ports, options.video);
  ports.ui = factories.ui(ports, options.ui);
  ports.ai = factories.ai(ports, options.ai);
  ports.assignment = factories.assignment(ports, options.assignment);
  ports.discussion = factories.discussion(ports, options.discussion);
  return Object.seal(ports);
}
module.exports = composeFeatures;
