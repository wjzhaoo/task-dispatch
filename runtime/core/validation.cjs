'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {sha,atomic}=require('./storage.cjs');
const {manifest,difference,allowed,validatePaths,loadSnapshot}=require('./snapshot.cjs');
function policy(v){
 if(!v||v.dependencies!=='copy-node-modules')throw Error('reviewValidation.dependencies must be copy-node-modules');
 if(!Array.isArray(v.checks)||!v.checks.length||v.checks.length>10)throw Error('Provide 1..10 npm checks');
 for(const c of v.checks)if(!Array.isArray(c)||c.length<2||c[0]!=='run'||c.some(x=>typeof x!=='string'||!x)||!/^[-\w:]+$/.test(c[1]))throw Error('Checks must be npm run SCRIPT [-- ARGS] arrays');
 const outputs=v.outputs||['tmp/','coverage/'];validatePaths(outputs);
 if(outputs.some(x=>!x.endsWith('/')))throw Error('outputs must be directory/ prefixes');
 const timeoutMs=v.timeoutMs??300000;if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw Error('Invalid validation timeout');
 // [AI-added] 2026-09-22 09:20: Evidence is opt-in and must be freshly produced in declared outputs.
 if(v.evidenceResult!==undefined){
  validatePaths([v.evidenceResult]);
  if(v.evidenceResult.endsWith('/')||v.evidenceResult.split('/').some(x=>!x)||!allowed(v.evidenceResult,outputs))throw Error('evidenceResult must be a file within declared outputs');
 }
 return {dependencies:v.dependencies,checks:v.checks,outputs,timeoutMs,...(v.evidenceResult!==undefined?{evidenceResult:v.evidenceResult}:{})};
}
// [AI-added] 2026-09-22 09:20: Bind script findings to the service-owned candidate identity.
function evidence(cwd,name,artifactId,artifactHash){
 if(!name)return {status:'not_configured'};
 try {
  let file=cwd;
  for(const part of name.split('/')){file=path.join(file,part);if(fs.lstatSync(file).isSymbolicLink())throw Error('Evidence links are unsupported');}
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw Error('Evidence must be a file of at most 1 MiB');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value.version!==1||!Array.isArray(value.checks)||!value.checks.length||value.checks.length>1000)throw Error('Invalid evidence version/checks');
  const seen=new Set();
  const checks=value.checks.map(c=>{
   if(!c||typeof c.id!=='string'||!c.id.trim()||c.id.length>200||seen.has(c.id)||typeof c.passed!=='boolean'||!Array.isArray(c.errors)||c.errors.length>1000)throw Error('Invalid evidence check');
   seen.add(c.id);
   const errors=c.errors.map(e=>{
    if(!e||typeof e.path!=='string'||!e.path||e.path.length>1000||typeof e.message!=='string'||!e.message||e.message.length>2000)throw Error('Invalid evidence error location');
    return {path:e.path,message:e.message};
   });
   if(c.passed&&errors.length||!c.passed&&!errors.length)throw Error('Evidence passed flag conflicts with errors');
   return {id:c.id,passed:c.passed,errors};
  });
  return {status:'checked',artifactId,artifactHash,passed:checks.every(c=>c.passed),checks};
 }catch(e){return {status:'invalid',artifactId,artifactHash,passed:false,error:e.message};}
}
function dependencyDigest(root){
 const hash=require('node:crypto').createHash('sha256');
 function walk(dir,relative=''){for(const n of fs.readdirSync(dir).sort()){const f=path.join(dir,n),rel=relative+n,st=fs.lstatSync(f);if(st.isSymbolicLink())throw Error('Dependency links are unsupported: '+rel);if(st.isDirectory())walk(f,rel+'/');else if(st.isFile()){hash.update(rel);hash.update('\0');hash.update(sha(fs.readFileSync(f)));}else throw Error('Unsupported dependency file');}}
 walk(root);return hash.digest('hex');
}
function unchanged(before,cwd,outputs,input){const after=manifest(cwd,{...input,maxTotalBytes:Number.MAX_SAFE_INTEGER,maxFileBytes:Number.MAX_SAFE_INTEGER});return difference(before,after).filter(f=>Object.hasOwn(before,f)||!allowed(f,outputs));}
async function execute(args,cwd,timeoutMs,signal,onProcess){
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 if(!fs.existsSync(npm))throw Error('npm-cli.js not found next to Node runtime');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[npm,...args],{cwd,windowsHide:true,shell:false,env:{...process.env,TMP:path.join(cwd,'tmp'),TEMP:path.join(cwd,'tmp'),TMPDIR:path.join(cwd,'tmp'),NODE_COMPILE_CACHE:path.join(cwd,'tmp','node-compile-cache'),CI:'1'}});
  let text='',killed=false;const append=b=>{if(text.length<1024*1024)text+=b.toString().slice(0,1024*1024-text.length);};
  child.stdout.on('data',append);child.stderr.on('data',append);
  const stop=()=>{killed=true;if(process.platform==='win32'&&child.pid){require('node:child_process').execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});}else child.kill();};const timer=setTimeout(stop,timeoutMs);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  child.once('spawn',()=>{try{onProcess?.(child.pid);}catch(e){stop();}});
  child.once('error',reject);
  child.once('close',(code,sig)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({args,exitCode:code,signal:sig,interrupted:killed,output:text});});
 });
}
async function prepare({workspace,artifacts,artifactId,artifactHash,root,config,changedFiles=[],signal,onProcess,runner=execute}){
 const cfg=policy(config),cwd=path.join(root,'tree');
 const original=loadSnapshot(artifacts,artifactId);
 if(original.hash!==artifactHash||sha(JSON.stringify(original.files))!==artifactHash)throw Error('Validation candidate integrity mismatch');
 const omitted=f=>allowed(f,cfg.outputs)||f.startsWith('.keys/')||f==='.env'||f.startsWith('.env.');
 // [AI-added] 2026-09-22 09:20: Declared outputs cannot hide changed deliverables.
 if(changedFiles.some(f=>allowed(f,cfg.outputs)))throw Error('Validation outputs overlap changed files');
 if(changedFiles.some(f=>omitted(f)&&!allowed(f,cfg.outputs)))throw Error('Validation secret exclusions overlap changed files');
 fs.mkdirSync(cwd,{recursive:true});
 // [AI-added] 2026-09-22 09:20: Never accept a previous execution's result file.
 if(cfg.evidenceResult&&fs.existsSync(path.join(cwd,cfg.evidenceResult)))throw Error('Evidence result already exists in validation tree');
 const before=Object.create(null);
 for(const [name,info]of Object.entries(original.files)){
  if(omitted(name))continue;
  const source=path.join(artifacts,artifactId,'tree',name),dest=path.join(cwd,name);
  if(fs.lstatSync(source).isSymbolicLink())throw Error('Candidate links unsupported');
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);fs.chmodSync(dest,info.mode);
  if(sha(fs.readFileSync(dest))!==info.hash)throw Error('Validation candidate integrity mismatch: '+name);
  before[name]=info;
 }
 for(const name of ['package.json','package-lock.json']){
  if(!before[name]||sha(fs.readFileSync(path.join(workspace,name)))!==before[name].hash)throw Error('Dependency source differs from candidate: '+name);
 }
 const pkg=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));
 for(const c of cfg.checks)if(!pkg.scripts?.[c[1]])throw Error('Missing candidate npm script: '+c[1]);
 const source=path.join(workspace,'node_modules'),dest=path.join(cwd,'node_modules');
 const hash=dependencyDigest(source);fs.cpSync(source,dest,{recursive:true,errorOnExist:true,force:false});
 if(dependencyDigest(dest)!==hash||dependencyDigest(source)!==hash)throw Error('Dependencies changed while copying');
 fs.mkdirSync(path.join(cwd,'tmp'),{recursive:true});
 const report={artifactId,artifactHash,cwd,dependencies:{mode:cfg.dependencies,hash,lockHash:before['package-lock.json'].hash},checks:[],outputs:cfg.outputs,omittedFiles:Object.keys(original.files).filter(omitted),omittedChangedFiles:changedFiles.filter(omitted)};
 for(const args of cfg.checks){
  const r=await runner(args,cwd,cfg.timeoutMs,signal,onProcess);report.checks.push(r);
  atomic(path.join(root,'report.json'),report);
  if(r.interrupted){const e=Error('Validation interrupted; confirm test subprocesses stopped before retry');e.uncertain=true;throw e;}
  // [AI-added] 2026-09-22 09:20: Keep the complete diagnostic on disk and bound the displayed error.
  const changed=unchanged(before,cwd,cfg.outputs,original.policy);
  if(changed.length){report.changedPaths=changed;report.passed=false;atomic(path.join(root,'report.json'),report);throw Error('Validation command changed candidate source or wrote outside declared outputs: '+changed.slice(0,20).join(', ').slice(0,2000));}
 }
 report.evidence=evidence(cwd,cfg.evidenceResult,artifactId,artifactHash);
 report.passed=report.checks.every(c=>c.exitCode===0)&&(report.evidence.status==='not_configured'||report.evidence.passed);atomic(path.join(root,'report.json'),report);
 return {cwd,reportPath:path.join(root,'report.json'),passed:report.passed,artifactId,artifactHash};
}
function prepareIsolated(options){
 const {Worker}=require('node:worker_threads');const {signal,onProcess,...data}=options;
 return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{workerData:data});let complete=false;
  const abort=()=>worker.postMessage({abort:true});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  worker.on('message',m=>{if(m.pid){try{onProcess?.(m.pid);}catch(e){abort();}}else if(m.result){complete=true;resolve(m.result);}else if(m.error){complete=true;const e=Error(m.error);e.uncertain=m.uncertain;reject(e);}});
  worker.on('error',e=>{complete=true;reject(e);});worker.on('exit',()=>{cleanup();if(!complete){const e=Error('Validation worker exited without result');e.uncertain=true;reject(e);}});
 });
}
if(!require('node:worker_threads').isMainThread){
 const {parentPort,workerData}=require('node:worker_threads');const controller=new AbortController();parentPort.on('message',m=>{if(m.abort)controller.abort();});
 prepare({...workerData,signal:controller.signal,onProcess:pid=>parentPort.postMessage({pid})}).then(result=>parentPort.postMessage({result}),e=>parentPort.postMessage({error:e.message,uncertain:!!e.uncertain})).finally(()=>parentPort.close());
}
module.exports={policy,prepare,prepareIsolated,unchanged,dependencyDigest};
