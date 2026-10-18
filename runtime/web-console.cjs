// [AI-added] 2026-09-16: Open a short-lived local browser login; never print admin credentials.
'use strict';
const { spawn } = require('node:child_process');
// [AI-added] 2026-09-17 14:23
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browserArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, browserArgs, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', e => console.error('无法打开浏览器：' + e.message)); child.unref();
}
async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port'), port = index < 0 ? 43187 : Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口必须在 1024–65535 之间');
  if (args.includes('--data') || args.includes('--workspace')) throw Error('项目管理仅支持统一控制台；请不带 --data/--workspace 启动，再从主页选择项目');
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
module.exports = { main, openBrowser };
