// [AI-added] 2026-09-17 14:23
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const registry = require('./core/service-registry.cjs');
const wizard = require('./wizard.cjs');
// [AI-added] 2026-09-17 19:20
const { alive, atomic, read } = require('./core/storage.cjs');

const json = (res, code, value, headers = {}) => { res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }); res.end(JSON.stringify(value)); };
async function body(req) { let text=''; for await (const chunk of req) { text+=chunk; if(Buffer.byteLength(text)>32768) throw Error('请求超过 32 KiB'); } return JSON.parse(text||'{}'); }
function cookie(req) { return (req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('td_catalog='))?.slice(11); }
// [AI-added] 2026-09-21: Stopping a service affects every project sharing that data root, so the
// home page guard reads the whole state file instead of the single card's workspace.
function serviceFacts(dataRoot) {
  const facts = { inFlight: 0, unclaimed: 0, headlessRunning: false };
  let state; try { state = registry.stateAt(dataRoot); } catch { return facts; }
  for (const project of Object.values(state?.projects || {})) for (const task of Object.values(project?.tasks || {})) {
    if (['running', 'reviewing'].includes(task.state)) { facts.inFlight++; if (project.mode !== 'desktop') facts.headlessRunning = true; }
    const attempt = task.attempts?.at(-1);
    if (attempt?.claimedBy && !attempt.settled) facts.unclaimed++;
  }
  for(const project of Object.values(state?.projects||{}))for(const round of Object.values(project.reviewStages||{}))if(round.attempt&&!round.attempt.settled){facts.inFlight++;if(round.attempt.claimedBy)facts.unclaimed++;}
  return facts;
}
function serviceVersion(dataRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(dataRoot, 'endpoint.json'), 'utf8')).version || null; } catch { return null; }
}
function projectView(options = {}) {
  return registry.catalog(options).map(entry => {
    let project, taskCount=0, activeTaskCount=0;
    try {
      const state=registry.stateAt(entry.dataRoot); project=Object.values(state?.projects||{}).find(item=>registry.pathKey(item.workspace)===registry.pathKey(entry.workspace));
      const tasks=Object.values(project?.tasks||{}); taskCount=tasks.length; activeTaskCount=tasks.filter(task=>!require('./core/task-state.cjs').terminal(task)).length;
    } catch { /* Catalog availability is reported without exposing service state. */ }
    const online=registry.online(entry.dataRoot);
    return { key:entry.key, projectId:project?.id||entry.projectId, workspace:entry.workspace, dataRoot:entry.dataRoot, workspaceExists:entry.workspaceExists,
      dataExists:entry.dataExists, online, taskCount, activeTaskCount, completed:!!project?.completedAt, paused:!!project?.paused,
      ...(online ? { ...serviceFacts(entry.dataRoot), serviceVersion: serviceVersion(entry.dataRoot) } : serviceFacts(entry.dataRoot)) };
  });
}
// [AI-added] 2026-09-19 00:35
// Deprecated: the cross-port admin redirect was replaced by the same-origin
// gateway routes /catalog/api/p/<key>/* below. Kept for reference only.
// async function openProject(key, options = {}) {
//   const entry=registry.catalog(options).find(item=>item.key===key);
//   if(!entry)throw Error('项目不在系统目录清单中，请刷新');
//   if(!entry.workspaceExists)throw Error('项目工作目录已不存在，请核对项目位置');
//   if(!entry.dataExists)throw Error('项目服务目录不可用，请先迁移或重新接入项目');
//   if(!await wizard.online(entry.dataRoot))await wizard.start(entry.dataRoot);
//   const endpoint=JSON.parse(fs.readFileSync(path.join(entry.dataRoot,'endpoint.json'),'utf8')),target=`http://127.0.0.1:${endpoint.port}`;
//   const response=await fetch(target+'/admin/ticket',{method:'POST',headers:{Authorization:'Bearer '+fs.readFileSync(path.join(entry.dataRoot,'admin-token'),'utf8').trim()},signal:AbortSignal.timeout(5000)});
//   let result; try { result=JSON.parse(await response.text()); } catch { throw Error('目标项目服务尚未支持 Web 管理台，请在安全边界重启该项目服务'); }
//   if(!response.ok||typeof result.url!=='string')throw Error(result.error||'目标项目管理台不可用');
//   return {url:result.url};
// }
// [AI-added] 2026-09-19 00:35
function catalogEntry(key, options = {}) {
  const entry = registry.catalog(options).find(item => item.key === key);
  if (!entry) throw Error('项目不在系统目录清单中，请返回主页刷新');
  if (!entry.workspaceExists) throw Error('项目工作目录已不存在，请核对项目位置');
  if (!entry.dataExists) throw Error('项目服务目录不可用，请先迁移或重新接入项目');
  return entry;
}
// [AI-added] 2026-09-19 00:35
// The gateway holds one server-side admin session per project service in memory.
// The admin token never leaves this process; browsers only hold the catalog session.
async function gatewayLogin(entry) {
  if (!await wizard.online(entry.dataRoot)) await wizard.start(entry.dataRoot);
  const endpoint = JSON.parse(fs.readFileSync(path.join(entry.dataRoot, 'endpoint.json'), 'utf8'));
  const base = `http://127.0.0.1:${endpoint.port}`;
  const token = fs.readFileSync(path.join(entry.dataRoot, 'admin-token'), 'utf8').trim();
  const ticketResponse = await fetch(base + '/admin/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
  let ticketResult; try { ticketResult = JSON.parse(await ticketResponse.text()); } catch { throw Error('目标项目服务尚未支持 Web 管理台，请在安全边界重启该项目服务'); }
  if (!ticketResponse.ok || typeof ticketResult.url !== 'string') throw Error(ticketResult.error || '目标项目服务尚未支持 Web 管理台，请在安全边界重启该项目服务');
  const ticket = new URL(ticketResult.url).hash.slice('#ticket='.length);
  const loginResponse = await fetch(base + '/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(5000) });
  const loginResult = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok || !loginResult.csrf) throw Error(loginResult.error || '目标项目登录失败');
  const cookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('td_admin=')) throw Error('目标项目登录失败：未返回会话');
  return { base, cookie, csrf: loginResult.csrf, expiresAt: Date.now() + 7.5 * 3600000 };
}
// [AI-added] 2026-09-17 19:20
// Previous implementation: AppData/Local/task-dispatch/console.json was the default.
// [AI-added] 2026-09-24 13:25: Keep console discovery with the home metadata index.
function consoleFile(home) { return path.join(registry.systemIndexRoot(home), 'console.json'); }
function legacyConsoleFile(cacheRoot) { return path.join(path.resolve(cacheRoot || registry.systemCacheRoot()), 'task-dispatch', 'console.json'); }
// [AI-added] 2026-09-24 13:25: An already running old console remains reachable during the index transition.
async function reuse({ stateFile, home, cacheRoot } = {}) {
  for (const candidate of stateFile ? [stateFile] : [consoleFile(home), legacyConsoleFile(cacheRoot)]) {
    let state; try { state = read(candidate); } catch { continue; }
    if (!state || !Number.isInteger(state.port) || typeof state.token !== 'string' || !alive(state.pid)) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/catalog/ticket`, { method: 'POST', headers: { Authorization: 'Bearer ' + state.token }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const { url } = await response.json(); if (typeof url === 'string') return url;
    } catch { /* Try the next known console record. */ }
  }
  return null;
}
async function serve({port=0,registryOptions={},stateFile}={}) {
  const record=stateFile||(process.env.NODE_TEST_CONTEXT?null:consoleFile()),token=crypto.randomBytes(32).toString('hex');
  // [AI-added] 2026-09-19 00:35
  const gatewaySessions=new Map(),activeStreams=new Set();
  async function gatewaySession(key,refresh=false){
    const cached=gatewaySessions.get(key);
    if(!refresh&&cached&&cached.expiresAt>Date.now())return cached;
    const session=await gatewayLogin(catalogEntry(key,registryOptions));
    gatewaySessions.set(key,session);return session;
  }
  async function gatewayFetch(key,apiPath,{method='GET',payload}={}){
    let lastError;
    for(let attempt=0;attempt<2;attempt++){
      const session=await gatewaySession(key,attempt>0);
      let response;
      try{
        response=await fetch(session.base+'/admin/api/'+apiPath,{method,headers:{Cookie:session.cookie,...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':session.csrf,Origin:session.base}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(30000)});
      }catch(error){lastError=error;gatewaySessions.delete(key);continue;}
      if(response.status===401&&attempt===0){gatewaySessions.delete(key);continue;}
      return response;
    }
    throw Error('无法连接项目服务：'+(lastError?.message||'未知错误'));
  }
  async function forwardJson(res,key,apiPath,{method='GET',payload}={}){
    const upstream=await gatewayFetch(key,apiPath,{method,payload});
    const headers={'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8','Cache-Control':'no-store'};
    const disposition=upstream.headers.get('content-disposition');if(disposition)headers['Content-Disposition']=disposition;
    res.writeHead(upstream.status,headers);res.end(await upstream.text());
  }
  // [AI-added] 2026-09-21
  async function gatewayJson(key,apiPath,{method='GET',payload}={}){
    const upstream=await gatewayFetch(key,apiPath,{method,payload}),value=JSON.parse(await upstream.text()||'{}');
    if(!upstream.ok||value.ok===false)throw Error(value.error||`项目服务拒绝了该操作（HTTP ${upstream.status}）`);
    return value;
  }
  // [AI-added] 2026-09-21
  async function waitOffline(root,deadlineMs=15000){
    const deadline=Date.now()+deadlineMs;
    while(Date.now()<deadline){if(!await wizard.online(root))return true;await new Promise(resolve=>setTimeout(resolve,200));}
    return !await wizard.online(root);
  }
  async function forwardStream(req,res,key,session){
    let upstream=null;
    for(let attempt=0;attempt<2;attempt++){
      const gateway=await gatewaySession(key,attempt>0);
      try{upstream=await fetch(gateway.base+'/admin/api/stream'+new URL(req.url,'http://127.0.0.1').search,{headers:{Cookie:gateway.cookie}});}
      catch{gatewaySessions.delete(key);upstream=null;continue;}
      if(upstream.status===401&&attempt===0){gatewaySessions.delete(key);upstream=null;continue;}
      break;
    }
    if(!upstream)return json(res,502,{error:'无法连接项目服务事件流'});
    if(!upstream.ok||!upstream.body){const text=await upstream.text().catch(()=>'');res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(text);return;}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});
    // The forwarded stream ends with the catalog session or the client connection.
    const timer=setTimeout(()=>{try{res.end();}catch{}upstream.body.cancel().catch(()=>{});},Math.max(1000,session.expires-Date.now()));
    if(timer.unref)timer.unref();
    const cancel=()=>{clearTimeout(timer);activeStreams.delete(upstream.body);upstream.body.cancel().catch(()=>{});};
    activeStreams.add(upstream.body);res.once('close',cancel);
    try{for await(const chunk of upstream.body){if(res.destroyed||res.writableEnded)break;if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}}
    catch{/* The upstream stream was aborted; the client close handler already ran. */}
    clearTimeout(timer);activeStreams.delete(upstream.body);try{res.end();}catch{}
  }
  const tickets=new Map(),sessions=new Map(),assets={'/catalog/':'index.html','/catalog/app.js':'app.js','/catalog/style.css':'style.css','/catalog/task-board.mjs':'task-board.mjs'};
  const cleanup=setInterval(()=>{const now=Date.now();for(const[key,expires]of tickets)if(expires<now)tickets.delete(key);for(const[key,value]of sessions)if(value.expires<now)sessions.delete(key);},60000);cleanup.unref();
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1'),host=`127.0.0.1:${req.socket.localPort}`,origin=`http://${host}`;
    if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'仅允许本机同源访问'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(req.method==='GET'&&url.pathname==='/'){res.writeHead(302,{Location:'/catalog/'});res.end();return;}
      // [AI-added] 2026-09-19 00:35: unified frontend now lives in console-web/ (old catalog-web/ retired).
      if(req.method==='GET'&&assets[url.pathname]){const file=assets[url.pathname];res.writeHead(200,{'Content-Type':/\.m?js$/.test(file)?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'console-web',file)));return;}
      // [AI-added] 2026-09-21 10:20: The header version badge renders before login, so a stale
      // launcher is recognizable without a session. Read-only, loopback same-origin only.
      if(req.method==='GET'&&url.pathname==='/catalog/api/version')return json(res,200,{runtimeVersion:require('../package.json').version});
      if(req.method==='POST'&&url.pathname==='/catalog/login'){
        if(req.headers.origin!==origin)throw Error('需要同源登录');const input=await body(req),expires=tickets.get(input.ticket);tickets.delete(input.ticket);
        if(!expires||expires<Date.now())return json(res,401,{error:'登录票据已失效，请重新运行 web-console.bat'});
        const id=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');sessions.set(id,{csrf,expires:Date.now()+8*3600000});
        return json(res,200,{csrf},{'Set-Cookie':`td_catalog=${id}; HttpOnly; SameSite=Strict; Path=/catalog; Max-Age=28800`});
      }
      // [AI-added] 2026-09-17 19:20
      if(req.method==='POST'&&url.pathname==='/catalog/ticket'){
        if(req.headers.origin||req.headers.authorization!=='Bearer '+token)return json(res,401,{error:'需要本地启动器'});
        if(tickets.size>=100)tickets.clear();
        return json(res,200,{url:createTicket()});
      }
      const session=sessions.get(cookie(req));if(!session||session.expires<Date.now())return json(res,401,{error:'请重新运行 web-console.bat'});
      if(req.method==='GET'&&url.pathname==='/catalog/api/session')return json(res,200,{csrf:session.csrf});
      if(req.method==='GET'&&url.pathname==='/catalog/api/projects')return json(res,200,{projects:projectView(registryOptions),observedAt:new Date().toISOString()});
      // [AI-added] 2026-09-21: per-project service lifecycle from the home page.
      if(req.method==='POST'&&url.pathname==='/catalog/api/service'){
        if(req.headers.origin!==origin||req.headers['x-csrf-token']!==session.csrf)return json(res,403,{error:'同源控制校验失败'});
        const input=await body(req);
        if(!['start','stop','restart'].includes(input.action))throw Error('服务操作只支持 start、stop、restart');
        const entry=catalogEntry(input.key,registryOptions);
        if(input.action==='start'){
          if(!await wizard.online(entry.dataRoot))await wizard.start(entry.dataRoot);
          return json(res,200,{ok:true,action:'start',online:true,serviceVersion:serviceVersion(entry.dataRoot)});
        }
        if(input.confirmed!==true)return json(res,400,{error:'停止或重启服务需要确认'});
        const facts=serviceFacts(entry.dataRoot);
        if(facts.headlessRunning)throw Error('该项目服务正在执行无人值守任务，等本回合结算后再停止');
        if(await wizard.online(entry.dataRoot)){
          const overview=await gatewayJson(input.key,'overview');
          await gatewayJson(input.key,'commands',{method:'POST',payload:{commandId:crypto.randomUUID(),instanceId:overview.instanceId,revision:overview.revision,action:'stop',confirmed:true,reason:`统一控制台主页${input.action==='restart'?'重启':'停止'}服务`}});
          gatewaySessions.delete(input.key);
          if(!await waitOffline(entry.dataRoot))throw Error('服务未在 15 秒内退出，请在项目服务窗口核实后再操作');
        }
        if(input.action==='restart')await wizard.start(entry.dataRoot);
        const online=Boolean(await wizard.online(entry.dataRoot));
        return json(res,200,{ok:true,action:input.action,online,...facts,serviceVersion:online?serviceVersion(entry.dataRoot):null});
      }
      // [AI-added] 2026-09-19: operator cleanup of catalog entries whose workspace vanished; index-only.
      if(req.method==='POST'&&url.pathname==='/catalog/api/cleanup-invalid'){
        if(req.headers.origin!==origin||req.headers['x-csrf-token']!==session.csrf)return json(res,403,{error:'同源控制校验失败'});
        return json(res,200,registry.pruneInvalid(registryOptions));
      }
      // [AI-added] 2026-09-19 00:35
      // Deprecated: the cross-port redirect route was replaced by the same-origin
      // gateway routes below; kept for reference only.
      // if(req.method==='POST'&&url.pathname==='/catalog/api/open'){
      //   if(req.headers.origin!==origin||req.headers['x-csrf-token']!==session.csrf)return json(res,403,{error:'同源控制校验失败'});
      //   return json(res,200,await openProject((await body(req)).key,registryOptions));
      // }
      // [AI-added] 2026-09-19 00:35: same-origin gateway to the selected project service.
      const gatewayMatch=url.pathname.match(/^\/catalog\/api\/p\/([^/]+)\/(ensure|overview|events|diagnostics|commands|stream)$/);
      if(gatewayMatch){
        const[,key,action]=gatewayMatch;
        if(action==='ensure'){
          if(req.method!=='POST')return json(res,405,{error:'ensure 需要 POST'});
          if(req.headers.origin!==origin||req.headers['x-csrf-token']!==session.csrf)return json(res,403,{error:'同源控制校验失败'});
          await gatewaySession(key);return json(res,200,{online:true});
        }
        if(action==='commands'){
          if(req.method!=='POST')return json(res,405,{error:'commands 需要 POST'});
          if(req.headers.origin!==origin||req.headers['x-csrf-token']!==session.csrf)return json(res,403,{error:'同源控制校验失败'});
          return await forwardJson(res,key,'commands',{method:'POST',payload:await body(req)});
        }
        if(action==='stream'){
          if(req.method!=='GET')return json(res,405,{error:'stream 需要 GET'});
          return await forwardStream(req,res,key,session);
        }
        if(req.method!=='GET')return json(res,405,{error:'该接口仅支持 GET'});
        return await forwardJson(res,key,action+url.search);
      }
      return json(res,404,{error:'目录接口不存在'});
    } catch(error){return json(res,400,{error:error.message});}
  });
  // [AI-added] 2026-09-17 19:20
  let bound=null;
  for(let attempt=0;attempt<20;attempt++)try{
    await new Promise((resolve,reject)=>{const onError=error=>{server.off('listening',onListening);reject(error);},onListening=()=>{server.off('error',onError);resolve();};server.once('error',onError);server.once('listening',onListening);server.listen(port+attempt,'127.0.0.1');});
    bound=server.address().port;break;
  }catch(error){if(error.code!=='EADDRINUSE'||attempt===19)throw error;}
  if(record)atomic(record,{version:1,pid:process.pid,port:bound,token,startedAt:new Date().toISOString()});
  const createTicket=()=>{const ticket=crypto.randomBytes(32).toString('hex');tickets.set(ticket,Date.now()+60000);return `http://127.0.0.1:${server.address().port}/catalog/#ticket=${ticket}`;};
  // [AI-added] 2026-09-19 00:35: also drop forwarded project streams and gateway sessions on shutdown.
  const close=()=>new Promise(resolve=>{clearInterval(cleanup);for(const body of activeStreams)body.cancel().catch(()=>{});activeStreams.clear();gatewaySessions.clear();server.close(resolve);server.closeAllConnections();
    if(record)try{const current=read(record);if(current.pid===process.pid&&current.port===bound)fs.rmSync(record,{force:true});}catch{}});
  return {server,createTicket,close,port:bound,projectView:()=>projectView(registryOptions)};
}
// [AI-added] 2026-09-19 00:35: openProject was removed from exports with the cross-port redirect.
module.exports={serve,reuse,consoleFile,legacyConsoleFile,projectView,catalogEntry,gatewayLogin};
