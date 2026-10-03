// [AI-added] 2026-09-16: Open a short-lived local browser login; never print admin credentials.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const wizard = require('./wizard.cjs');
// [AI-added] 2026-09-17 14:23
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browserArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, browserArgs, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', e => console.error('无法打开浏览器：' + e.message)); child.unref();
}
async function directProject(args, port) {
  const root = wizard.dataRoot(args);
  wizard.initialize(root);
  if (!await wizard.online(root)) await wizard.start(root, { port });
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'endpoint.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/admin/ticket`, { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(path.join(root, 'admin-token'), 'utf8').trim() } });
  if (!response.ok) throw Error('现有服务尚未支持 Web 管理台，请在任务安全边界停止旧服务后重新启动');
  const { url } = await response.json(); openBrowser(url);
  console.log(`项目管理台：http://127.0.0.1:${endpoint.port}/admin/ （登录会话 8 小时）`);
}
async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port'), port = index < 0 ? 43187 : Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口必须在 1024–65535 之间');
  if (args.includes('--data') || args.includes('--workspace')) return directProject(args, port);
  const catalogModule = require('./catalog-console.cjs'), running = await catalogModule.reuse();
  // [AI-added] 2026-09-17 19:20
  if (running) {
    openBrowser(running);
    console.log(`项目目录主页已在运行，已重新打开登录链接：${running.split('#')[0]}`);
    console.log('登录链接 60 秒内有效；关闭原先的 web-console 窗口即可停止目录主页。');
    return;
  }
  const catalog = await catalogModule.serve({ port }), url = catalog.createTicket(); openBrowser(url);
  console.log(`项目目录主页：http://127.0.0.1:${catalog.port}/catalog/`);
  if (catalog.port !== port) console.log(`默认端口 ${port} 已被占用，已改用 ${catalog.port}。`);
  console.log('没有项目时保持空主页；项目接入及任务变化每 2 秒自动刷新。关闭此窗口会停止目录主页，不影响项目服务。');
  await new Promise(resolve => { const stop = async () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); await catalog.close(); resolve(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); });
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main, directProject, openBrowser };
