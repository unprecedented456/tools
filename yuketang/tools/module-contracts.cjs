'use strict';

// 功能对象只通过声明的端口协作。三个自动化对象不直接调用彼此的业务。
const allowed = {
  platform: ['app', 'ui', 'video', 'core'],
  app: ['app', 'video', 'ui', 'ai', 'assignment', 'discussion', 'core', 'dom', 'platform'],
  ui: ['app', 'video', 'ui', 'ai', 'assignment', 'discussion', 'core', 'dom', 'platform'],
  video: ['app', 'ui', 'core', 'dom', 'platform'],
  ai: ['app', 'ui', 'core', 'platform'],
  assignment: ['app', 'ui', 'ai', 'core', 'dom', 'platform'],
  discussion: ['app', 'ui', 'ai', 'core', 'dom', 'platform'],
};
function inspectFactory(factory) {
  const code = factory.toString().replace(/\n  if \(options\.testing\) api\.testing = \{[\s\S]*?\n  \};/, '');
  return { code, exports: new Set([...code.matchAll(/\bget\s+(\w+)\(\)/g)].map(match => match[1])),
    references: [...code.matchAll(/\bports\.(\w+)\.(\w+)/g)].map(match => ({ module: match[1], member: match[2] })) };
}
function validateFactory(name, factory, contracts) {
  const inspected = inspectFactory(factory);
  for (const ref of inspected.references) {
    if (!allowed[name]?.includes(ref.module)) throw Error(`${name} cannot depend on ${ref.module}`);
    if (!contracts[ref.module]?.has(ref.member)) throw Error(`${name}: missing port ${ref.module}.${ref.member}`);
  }
  return inspected;
}
function validateInterfaces(factories, core) {
  const contracts = Object.fromEntries(Object.entries(factories).map(([name, factory]) => [name, inspectFactory(factory).exports]));
  const platform = require('../src/shared/platform.cjs');
  contracts.platform = inspectFactory(platform).exports;
  contracts.core = new Set(Object.keys(core)); contracts.dom = new Set(['setField']);
  for (const [name, factory] of Object.entries(factories)) validateFactory(name, factory, contracts);
  validateFactory('platform', platform, contracts);
  return contracts;
}
module.exports = { allowed, inspectFactory, validateFactory, validateInterfaces };
