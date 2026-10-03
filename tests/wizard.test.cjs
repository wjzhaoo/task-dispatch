const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {dataRoot,bootstrapRoot,initialize,online,start,request}=require('../runtime/wizard.cjs');
// [AI-added] 2026-09-16 16:00
const {projectDataRoot}=require('../runtime/core/data-root.cjs');
test('data roots isolate projects while explicit paths and saved credentials stay authoritative',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch roots ')),one=path.join(base,'project'),two=path.join(base,'project-copy');
 fs.mkdirSync(one);fs.mkdirSync(two);
 // [AI-added] 2026-09-17 11:46
 assert.throws(()=>dataRoot([],{registryOptions:{file:path.join(base,'empty-registry.json'),home:base}}),/尚无已登记项目/);
 assert.equal(dataRoot([],{workspace:one}),projectDataRoot(one));
 assert.notEqual(dataRoot([],{workspace:one}),dataRoot([],{workspace:two}));
 assert.equal(path.relative(one,projectDataRoot(one)).split(path.sep).slice(0,2).join('/'),'.task-dispatch/runtime');
 const old=path.join(base,'old-global'),credential=path.join(base,'credential.json');
 fs.writeFileSync(credential,JSON.stringify({data:old}));
 assert.equal(dataRoot([],{workspace:one,credentialFile:credential}),old);
 const explicit=path.join(base,'explicit');
 assert.equal(dataRoot(['--data',explicit],{workspace:one,credentialFile:credential}),explicit);
});
// [AI-added] 2026-09-24 13:30: The system index cannot silently become a new shared snapshot cache.
test('new connections cannot create service data in the user-home index',t=>{
 const base=fs.mkdtempSync(path.join(path.resolve('tmp'),'reserved-index-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const workspace=path.join(base,'project');fs.mkdirSync(workspace);
 const roots=require('../runtime/core/data-root.cjs'),home=path.join(base,'home'),index=roots.legacyDataRoot(home);
 assert.throws(()=>roots.resolveDataRoot({args:['--data',index],workspace,home}),/reserved for the system index/);
 assert.equal(roots.resolveDataRoot({workspace,home}),roots.projectDataRoot(workspace));
});
test('wizard initializes once, starts detached, reuses service and resumes saved queue',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch wizard 中文 '));
 assert.equal(dataRoot(['--data',root]),root);assert.throws(()=>dataRoot(['--data']));
 initialize(root);const file=path.join(root,'config.json'),original=fs.readFileSync(file,'utf8');
 initialize(root);assert.equal(fs.readFileSync(file,'utf8'),original);
 // [AI-added] 2026-09-14 09:43
/* Previous implementation:
assert.equal(JSON.parse(original).enableRealCalls,false);
*/
assert.equal(JSON.parse(original).enableRealCalls,true);
 assert.equal(JSON.parse(original).profiles.zcode.experimentalProtocolAcknowledged,true);
 fs.writeFileSync(file,JSON.stringify({...JSON.parse(original),enableRealCalls:false}));
 const waitStopped=async()=>{for(let i=0;i<100;i++){if(!fs.existsSync(path.join(root,'service.lock')))return;await new Promise(r=>setTimeout(r,50));}throw Error('service did not stop');};
 try {
  await start(root);const endpoint=fs.readFileSync(path.join(root,'endpoint.json'),'utf8');
  await start(root);assert.equal(fs.readFileSync(path.join(root,'endpoint.json'),'utf8'),endpoint);
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch workspace '));
  await request(root,{action:'add-project',project:{id:'p',workspace,mode:'desktop'}});
  const brain=await request(root,{action:'attach-desktop',workspace,role:'brain',clientId:'wizard-brain',token:'b'.repeat(64)});await request(root,{action:'attach-desktop',workspace,role:'worker',clientId:'wizard-worker',token:'a'.repeat(64)});await require('./stage-fixture.cjs').startHttp(root,brain);
  await request(root,{action:'add-task',projectId:'p',task:{id:'T',title:'t',instructions:'i',acceptance:'a',allowedPaths:['README.md']}});
  await request(root,{action:'stop'});await waitStopped();await start(root);
  assert.equal((await request(root)).projects.p.tasks.T.state,'ready');
 } finally {if(await online(root))await request(root,{action:'stop'});await waitStopped();}
});
// [AI-added] 2026-09-17 13:54
test('web bootstrap chooses an indexed project without a workspace argument',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch catalog ')),workspace=path.join(base,'project'),root=path.join(base,'service'),file=path.join(base,'registry.json');fs.mkdirSync(workspace);fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({version:1}));fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({version:1,projects:{p:{id:'p',workspace}}}));
 require('../runtime/core/service-registry.cjs').register(root,[workspace],{file});
 assert.equal(bootstrapRoot([],{registryOptions:{file,home:path.join(base,'home')}}),path.resolve(root));fs.rmSync(base,{recursive:true,force:true});
});
// [AI-added] 2026-09-17 14:23
test('dashboard enters an empty catalog instead of failing or creating a service',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch empty catalog ')),home=path.join(base,'home'),cache=path.join(base,'cache');fs.mkdirSync(home);fs.mkdirSync(cache);
 const result=spawnSync(process.execPath,[path.resolve('runtime/wizard.cjs')],{input:'0\n',encoding:'utf8',windowsHide:true,env:{...process.env,NODE_TEST_CONTEXT:'1',USERPROFILE:home,HOME:home,LOCALAPPDATA:cache}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/当前没有可打开的项目/);assert.equal(fs.existsSync(path.join(home,'.task-dispatch-service')),false);fs.rmSync(base,{recursive:true,force:true});
});
// [AI-added] 2026-09-17 19:07
test('dashboard resolves the opened project for one and for many catalog entries',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch catalog choice ')),home=path.join(base,'home'),cache=path.join(base,'cache'),one=path.join(base,'a-one'),two=path.join(base,'b-two'),first=path.join(base,'r1'),second=path.join(base,'r2');
 fs.mkdirSync(home);fs.mkdirSync(path.join(cache,'task-dispatch'),{recursive:true});for(const d of [one,two,first,second])fs.mkdirSync(d);
 for(const root of [first,second])fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({version:1}));
 const index=projects=>fs.writeFileSync(path.join(cache,'task-dispatch','service-registry.json'),JSON.stringify({version:2,services:{},projects}));
 const run=input=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;env.LOCALAPPDATA=cache;env.USERPROFILE=home;env.HOME=home;
  return spawnSync(process.execPath,[path.resolve('runtime/wizard.cjs')],{input,encoding:'utf8',windowsHide:true,env});};
 index({p1:{projectId:'one',workspace:one,dataRoot:first}});
 const single=run('0\n');
 assert.match(single.stdout,new RegExp('数据保存在：'+first.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')));assert.doesNotMatch(single.stdout+single.stderr,/dataRoot/);
 index({p1:{projectId:'one',workspace:one,dataRoot:first},p2:{projectId:'two',workspace:two,dataRoot:second}});
 const many=run('2\n');
 assert.match(many.stdout,new RegExp('数据保存在：'+second.replace(/[\\^$.*+?()[\]{}|]/g,'\\$&')));
 assert.doesNotMatch(many.stdout+many.stderr,/dataRoot/);fs.rmSync(base,{recursive:true,force:true});
});
