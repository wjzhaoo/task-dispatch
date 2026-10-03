'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { initialize, request } = require('../runtime/wizard.cjs');
const { serve } = require('../runtime/server.cjs');
const { call } = require('../runtime/desktop-client.cjs');
const cli = path.resolve(__dirname, '../runtime/desktop-client.cjs');

test('connect requires an explicit non-auto provider before any service or credential side effect',async()=>{
  const base=path.resolve(__dirname,'../tmp');fs.mkdirSync(base,{recursive:true});
  const temp=fs.mkdtempSync(path.join(base,'provider-required-')),root=path.join(temp,'service'),workspace=path.join(temp,'project');fs.mkdirSync(workspace);
  for(const extra of [[],['--provider','auto'],['--provider','mimo']]){
    await assert.rejects(execFile(process.execPath,[cli,'connect','--data',root,'--workspace',workspace,...extra],{cwd:workspace,windowsHide:true}),extra[1]==='mimo'?/real --session-id/:/Ask the user to choose the current platform/);
    assert.equal(fs.existsSync(root),false);
  }
});

// [AI-added] 2026-09-16 21:34
test('brain recovery flags are paired and rejected for other roles before side effects',async()=>{
  const base=path.resolve(__dirname,'../tmp');fs.mkdirSync(base,{recursive:true});
  const temp=fs.mkdtempSync(path.join(base,'recovery-flags-')),root=path.join(temp,'service'),workspace=path.join(temp,'project');fs.mkdirSync(workspace);
  const cases=[
    ['rebind','--role','brain','--provider','codex','--session-id','brain','--recover'],
    ['rebind','--role','brain','--provider','codex','--session-id','brain','--confirmed-stopped'],
    ['rebind','--role','worker','--provider','codex','--session-id','worker','--recover','--confirmed-stopped']
  ];
  for(const args of cases)await assert.rejects(execFile(process.execPath,[cli,...args,'--data',root,'--workspace',workspace],{cwd:workspace,windowsHide:true}),/recovery|Recovery/);
  assert.equal(fs.existsSync(root),false);
});

// [AI-added] 2026-09-16 16:00
// [AI-added] 2026-09-17 11:46
test('connect without --data creates and reuses the protected workspace-local service',async()=>{
  const base=path.resolve(__dirname,'../tmp');fs.mkdirSync(base,{recursive:true});
  const temp=fs.mkdtempSync(path.join(base,'project-data-root-')),workspace=path.join(temp,'project');fs.mkdirSync(workspace);
  const root=require('../runtime/core/data-root.cjs').projectDataRoot(workspace);
  const waitStopped=async()=>{for(let i=0;i<100;i++){if(!fs.existsSync(path.join(root,'service.lock')))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('service did not stop');};
  try {
    const args=[cli,'connect','--provider','codex','--workspace',workspace,'--session-id','project-data-session'];
    const first=JSON.parse((await execFile(process.execPath,args,{cwd:workspace,windowsHide:true})).stdout);
    assert.equal(first.data,root);assert.equal(path.relative(workspace,root).split(path.sep).slice(0,2).join('/'),'.task-dispatch/runtime');
    assert.match(fs.readFileSync(path.join(workspace,'.task-dispatch','.gitignore'),'utf8'),/^runtime\/$/m);
    assert.equal(JSON.parse(fs.readFileSync(first.credential)).data,root);
    const again=JSON.parse((await execFile(process.execPath,args,{cwd:workspace,windowsHide:true})).stdout);
    assert.equal(again.credential,first.credential);
  } finally {
    if(fs.existsSync(path.join(root,'endpoint.json'))&&fs.existsSync(path.join(root,'admin-token')))try{await request(root,{action:'stop'});}catch{}
    if(fs.existsSync(path.join(root,'service.lock')))await waitStopped();
  }
});

test('connect defaults to cwd and brain, starts service, preserves session ownership and explicitly reopens', async () => {
  const base=path.resolve(__dirname,'../tmp');fs.mkdirSync(base,{recursive:true});
  const temp=fs.mkdtempSync(path.join(base,'connect-auto-')),root=path.join(temp,'service'),workspace=path.join(temp,'project');
  fs.mkdirSync(workspace);
  const run=async(cwd,...args)=>JSON.parse((await execFile(process.execPath,[cli,'connect','--provider','codex','--data',root,'--session-id',args.includes('worker')?'worker-session':'session-A',...args],{cwd,windowsHide:true})).stdout);
  try {
    const first=await run(workspace);assert.equal(first.role,'brain');assert.equal(first.workspace,fs.realpathSync(workspace));
    assert.match(first.projectId,/^desktop-project-[a-f0-9]{8}$/);
    assert.match(path.basename(first.credential),/^project-[a-f0-9]{8}-brain-[a-f0-9]{8}\.json$/);
    assert.match(JSON.parse(fs.readFileSync(first.credential)).clientId,/^project-[a-f0-9]{8}-brain-[a-f0-9]{8}$/);
    assert.equal(first.tasks.length,0);assert.equal((await run(workspace)).credential,first.credential);
    await assert.rejects(execFile(process.execPath,[cli,'connect','--provider','codex','--data',root,'--session-id','session-B'],{cwd:workspace,windowsHide:true}),/another session/);
    await assert.rejects(execFile(process.execPath,[cli,'connect','--provider','codex','--data',root,'--session-id','session-A','--role','worker','--continue'],{cwd:workspace,windowsHide:true}),/Only brain/);
    // Finish a real empty-change round, then distinguish inspect/connect from explicit continuation.
    const brain=JSON.parse(fs.readFileSync(first.credential));
    const worker=await run(workspace,'--role','worker');const wc=JSON.parse(fs.readFileSync(worker.credential));
    await require('./stage-fixture.cjs').startHttp(root,brain);
    await call(root,brain,{action:'plan',task:{id:'T',title:'check',instructions:'check',acceptance:'checked',allowedPaths:['README.md']}});
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
    const j=(await call(root,wc,{action:'wait'})).job;
    await call(root,wc,{action:'submit',taskId:j.taskId,attemptId:j.attemptId,result:{projectId:j.projectId,taskId:j.taskId,attemptId:j.attemptId,role:'worker',status:'submitted',summary:'checked',checks:[],unverified:[]}});
    await require('./stage-fixture.cjs').approveHttp(root,brain);
    await request(root,{action:'finish-project',projectId:first.projectId});
    assert.equal((await run(workspace)).completed,true);
    const reopened=await run(workspace,'--continue');assert.equal(reopened.completed,false);assert.equal(reopened.tasks[0].state,'accepted');
    const other=path.join(temp,'other');fs.mkdirSync(other);const second=await run(other);
    assert.notEqual(second.projectId,first.projectId);assert.notEqual(second.credential,first.credential);
    await assert.rejects(run(other,'--credential',first.credential),/different role\/workspace\/service/);
  } finally { await request(root,{action:'stop'}); }
});

test('installed skill locates runtime; discovery and status reuse bindings without exposing secrets or claiming work', async () => {
  const base = path.resolve(__dirname, '../tmp'); fs.mkdirSync(base, { recursive: true });
  const temp = fs.mkdtempSync(path.join(base, 'connection-'));
  const root = path.join(temp, 'service'), workspace = path.join(temp, 'project');
  fs.mkdirSync(workspace); initialize(root);
  const { install } = require('../scripts/install.js');
  const home = path.join(temp, 'home'); install({ platforms: ['codex'], home });
  const link = JSON.parse(fs.readFileSync(path.join(home, '.codex/skills/task-dispatch/runtime-link.json')));
  // [AI-added] 2026-09-16 16:00
  // [AI-added] 2026-09-17 11:46
  assert.equal(link.client, cli); assert.equal(link.version,3); assert.equal(link.dataMode,'workspace-local-v2');assert.equal(link.data,undefined);
  const run = async (...args) => JSON.parse((await execFile(process.execPath, [cli, ...args, '--data', root], { windowsHide: true })).stdout);
  assert.deepEqual((await run('discover', '--workspace', workspace)).connections, []);
  assert.equal(fs.existsSync(path.join(root, 'connections')), false);
  const service = await serve(root);
  try {
    for (const role of ['brain', 'worker']) {
      const credential = path.join(root, role + '.json');
      await run('attach', '--role', role, '--workspace', workspace, '--credential', credential);
      await run('attach', '--role', role, '--workspace', workspace, '--credential', credential);
    }
    const found = await run('discover', '--workspace', workspace);
    assert.equal(found.connections.length, 2); assert.equal(found.selectionRequired, true);
    const worker = (await run('discover', '--workspace', workspace, '--role', 'worker')).connections[0];
    const secret = JSON.parse(fs.readFileSync(worker.credential));
    assert.ok(!JSON.stringify(found).includes(secret.token));
    const brain = JSON.parse(fs.readFileSync(path.join(root, 'brain.json')));
    await require('./stage-fixture.cjs').startHttp(root,brain);
    await call(root, brain, { action: 'plan', task: { id: 'T', title: 'edit', instructions: 'edit', acceptance: 'correct', allowedPaths: ['README.md'] } });
  await require('./stage-fixture.cjs').beginHttp(root,brain,['T']);
    const before = JSON.stringify(service.store.state);
    const status = await run('status', '--credential', worker.credential);
    assert.equal(status.role, 'worker'); assert.equal(status.tasks[0].id, 'T');
    assert.equal(JSON.stringify(service.store.state), before);
    assert.ok(!JSON.stringify(status).includes(secret.token));
    assert.ok(!JSON.stringify(status).includes('tokenHash'));
    await assert.rejects(call(root, { token: 'invalid' }, { action: 'status' }), /Invalid desktop token/);
    assert.deepEqual((await run('discover', '--workspace', temp)).connections, []);
    await request(root, { action: 'pause', projectId: worker.projectId });
    assert.equal((await run('status', '--credential', worker.credential)).paused, true);
  } finally { await service.close(); }
  // Discovery also works offline and never starts a replacement service.
  assert.equal((await run('discover', '--workspace', workspace)).connections.length, 2);
});

test('readable desktop identifiers remain valid for a Chinese project directory', () => {
  const { readableName, workspaceKey, desktopProjectId } = require('../runtime/core/storage.cjs');
  const workspace = path.resolve('tmp', '测试项目');
  assert.match(readableName(workspace),/^u[0-9a-f]+(?:-u[0-9a-f]+)+$/);
  assert.match(workspaceKey(workspace),/^[a-z0-9-]+-[a-f0-9]{8}$/);
  assert.match(desktopProjectId(workspace),/^desktop-[a-z0-9-]+-[a-f0-9]{8}$/);
});
