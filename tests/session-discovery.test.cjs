'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {discover,marker}=require('../runtime/core/session-discovery.cjs');
// [AI-added] 2026-09-17 09:42
const {buildInvitation}=require('../runtime/core/invitations.cjs');
const workspace=process.cwd(),invitationId=require('node:crypto').randomUUID();
const user=()=>({info:{role:'user'},parts:[{type:'text',text:marker(invitationId)}]});
function adapters(defs){return {forProvider(name){if(!defs[name])throw Error('secret must never be printed');return defs[name];}};}
const host=(messages=[user()])=>({sessions:async()=>[{id:'real',directory:workspace}],messages:async()=>messages});
test('invitation finds the actual session and emits only safe identity metadata',async()=>{
 const result=await discover({workspace,invitationId,provider:'mimo'},adapters({mimo:host()}));
 assert.equal(result.identified,true);assert.equal(result.sessionId,'real');assert.equal(result.provider,'mimo');
 assert.doesNotMatch(JSON.stringify(result),/secret|TASK-DISPATCH-INVITE/);
});
test('directory, activity and assistant echoes cannot substitute for invitation identity',async()=>{
 for(const messages of [[],[{info:{role:'assistant'},parts:user().parts}],[{info:{role:'user'},parts:[{type:'tool',text:marker(invitationId)}]}]]){
  assert.equal((await discover({workspace,invitationId,provider:'mimo'},adapters({mimo:host(messages)}))).identified,false);
 }
 const wrong={...host(),sessions:async()=>[{id:'real',directory:require('node:path').dirname(workspace)}]};
 assert.equal((await discover({workspace,invitationId,provider:'mimo'},adapters({mimo:wrong}))).identified,false);
});
test('duplicate invitations fail closed within or across hosts',async()=>{
 const duplicate={...host(),sessions:async()=>[{id:'one',directory:workspace},{id:'two',directory:workspace}]};
 for(const defs of [{mimo:duplicate}]){
  const result=await discover({workspace,invitationId,provider:'mimo'},adapters(defs));
  assert.equal(result.reason,'ambiguous_invitation');assert.equal(result.sessionId,undefined);
 }
});
test('generated invitations require an explicit platform and carry a Qoder one-time handshake',()=>{
 // [AI-added] 2026-09-17 09:42
 const common={workspace,dataRoot:workspace,clientPath:__filename,referencePath:__filename};
 const invitations=[buildInvitation({...common,role:'worker',workerId:'quick'}),buildInvitation({...common,role:'reviewer'}),buildInvitation({...common,role:'brain'})];
 for(const invitation of invitations){
  const {text}=invitation;
  assert.match(text,/--provider <当前真实平台>/);
  const id=/\[TASK-DISPATCH-INVITE:([a-f0-9-]+)\]/i.exec(text)?.[1];
  assert.ok(id);assert.equal(invitation.invitationId,id);assert.match(text,new RegExp('--invitation-id '+id));
  assert.equal(invitation.schemaVersion,1);assert.equal(invitation.platformSelectionOwner,'receiver');assert.equal(invitation.platformSelectionRequired,true);
  for(const key of ['workspace','client','data','reference','commandTemplate','sessionRequirements'])assert.ok(invitation[key]);
 }
});
// [AI-added] 2026-09-15 19:16
test('discovery requires one explicit provider and aliases stay bounded',async()=>{
 const seen=[];
 const stub={forProvider(name){seen.push(name);throw Error('unavailable');}};
 await assert.rejects(discover({workspace,invitationId},stub),/explicit --provider/);
 await assert.rejects(discover({workspace,invitationId,provider:'auto'},stub),/explicit --provider/);
 assert.deepEqual(seen,[]);
 await discover({workspace,invitationId,provider:'qodercn'},stub);
 assert.deepEqual(seen.slice(-1),['qoder']);
 await discover({workspace,invitationId,provider:'qoder'},stub);
 assert.deepEqual(seen.slice(-1),['qoder']);
});
test('Qoder discovery uses the invitation handoff without enumerating histories',async()=>{
 const seen=[];
 const qoder={discoverInvitation:async input=>{seen.push(input);return [{id:'qoder-real',directory:workspace}];},sessions:async()=>{throw Error('must not list');},messages:async()=>{throw Error('must not read');}};
 const result=await discover({workspace,invitationId,provider:'qoder'},adapters({qoder}));
 assert.equal(result.identified,true);assert.equal(result.sessionId,'qoder-real');
 assert.deepEqual(seen,[{invitationId,workspace}]);
});
test('real adapter discovery keeps credentials internal and uses host-specific routes',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 fs.mkdirSync(path.resolve('tmp'),{recursive:true});
 const dir=fs.mkdtempSync(path.resolve('tmp/discovery-'));
 const secret='b'.repeat(64),file=path.join(dir,'mimo.json'),bridge=path.join(dir,'bridge.json');
 fs.writeFileSync(file,JSON.stringify({api:1,port:12345,token:secret}));
 fs.writeFileSync(bridge,JSON.stringify({version:2,directory:workspace,url:'http://127.0.0.1:12345',token:secret}));
 for(const provider of ['mimo']){
  const routes=[];
  const fetchImpl=async(url,options)=>{
   const route=new URL(url).pathname;routes.push(route);
   assert.equal(options.headers.Authorization,'Bearer '+secret);
   return Response.json(route.endsWith('/sessions')?[{id:'real',directory:workspace}]:[user()]);
  };
  const adapter=new(require('../runtime/adapters/mimo-wake.cjs').MimoWake)({credentialFile:file,fetchImpl});
  const result=await discover({workspace,invitationId,provider},adapters({[provider]:adapter}));
  assert.equal(result.sessionId,'real');assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(routes,['/v1/sessions','/v1/sessions/real/messages']);
 }
});
test('CodeArts discovery aliases use their own host',async()=>{
 for(const provider of ['codearts','codeartsdoer']){
  const result=await discover({workspace,invitationId,provider},adapters({codearts:host()}));
  assert.equal(result.identified,true);assert.equal(result.provider,'codearts');
 }
});
test('MiMo preserves Desktop effective permission defaults and explicit restrictions',()=>{
 const {effectivePermission:perm}=require('../runtime/adapters/mimo-wake.cjs');
 assert.equal(perm({perm:''},'s'),'帮我审批');
 assert.equal(perm({perm:'默认权限'},'s'),'默认权限');
 assert.equal(perm({perm:'完全访问权限',fullAccessEnabled:false},'s'),'默认权限');
 assert.equal(perm({perm:'完全访问权限',permByConvo:{s:'默认权限'}},'s'),'默认权限');
 assert.equal(perm({perm:'默认权限',permByConvo:{s:'接受编辑权限'}},'s'),'帮我审批');
 assert.equal(perm({perm:'默认权限',permByConvo:'{"s":"帮我审批"}'},'s'),'帮我审批');
});
test('MiMo wake sends the effective stored UI mode without changing preferences',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const dir=fs.mkdtempSync(path.resolve('tmp/mimo-perm-')),file=path.join(dir,'desktop-api.json'),prefs=path.join(dir,'preferences.json');
 fs.writeFileSync(file,JSON.stringify({api:1,port:12345,token:'c'.repeat(64)}));
 const sent=[];
 let posted='';
 const a=new(require('../runtime/adapters/mimo-wake.cjs').MimoWake)({credentialFile:file,fetchImpl:async(url,options)=>{
  const route=new URL(url).pathname;
  if(route.endsWith('/sessions'))return Response.json([{id:'s',directory:workspace}]);
  // [AI-added] 2026-09-19: A wake is only delivered once the history read confirms it.
  if(route.endsWith('/messages'))return Response.json([{info:{role:'user'},parts:[{text:posted}]}]);
  posted=JSON.parse(options.body).message;sent.push(JSON.parse(options.body));return Response.json({ok:true},{status:202});
 }});
 for(const [settings,expected] of [[{perm:''},'帮我审批'],[{perm:'默认权限'},'默认权限'],[{perm:'完全访问权限',fullAccessEnabled:false},'默认权限']]){
  const before=JSON.stringify(settings);fs.writeFileSync(prefs,before);
  await a.send({threadId:'s',model:'p/m'},'wake');
  assert.equal(sent.at(-1).perm,expected);assert.equal(fs.readFileSync(prefs,'utf8'),before);
 }
});
