'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {DshWake} = require('../runtime/adapters/dsh-wake.cjs');
const {WAKE_PROVIDERS, assertRoleProvider, continuationMode} = require('../runtime/core/platforms.cjs');
const {buildJoinInvitation, buildRebindInvitation} = require('../runtime/core/invitations.cjs');

function fixture(t) {
  const root = path.resolve('tmp'); fs.mkdirSync(root,{recursive:true});
  const home = fs.mkdtempSync(path.join(root,'dsh-wake-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const secret = crypto.randomBytes(32), calls = [];
  fs.writeFileSync(path.join(home,'.credentials.yaml'), 'records:\n  client-connection/browser-session:\n    payload:\n      secret: ' + secret.toString('base64url') + '\n');
  const session = {sessionId:'session-test',cwd:home,running:false,agentAvailable:true,projections:{values:{turnOutline:[{prompt:'hello',response:'world'}]}}};
  let port = 12345, result = {accepted:true}, failure;
  const adapter = new DshWake({home,env:{},discoverUrl:async()=>'http://127.0.0.1:'+port,fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body); calls.push({url:String(url),options,request});
    assert.equal(options.redirect,'error'); assert.equal(new URL(url).pathname,'/api/'+request.method);
    assert.deepEqual(Object.keys(request.payload),['args']);
    const authority = new URL(url).host;
    const name = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
    const [cookieName, cookieValue] = options.headers.Cookie.split('='); assert.equal(cookieName,name);
    const [version,body,signature] = cookieValue.split('.'); assert.equal(version,'v1');
    assert.equal(signature,crypto.createHmac('sha256',secret).update(body).digest('base64url'));
    const payload=JSON.parse(Buffer.from(body,'base64url'));assert.equal(payload.authority,authority);assert.ok(payload.expiresAt>Date.now());
    if(request.method==='session/list') { assert.deepEqual(request.payload.args,{_request:{}}); return Response.json({result:{ok:true,value:{items:[session]}}}); }
    assert.equal(request.method,'session/prompt');
    if(failure) return failure();
    return Response.json({result:{ok:true,value:result}});
  }});
  return {home,session,adapter,calls,setPort:v=>{port=v;},setResult:v=>{result=v;},setFailure:v=>{failure=v;},binding:{threadId:session.sessionId,workspace:home}};
}

test('all six wake platforms appear in join/rebind for every role; only workers offer wait',()=>{
  assert.deepEqual(new Set(WAKE_PROVIDERS),new Set(['codex','qoder','opencode','codearts','mimo','dsh']));
  const base={workspace:process.cwd(),dataRoot:path.resolve('tmp/service'),clientPath:path.resolve('runtime/desktop-client.cjs'),referencePath:path.resolve('skills/task-dispatch/references/connection.md'),invitationId:crypto.randomUUID(),workerId:'default'};
  for(const role of ['brain','reviewer','worker']) {
    for(const provider of WAKE_PROVIDERS) { assert.equal(assertRoleProvider(role,provider),provider);assert.equal(continuationMode(provider),'wake'); }
    for(const build of [buildJoinInvitation,buildRebindInvitation]) {
      const invitation=build({...base,role,preferredProvider:'dsh'});
      assert.deepEqual(invitation.platforms.map(p=>p.provider),[...WAKE_PROVIDERS,...(role==='worker'?['wait']:[]),'any']);
      const dsh=invitation.platforms.find(p=>p.provider==='dsh');assert.match(dsh.commandTemplate,/--provider dsh --session-id/);
    }
    if(role==='worker') assert.equal(assertRoleProvider(role,'other-host'),'other-host');
    else assert.throws(()=>assertRoleProvider(role,'other-host'),/only supports/);
  }
  const providers=new (require('../runtime/adapters/mimo-wake.cjs').WakeProviders)();
  assert.ok(providers.forProvider('DSH') instanceof DshWake);
});

test('DSH signs the current authority, reads history and rediscovers the host port',async t=>{
  const x=fixture(t);
  const info=await x.adapter.verify(x.binding); assert.equal(info.thread.status.type,'idle');assert.equal(info.thread.cwd,x.home);
  assert.equal(info.turns[0].items[0].content[0].text,'hello');
  x.setPort(54321);x.session.running=true;
  assert.equal((await x.adapter.read(x.binding)).thread.status.type,'active');assert.match(x.calls.at(-1).url,/:54321/);
  await assert.rejects(x.adapter.verify({...x.binding,threadId:'missing'}),/identity or workspace/);
  await assert.rejects(x.adapter.verify({...x.binding,workspace:path.dirname(x.home)}),/identity or workspace/);
});

test('DSH queues a cold idle session, reports acceptance without claiming completion',async t=>{
  const x=fixture(t),result=await x.adapter.send(x.binding,'[TASK-DISPATCH-WAKE:test] 领取任务');
  assert.equal(result.delivered,true);assert.equal(result.accepted,true);assert.equal(result.completed,undefined);
  const request=x.calls.at(-1).request.payload.args.request;
  assert.equal(request.sessionId,x.session.sessionId);assert.equal(request.mode,'queue');assert.equal(request.requestId,result.requestId);
  assert.deepEqual(request.content,[{type:'text',text:'[TASK-DISPATCH-WAKE:test] 领取任务'}]);
});

test('DSH blocks busy, changed and foreign bindings before sending',async t=>{
  const x=fixture(t);
  x.session.running=true;await assert.rejects(x.adapter.send(x.binding,'test'),e=>e.safeToRetry===true);
  x.session.running=false;await assert.rejects(x.adapter.send({...x.binding,canSend:()=>false},'test'),e=>e.safeToRetry===true);
  await assert.rejects(x.adapter.send({...x.binding,workspace:path.dirname(x.home)},'test'),/workspace mismatch/);
  await assert.rejects(x.adapter.send({...x.binding,model:'provider/model'},'test'),/omit --model/);
  assert.equal(x.calls.filter(c=>c.request.method==='session/prompt').length,0);
});

test('DSH rejects non-loopback endpoints before exposing credentials',async t=>{
  const x=fixture(t);
  for(const baseUrl of ['http://example.com','http://127.0.0.1/?token=secret','http://user:secret@localhost']) {
    const a=new DshWake({home:x.home,baseUrl,fetchImpl:()=>assert.fail('must not send')});
    await assert.rejects(a.read(x.binding),/loopback origin/);
  }
});

test('DSH never marks rejected or uncertain RPCs delivered or safe to replay, and hides error bodies',async t=>{
  const x=fixture(t);
  x.setResult({accepted:false});await assert.rejects(x.adapter.send(x.binding,'test'),e=>!e.safeToRetry&&/unconfirmed/.test(e.message));
  x.setFailure(()=>Response.json({result:{ok:false,error:{message:'secret-cookie'}}}));
  await assert.rejects(x.adapter.send(x.binding,'test'),e=>!e.safeToRetry&&!e.message.includes('secret-cookie')&&/RPC rejected/.test(e.message));
  x.setFailure(()=>new Response('secret-cookie',{status:401}));
  await assert.rejects(x.adapter.send(x.binding,'test'),e=>!e.safeToRetry&&/HTTP 401/.test(e.message)&&!e.message.includes('secret-cookie'));
  x.setFailure(()=>{throw Error('secret-cookie');});
  await assert.rejects(x.adapter.send(x.binding,'test'),e=>!e.safeToRetry&&!e.message.includes('secret-cookie'));
});

test('DSH invitation discovery requires a matching user prompt in the exact workspace',async t=>{
  const x=fixture(t),invitationId=crypto.randomUUID(),marker='[TASK-DISPATCH-INVITE:'+invitationId+']';
  const {discover}=require('../runtime/core/session-discovery.cjs'),adapters={forProvider:p=>{assert.equal(p,'dsh');return x.adapter;}};
  x.session.projections.values.turnOutline=[{prompt:'other',response:marker}];
  assert.equal((await discover({workspace:x.home,invitationId,provider:'dsh'},adapters)).identified,false);
  x.session.projections.values.turnOutline[0].prompt=marker;
  const result=await discover({workspace:x.home,invitationId,provider:'dsh'},adapters);assert.equal(result.sessionId,x.session.sessionId);
  assert.doesNotMatch(JSON.stringify(result),/Cookie|secret/);
});
