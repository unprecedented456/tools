'use strict';
// 只发送固定公开测试文本；不输出配置、密钥、请求头或模型原始回复。
const fs = require('node:fs');
const path = require('node:path');
const { complete, modelErrorCode, probeTask } = require('./model-service.cjs');
const { modelFetch } = require('./model-transport.cjs');
const Course = require('../src/course-core.cjs')();
async function main() {
  const startedAt = Date.now();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.local', 'model-service.json'), 'utf8'));
    if (process.argv.includes('--list')) {
      const response = await modelFetch(Course.endpoint(config.endpoint).replace(/\/chat\/completions$/, '/models'), {
        method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
      const result = await response.json();
      const models = (result.data || []).map(model => model.id).filter(id => typeof id === 'string' && id.includes('gemini') && !/embedding|tts|audio|live|image|robotics/i.test(id));
      process.stdout.write(JSON.stringify({ ok: true, models, elapsedSeconds: (Date.now() - startedAt) / 1000 }) + '\n');
      return;
    }
    if (process.argv.includes('--service')) {
      const headers = { 'Content-Type': 'application/json', 'X-Ykt-Token': config.token };
      const response = await fetch('http://127.0.0.1:8954/probe', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(100000) });
      const data = await response.json();
      if (!response.ok) throw new Error(/^MODEL_[A-Z0-9_]+$/.test(data.error || '') ? data.error : 'MODEL_REQUEST_INVALID');
      if (!data.result?.summary) throw new Error('MODEL_PROTOCOL_INVALID');
      process.stdout.write(JSON.stringify({ ok: true, viaLocalService: true, model: config.model, validSummary: true, elapsedSeconds: (Date.now() - startedAt) / 1000 }) + '\n');
      return;
    }
    const index = process.argv.indexOf('--model');
    const model = index < 0 ? config.model : process.argv[index + 1];
    if (!model || !/^[a-zA-Z0-9_./-]{1,150}$/.test(model)) throw new Error('MODEL_REQUEST_INVALID');
    const result = await complete(probeTask(), { ...config, model });
    if (process.argv.includes('--use-model')) {
      const response = await fetch('http://127.0.0.1:8954/settings', { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-Ykt-Token': config.token },
        body: JSON.stringify({ endpoint: config.endpoint, model, apiKey: '', vision: config.vision !== false }) });
      if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, model, saved: process.argv.includes('--use-model'), validSummary: !!result.summary, elapsedSeconds: (Date.now() - startedAt) / 1000 }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: modelErrorCode(error), elapsedSeconds: (Date.now() - startedAt) / 1000 }) + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
