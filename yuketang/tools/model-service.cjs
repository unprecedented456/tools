'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const Course = require('../src/course-core.cjs')();
const { modelFetch } = require('./model-transport.cjs');
const { extractReference } = require('./reference-extractor.cjs');
const configPath = path.join(__dirname, '..', '.local', 'model-service.json');

function loadConfig() {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config = {};
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.token) {
    config.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return config;
}
async function complete(task, config, fetcher = modelFetch, { sleep = wait, random = Math.random, onRetry = () => {} } = {}) {
  Course.validateTask(task);
  if (!config.endpoint || !config.model || !config.apiKey) throw new Error('MODEL_NOT_CONFIGURED');
  if (task.image && !config.vision) throw new Error('VISION_REQUIRED');
  // 所有尝试共享90秒预算；仅对明确的临时HTTP故障重试，最多额外两次。
  const signal = AbortSignal.timeout(90000);
  const url = Course.endpoint(config.endpoint);
  const request = {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages: Course.messages(task), stream: false }),
  };
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    response = await fetcher(url, request);
    if (response.ok || ![502, 503, 504].includes(response.status) || attempt === 2) break;
    await response.body?.cancel?.();
    const delayMs = 1000 * 2 ** attempt + Math.floor(random() * 250);
    onRetry({ attempt: attempt + 2, status: response.status, delayMs });
    await sleep(delayMs, undefined, { signal });
  }
  if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('MODEL_OUTPUT_TRUNCATED');
  if (!choice?.message) throw new Error('MODEL_PROTOCOL_INVALID');
  return Course.parseModel(choice?.message?.content, task);
}
function modelErrorCode(error) {
  if (/^(?:MODEL_NOT_CONFIGURED|MODEL_HTTP_\d{3}|MODEL_OUTPUT_TRUNCATED|VISION_REQUIRED|MODEL_PROTOCOL_INVALID|MODEL_NETWORK_ERROR|MODEL_TIMEOUT|MODEL_RESPONSE_TOO_LARGE|MODEL_IMAGE_UNREADABLE|MODEL_MATERIAL_INSUFFICIENT|MODEL_ANSWER_UNCERTAIN|MODEL_TRANSCRIPT_INVALID|MODEL_SELECTION_INCOMPLETE|MODEL_DISCUSSION_TOO_LONG)$/.test(error.message)) return error.message;
  if (error.name === 'TypeError' && error.message === 'fetch failed') return 'MODEL_NETWORK_ERROR';
  if (error.name === 'SyntaxError') return 'MODEL_JSON_INVALID';
  if (error.message === '模型引用了不存在的材料') return 'MODEL_SOURCE_INVALID';
  if (error.message === '模型提示材料不足或无法辨认题目') return 'MODEL_INSUFFICIENT';
  if (['模型未返回JSON对象', '摘要为空', '讨论正文无效'].includes(error.message)) return 'MODEL_RESULT_INVALID';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'MODEL_TIMEOUT';
  return 'MODEL_REQUEST_INVALID';
}
function probeTask() {
  return { kind: 'summary', chapterKey: 'connection-check', materials: [{ id: 'connection-check', chapterKey: 'connection-check',
    title: '公开连接测试', text: '这是一条不含课程内容的连接测试，请在JSON的summary字段填写“连接正常”，sources填写["connection-check"]。' }] };
}
function allowedOrigin(value, localOrigin) {
  if (!value || value === localOrigin || value === 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo') return true;
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'yuketang.cn' || u.hostname.endsWith('.yuketang.cn') || u.hostname === 'yuketang.tsinghua.edu.cn'); }
  catch { return false; }
}
function settingsHtml(token) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>雨课堂 · 本地模型设置</title>
  <style>body{font:15px/1.6 system-ui;background:#f4f7f5;color:#233d2f;margin:40px auto;max-width:620px;padding:20px}main{background:white;padding:28px;border-radius:16px}label{display:block;margin-top:16px}input:not([type=checkbox]){display:block;width:95%;padding:9px;border:1px solid #ccd8cf;border-radius:7px}button{background:#27764e;color:white;border:0;padding:10px 18px;border-radius:8px;margin-top:16px}p{color:#65786c}#status{white-space:pre-wrap}</style>
  <main><h2>本地模型设置</h2><p>API密钥保存在这台电脑的项目文件夹内，不放进油猴脚本。保存后，只会把当前题目或讨论题及本次选取的参考正文发送到你指定的接口。</p>
  <form id="form"><label>接口地址（兼容 Chat Completions）<input id="endpoint" placeholder="https://服务地址/v1" required></label><label>模型名称<input id="model" required></label><label>API密钥<input id="key" type="password" autocomplete="off" placeholder="已有密钥时留空表示保留"></label><label><input id="vision" type="checkbox" checked>这个模型支持读图（本课程特殊字体题目需要）</label><button>保存设置</button></form>
  <h3>连接油猴</h3><p>将下方连接口令复制到脚本的“设置 → 修改本地连接口令”。这不是模型API密钥。</p><input id="token" readonly><button id="copy">复制连接口令</button><p id="status"></p></main>
  <script>const token=${JSON.stringify(token)};const el=id=>document.getElementById(id);el('token').value=token;
  async function call(url,data){const r=await fetch(url,{method:data?'POST':'GET',headers:{'X-Ykt-Token':token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
  call('/status').then(v=>{el('endpoint').value=v.endpoint||'';el('model').value=v.model||'';el('vision').checked=v.vision!==false;el('status').textContent=v.ready?'配置已填写；请到油猴面板点“测试模型回复”核验实际调用。':'尚未配置API，图文和材料采集无需API。'}).catch(e=>el('status').textContent=e.message);
  el('form').onsubmit=async e=>{e.preventDefault();try{await call('/settings',{endpoint:el('endpoint').value,model:el('model').value,apiKey:el('key').value,vision:el('vision').checked});el('key').value='';el('status').textContent='设置已保存，尚未验证模型回复。回到油猴点“测试模型回复”检查。';}catch(err){el('status').textContent=err.message;}};
  el('copy').onclick=()=>navigator.clipboard.writeText(token).then(()=>el('status').textContent='连接口令已复制');</script></html>`;
}
function createService({ config = loadConfig(), fetcher, logger = () => {}, save = value => fs.writeFileSync(configPath, JSON.stringify(value, null, 2), { mode: 0o600 }) } = {}) {
  let busy = false;
  const activity = { requests: 0, successes: 0, failures: 0, active: null, lastError: null, lastFinishedAt: null };
  return http.createServer(async (req, res) => {
    const localOrigin = `http://${req.headers.host}`;
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '') || !allowedOrigin(req.headers.origin, localOrigin)) { res.writeHead(403); res.end(); return; }
    if (req.url === '/' && req.headers.origin && req.headers.origin !== localOrigin) { res.writeHead(403); res.end(); return; }
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type, X-Ykt-Token', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(); return; }
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (req.url === '/' && req.method === 'GET') {
      if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') { json(403, { error: 'FORBIDDEN' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(settingsHtml(config.token)); return;
    }
    const supplied = Buffer.from(req.headers['x-ykt-token'] || '');
    const expected = Buffer.from(config.token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { json(401, { error: '连接口令不正确' }); return; }
    if (req.url === '/status' && req.method === 'GET') { json(200, { serviceVersion: '1.10.0', ready: !!(config.apiKey && config.endpoint && config.model), endpoint: config.endpoint || '', model: config.model || '', vision: config.vision !== false, activity }); return; }
    if (req.method !== 'POST' || !['/settings', '/complete', '/probe', '/extract'].includes(req.url)) { json(404, { error: 'NOT_FOUND' }); return; }
    let size = 0, body = '';
    try {
      const pieces = [];
      for await (const chunk of req) { size += chunk.length; if (size > (req.url === '/extract' ? 21000000 : 12000000)) { json(413, { error: '内容过大' }); return; } pieces.push(chunk); }
      body = Buffer.concat(pieces).toString('utf8');
      const value = JSON.parse(body);
      if (req.url === '/extract') {
        try { json(200, { result: await extractReference(value) }); } catch (error) { json(400, { error: error.message }); }
        return;
      }
      if (req.url === '/settings') {
        if (req.headers.origin && req.headers.origin !== localOrigin) { json(403, { error: '仅能在本地设置页配置模型' }); return; }
        const next = { token: config.token, endpoint: Course.endpoint(value.endpoint), model: String(value.model || '').trim(), apiKey: value.apiKey || config.apiKey, vision: value.vision !== false };
        if (!next.model || !next.apiKey || next.model.length > 200 || /[\r\n]/.test(next.apiKey)) throw new Error('模型名或API密钥无效');
        save(next); config = next; json(200, { saved: true }); return;
      }
      if (busy) { json(429, { error: '模型正在处理其他请求' }); return; }
      busy = true;
      const task = req.url === '/probe' ? probeTask() : value;
      const kind = req.url === '/probe' ? 'probe' : ['answer', 'summary', 'discussion', 'transcribe'].includes(task.kind) ? task.kind : 'unknown';
      const startedAt = Date.now();
      activity.requests++; activity.active = { kind, startedAt };
      logger({ event: 'request', kind });
      try {
        const result = await complete(task, config, fetcher, { onRetry: info => {
          activity.active = { kind, startedAt, attempt: info.attempt };
          logger({ event: 'retry', kind, ...info });
        } });
        activity.successes++; activity.lastError = null;
        logger({ event: 'success', kind, elapsedMs: Date.now() - startedAt });
        json(200, { result });
      } catch (error) {
        const code = modelErrorCode(error);
        activity.failures++; activity.lastError = code;
        logger({ event: 'error', kind, code, elapsedMs: Date.now() - startedAt });
        json(400, { error: code, ...(code === 'MODEL_TRANSCRIPT_INVALID' && error.details ? { details: error.details } : {}) });
      } finally { busy = false; activity.active = null; activity.lastFinishedAt = Date.now(); }
    } catch (error) {
      // 不把第三方响应体、请求头、密钥或课程正文写进错误日志。
      const safe = /^(?:MODEL_NOT_CONFIGURED|MODEL_HTTP_\d{3}|MODEL_OUTPUT_TRUNCATED|VISION_REQUIRED)$/.test(error.message) ? error.message : '请求格式或模型返回内容校验失败';
      json(400, { error: safe });
    }
  });
}
if (require.main === module) {
  const server = createService({ logger: entry => process.stdout.write(`[${new Date().toLocaleTimeString()}] ${entry.kind} ${entry.event}${entry.attempt ? ` 第${entry.attempt}次尝试，等待${entry.delayMs}毫秒` : ''}${entry.elapsedMs !== undefined ? ` ${(entry.elapsedMs / 1000).toFixed(1)}秒` : ''}${entry.code ? ` ${entry.code}` : ''}\n`) });
  server.listen(8954, '127.0.0.1', () => process.stdout.write('本地模型设置：http://127.0.0.1:8954\n此窗口运行期间，油猴才能调用模型。未配置API时不会发送模型请求。\n'));
  server.on('error', error => { process.stderr.write(`本地服务未能启动：${error.code}\n`); process.exitCode = 1; });
}
module.exports = { createService, complete, allowedOrigin, modelErrorCode, probeTask };
