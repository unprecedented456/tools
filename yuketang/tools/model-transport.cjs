'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// Windows PowerShell 使用现有系统网络配置。请求数据只走标准输入，不放入命令行。
const windowsRequestScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  $task = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $requestHeaders = @{}
  foreach ($entry in $task.headers.PSObject.Properties) {
    if ($entry.Name -ne 'Content-Type') { $requestHeaders[$entry.Name] = [string]$entry.Value }
  }
  try {
    $requestOptions = @{ Uri=$task.url; Method=$task.method; Headers=$requestHeaders; UseBasicParsing=$true; MaximumRedirection=0; TimeoutSec=90 }
    if ($task.method -ne 'GET' -and $task.method -ne 'HEAD') {
      $requestOptions.ContentType = 'application/json; charset=utf-8'
      $requestOptions.Body = [Text.Encoding]::UTF8.GetBytes([string]$task.body)
    }
    $reply = Invoke-WebRequest @requestOptions
    # Windows PowerShell会把未声明charset的JSON按旧编码解释；必须使用原始字节解码UTF-8。
    $replyBody = if ($null -ne $reply.RawContentStream) { [Text.Encoding]::UTF8.GetString($reply.RawContentStream.ToArray()) }
      elseif ($reply.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($reply.Content) } else { [string]$reply.Content }
    @{ status=[int]$reply.StatusCode; body=$replyBody } | ConvertTo-Json -Compress -Depth 4
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $replyBody = $reader.ReadToEnd(); $reader.Dispose()
      @{ status=[int]$response.StatusCode; body=$replyBody } | ConvertTo-Json -Compress -Depth 4
    } else { @{ error='MODEL_NETWORK_ERROR' } | ConvertTo-Json -Compress }
  }
} catch { @{ error='MODEL_NETWORK_ERROR' } | ConvertTo-Json -Compress }
`;

function windowsFetch(url, init, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(Object.assign(new Error('MODEL_TIMEOUT'), { name: 'AbortError' })); return; }
    const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsRequestScript, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const decoder = new StringDecoder('utf8');
    const finish = (error, value) => {
      if (settled) return; settled = true;
      init.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill(); finish(new Error('MODEL_TIMEOUT')); };
    init.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { output += decoder.write(chunk); if (output.length > 12000000) { child.kill(); finish(new Error('MODEL_RESPONSE_TOO_LARGE')); } });
    child.stderr.on('data', () => {}); // 原始进程错误不写日志，避免包含请求信息。
    child.on('error', () => finish(new Error('MODEL_NETWORK_ERROR')));
    child.on('close', () => {
      if (settled) return;
      output += decoder.end();
      try {
        const response = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
        if (response.error) throw new Error('MODEL_NETWORK_ERROR');
        if (!Number.isInteger(response.status)) throw new Error('MODEL_NETWORK_ERROR');
        finish(null, { ok: response.status >= 200 && response.status < 300, status: response.status,
          json: async () => JSON.parse(response.body) });
      } catch (error) { finish(error.message.startsWith('MODEL_') ? error : new Error('MODEL_NETWORK_ERROR')); }
    });
    child.stdin.on('error', () => finish(new Error('MODEL_NETWORK_ERROR')));
    child.stdin.end(JSON.stringify({ url, method: init.method, headers: init.headers, body: init.body }));
  });
}

function modelFetch(url, init) {
  return process.platform === 'win32' ? windowsFetch(url, init) : fetch(url, init);
}
module.exports = { modelFetch, windowsFetch, windowsRequestScript };
