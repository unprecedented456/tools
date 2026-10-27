'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function pythonPath() {
  const bundled = path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  return process.env.YKT_PYTHON || (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3');
}
function extractReference(value, { spawnProcess = spawn, timeoutMs = 45000 } = {}) {
  if (!value || typeof value.filename !== 'string' || !/\.(md|markdown|txt|pdf|docx|doc)$/i.test(value.filename) || typeof value.data !== 'string' || value.data.length > 20000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return Promise.reject(new Error('文件格式或大小不支持（最大15MB）'));
  return new Promise((resolve, reject) => {
    const child = spawnProcess(pythonPath(), [path.join(__dirname, 'extract-reference.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, size = 0; const chunks = [];
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('文件解析超时，请拆分材料后重试')); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4000000) { child.kill(); finish(new Error('提取的正文过长，请拆分材料')); } else chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => finish(new Error('无法向本地文件解析器传入数据')));
    child.on('error', () => finish(new Error('本机未找到Python解析环境，请设置YKT_PYTHON或使用文本粘贴')));
    child.on('close', () => {
      if (done) return;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (data.error) throw Error(data.error);
        if (!data.result?.text) throw Error('没有提取到有效正文');
        finish(null, data.result);
      } catch (error) { finish(new Error(error instanceof SyntaxError ? '文件解析器返回异常，请检查Python环境' : error.message)); }
    });
    child.stdin.end(JSON.stringify({ filename: path.basename(value.filename), data: value.data }));
  });
}
module.exports = { extractReference, pythonPath };
