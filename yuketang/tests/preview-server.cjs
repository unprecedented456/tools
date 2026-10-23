const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8953');
  const file = url.pathname === '/userscript.js' ? path.join(__dirname, '..', 'yuketang-autoplay.user.js')
    : /^\/course\/(video|homework|exam)\/\d+$/.test(url.pathname) ? path.join(__dirname, 'preview.html') : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', url.pathname === '/userscript.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(fs.readFileSync(file));
});
server.listen(8953, '127.0.0.1', () => process.stdout.write('Preview: http://127.0.0.1:8953/course/video/1\n'));
