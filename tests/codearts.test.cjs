// [AI-added] 2026-09-14 09:43
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodeArtsWake } = require('../runtime/adapters/codearts-wake.cjs');
const { WakeProviders } = require('../runtime/adapters/mimo-wake.cjs');
const { install } = require('../scripts/install.js');
function fixture() {
  const root = path.resolve(__dirname, '../tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codearts-'));
  const file = path.join(dir, 'discovery.json');
  const config = { version: 1, sessionId: 'ses_test', directory: dir, url: 'http://127.0.0.1:1234', username: 'opencode', password: 'test-only' };
  const save = () => fs.writeFileSync(file, JSON.stringify(config)); save();
  return { dir, file, config, save };
}
test('CodeArts routes history/status/model and reloads discovery credentials', async () => {
  const x = fixture(), calls = []; let busy = false, response = 204;
  const a = new CodeArtsWake({ credentialFile: x.file, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const route = new URL(url).pathname;
    if (route.endsWith('/prompt_async')) return new Response(null, { status: response });
    if (route.endsWith('/status')) return Response.json(busy ? { ses_test: { type: 'busy' } } : {});
    if (route.endsWith('/message')) return Response.json([{ info: { role: 'user' }, parts: [{ type: 'text', text: 'TASK-DISPATCH-WAKE:test' }] }]);
    return Response.json({ id: 'ses_test', directory: x.dir });
  } });
  const binding = { threadId: 'ses_test', model: 'provider/model' };
  const info = await a.read(binding);
  assert.equal(info.thread.status.type, 'idle'); assert.match(info.turns[0].items[0].content[0].text, /TASK-DISPATCH/);
  x.config.url = 'http://127.0.0.1:4321'; x.config.password = 'rotated'; x.save();
  assert.deepEqual(await a.send(binding, '中文通知'), { delivered: true });
  const last = calls.at(-1);
  assert.equal(last.url.port, '4321'); assert.equal(last.url.searchParams.get('directory'), x.dir);
  assert.equal(last.options.redirect, 'error');
  assert.equal(last.options.headers.Authorization, 'Basic ' + Buffer.from('opencode:rotated').toString('base64'));
  assert.deepEqual(JSON.parse(last.options.body), { parts: [{ type: 'text', text: '中文通知' }], model: { providerID: 'provider', modelID: 'model' } });
  busy = true; const before = calls.filter(c => c.options.method === 'POST').length;
  await assert.rejects(a.send(binding, 'busy'), e => e.safeToRetry === true);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, before);
  busy = false; response = 200;
  await assert.rejects(a.send(binding, 'ambiguous'), e => !e.safeToRetry && /unconfirmed/.test(e.message));
});
test('CodeArts rejects remote discovery and mismatched session before sending credentials', async () => {
  const x = fixture(); let calls = 0;
  const a = new CodeArtsWake({ credentialFile: x.file, fetchImpl: async () => { calls++; throw Error('unexpected'); } });
  x.config.url = 'http://example.com'; x.save();
  await assert.rejects(a.read({ threadId: 'ses_test' }), /Invalid/);
  x.config.url = 'http://127.0.0.1:1234'; x.save();
  await assert.rejects(a.read({ threadId: 'other' }), /Invalid/); assert.equal(calls, 0);
});
// [AI-added] 2026-09-14 20:10
test('CodeArts adapter routes V2 bridge requests with bearer token', async () => {
  // [AI-added] 2026-09-14 20:10
  const x=fixture(),calls=[];Object.assign(x.config,{version:2,url:'http://127.0.0.1:6789',token:'a'.repeat(64)});delete x.config.username;delete x.config.password;x.save();
  const a=new CodeArtsWake({credentialFile:x.file,fetchImpl:async(url,options)=>{
    calls.push({url:new URL(url),options});const route=new URL(url).pathname;
    if(route==='/v1/status')return Response.json({});
    if(route.endsWith('/messages'))return Response.json([]);
    if(route.endsWith('/prompt'))return new Response(null,{status:204});
    return Response.json({id:'ses_test',directory:x.dir});
  }});
  await a.read({threadId:'ses_test'});await a.send({threadId:'ses_test'},'wake');
  assert.deepEqual(calls.map(c=>c.url.pathname),['/v1/session/ses_test','/v1/session/ses_test/messages','/v1/status','/v1/session/ses_test','/v1/session/ses_test/messages','/v1/status','/v1/session/ses_test/prompt']);
  assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer '+'a'.repeat(64)));
  assert.ok(calls.every(c=>c.url.search===''));
});
test('all connected wake providers are registered and CodeArts aliases share one adapter', () => {
  const providers = new WakeProviders();
  for (const id of ['codex', 'mimo', 'codearts']) assert.equal(typeof providers.forProvider(id).send, 'function');
  assert.equal(providers.forProvider('codearts'), providers.forProvider('codeartsdoer'));
  assert.throws(() => providers.forProvider('missing'), /not connected/);
});
test('CodeArts remains a runtime worker adapter but is not a brain-platform install target', () => {
  const x = fixture(), home = path.join(x.dir, 'home');
  assert.throws(() => install({ platforms: ['codearts'], home, dryRun: true }), /valid platforms/);
  assert.throws(() => install({ platforms: ['codeartsdoer'], home, dryRun: true }), /valid platforms/);
  assert.equal(fs.existsSync(home), false);
});
test('release version is consistent across distribution metadata', () => {
  const root = path.resolve(__dirname, '..'); const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  for (const file of ['package.json', '.codex-plugin/plugin.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(root, file))).version, version);
  assert.ok(fs.readFileSync(path.join(root, 'skills/task-dispatch/SKILL.md'), 'utf8').includes('<!-- task-dispatch v' + version + ' -->'));
  assert.ok(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## ' + version));
});
// [AI-added] 2026-09-14 17:19
test('MiMo is an installable YAML-frontmatter skill platform', () => {
  const x = fixture(), home = path.join(x.dir, 'mimo-home');
  install({ platforms: ['mimo'], home });
  const skill = path.join(home, '.config/mimocode/skills/task-dispatch/SKILL.md');
  const value = fs.readFileSync(skill, 'utf8');
  assert.match(value, /^---\r?\nname:\s*task-dispatch\r?\ndescription:\s*\S[\s\S]*?\r?\n---/);
  assert.ok(install({ platforms: ['mimo'], home }).every(p => p.writes.length === 0));
});
// [AI-added] 2026-09-14 09:43
test('CodeArts hook publishes V2 discovery and serves authenticated SDK bridge', async () => {
  const x = fixture();
  const { spawnSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const hook = pathToFileURL(path.resolve(__dirname, '../skills/task-dispatch/codearts-hook.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {TaskDispatch}=await import(${JSON.stringify(hook)});
    const fs=await import('node:fs');const path=await import('node:path');const crypto=await import('node:crypto');const calls=[];
    const session={
      list:async()=>({data:[{id:'ses_one',directory:process.cwd()},{id:'other',directory:'elsewhere'}]}),
      get:async o=>({data:{id:o.path.id,directory:process.cwd()}}),messages:async()=>({data:[]}),status:async()=>({data:{}}),
      promptAsync:async o=>{calls.push(o);return {data:null};}
    };
    const h=await TaskDispatch({directory:process.cwd(),client:{session}});
    await h.event({event:{type:'session.idle',properties:{sessionID:'ses_two'}}});
    const root=path.join(process.env.USERPROFILE,'.codeartsdoer','task-dispatch');
    // [AI-added] 2026-09-14 20:28
    const file=path.join(root,'bridge.json');const c=JSON.parse(fs.readFileSync(file));
    const headers={Authorization:'Bearer '+c.token};
    const got=await fetch(c.url+'/v1/session/ses_one',{headers}).then(r=>r.json());
    // [AI-added] 2026-09-14 20:18
    const sessions=await fetch(c.url+'/v1/sessions',{headers}).then(r=>r.json());
    const sent=await fetch(c.url+'/v1/session/ses_one/prompt',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'wake'}]})});
    await h.dispose();console.log(JSON.stringify({version:c.version,got,sessions,sent:sent.status,calls,files:fs.readdirSync(root).length}));
  `], { cwd: x.dir, encoding: 'utf8', env: { ...process.env, HOME: x.dir, USERPROFILE: x.dir, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'test-only' } });
  assert.equal(result.status, 0, result.stderr);
  const value=JSON.parse(result.stdout.trim());assert.equal(value.version,2);assert.equal(value.got.id,'ses_one');assert.equal(value.sessions.length,2);assert.equal(value.sent,204);assert.equal(value.files,2);
  assert.equal(value.calls[0].path.id,'ses_one');assert.equal(value.calls[0].body.parts[0].text,'wake');
});
