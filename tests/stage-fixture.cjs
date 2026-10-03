// [AI-added] 2026-09-26 16:00: Explicit stage setup shared by infrastructure regression tests.
'use strict';
const {Desktop}=require('../runtime/core/desktop.cjs');
const stage=require('../runtime/core/stage-review.cjs');
function peers(desktop,projectId){
 const p=desktop.store.state.projects[projectId],identities={};
 for(const role of ['brain','reviewer']){
  if(!p.bindings?.[role])desktop.attach({workspace:p.workspace,role,clientId:'fixture-'+role,token:(role==='brain'?'d':'e').repeat(64)});
  const b=desktop.store.state.projects[projectId].bindings[role];identities[role]={projectId,role,clientId:b.clientId};
 }
 require('../runtime/core/pre-review.cjs').touch(desktop.d,identities.reviewer);return identities;
}
function start(desktop,brain){peers(desktop,brain.projectId);return require('../runtime/core/startup.cjs').start(desktop,brain,{confirmed:true});}
function begin(d,projectId){
 const desktop=new Desktop(d);projectId ||= Object.keys(d.store.state.projects)[0];
 const p=d.store.state.projects[projectId];if(stage.active(p))return;
 const members=Object.values(p.tasks).filter(t=>t.state==='ready'&&!t.attempts.length&&!t.roundId).map(t=>({taskId:t.id}));if(!members.length)return;
 const {brain}=peers(desktop,projectId),n=Object.keys(p.reviewStages||{}).length+1;
 return stage.register(desktop,brain,{stageId:'stage'+n,roundId:'round'+n,milestone:'Infrastructure test stage',acceptance:'Test assertions hold',members});
}
async function startHttp(root,brain,reviewer){
 const {request}=require('../runtime/wizard.cjs'),{call}=require('../runtime/desktop-client.cjs');
 const status=await call(root,brain,{action:'status'});
 if(!status.boundRoles.includes('reviewer'))reviewer=await request(root,{action:'attach-desktop',workspace:status.workspace,role:'reviewer',clientId:'fixture-reviewer',token:'e'.repeat(64)});
 reviewer ||= {projectId:brain.projectId,role:'reviewer',clientId:'fixture-reviewer',token:'e'.repeat(64)};await call(root,reviewer,{action:'heartbeat'});
 return call(root,brain,{action:'start-work',confirmed:true});
}
async function beginHttp(root,brain,ids,roundId='test-round'){
 const {call}=require('../runtime/desktop-client.cjs');return call(root,brain,{action:'stage-register',stageId:roundId,roundId,milestone:'Infrastructure test stage',acceptance:'Assertions hold',members:ids.map(taskId=>({taskId}))});
}
module.exports={peers,start,begin,startHttp,beginHttp};

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../runtime/core/storage.cjs'),{Dispatcher}=require('../runtime/core/dispatcher.cjs');
async function setup(t){
 const parent=path.resolve('tmp/stage-v1-20260926');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'case-')),workspace=path.join(dir,'work');fs.mkdirSync(workspace);
 const store=new Store(path.join(dir,'service')),d=new Dispatcher(store,{enableRealCalls:false},()=>assert.fail('No model calls')),desktop=new Desktop(d);
 d.addProject({id:'p',workspace,mode:'desktop'});const identities={};for(const role of ['brain','worker','reviewer'])identities[role]=desktop.attach({workspace,role,clientId:role+'-client',token:crypto.randomBytes(32).toString('hex')});
 require('../runtime/core/pre-review.cjs').touch(d,identities.reviewer);require('../runtime/core/startup.cjs').start(desktop,identities.brain,{confirmed:true});
 t.after(async()=>{await d.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const p=()=>store.state.projects.p;
 const task=(id,options={})=>desktop.plan(identities.brain,{id,title:id,instructions:'implement '+id,acceptance:'correct '+id,allowedPaths:[id+'.txt'],...options});
 const definition=(ids=['A','B'],roundId='R1',stageId='login')=>({roundId,stageId,milestone:'完整登录功能',acceptance:'登录及异常处理符合要求，无回归',members:ids.map(taskId=>({taskId}))});
 const register=(value=definition())=>stage.register(desktop,identities.brain,value);
 const drain=async()=>{for(let i=0;i<12;i++){await Promise.all([...d.active.values()].map(e=>e.promise));d.tick();if(!d.active.size)break;}};
 const claim=async role=>{await drain();return desktop.claim(identities[role]);};
 const receipt=(j,verdict='pass')=>({projectId:'p',taskId:j.taskId,attemptId:j.attemptId,role:j.role,summary:'checked',...(j.role==='worker'?{status:'submitted',checks:[],unverified:[]}:{artifactId:j.artifactId,verdict,findings:verdict==='needs_fix'?[{key:'bug',message:'修复实际缺陷'}]:[]})});
 const submit=async(j,verdict='pass')=>{const r=desktop.submit(identities[j.role],{taskId:j.taskId,attemptId:j.attemptId,result:receipt(j,verdict)});await drain();return r;};
 const execute=async(id,file=id+'.txt',content=id)=>{const w=await claim('worker');assert.equal(w?.taskId,id,JSON.stringify(p()));fs.writeFileSync(path.join(workspace,file),content);await submit(w);const r=await claim('reviewer');assert.equal(r?.taskId,id);await submit(r);};
 const verdict=(j,pass=true)=>({projectId:'p',stageId:j.stageId,roundId:j.roundId,attemptId:j.attemptId,role:'brain',contractHash:j.contractHash,compositeArtifactHash:j.compositeArtifactHash,verdict:pass?'pass':'needs_fix',summary:pass?'阶段通过':'整合后发现缺陷',findings:pass?[]:[{key:'integration',message:'登录失败时错误信息未显示'}],members:j.members.map(m=>({...m,verdict:'pass',summary:'单项通过',findings:[]}))});
 const final=(j,result=verdict(j))=>stage.submit(desktop,identities.brain,{roundId:j.roundId,attemptId:j.attemptId,result});
 return {dir,workspace,store,d,desktop,identities,p,task,definition,register,drain,claim,submit,execute,verdict,final};
}

module.exports.setup=setup;

function finalResult(job,verdict='pass') {return {projectId:job.projectId,stageId:job.stageId,roundId:job.roundId,attemptId:job.attemptId,role:'brain',contractHash:job.contractHash,compositeArtifactHash:job.compositeArtifactHash,verdict,summary:'Stage checked',findings:verdict==='pass'?[]:[{key:'fix',message:'Concrete integration defect'}],members:job.members.map(m=>({...m,verdict:'pass',summary:'Member checked',findings:[]}))};}
async function preliminaryHttp(root,brain,reviewer){
 const {call}=require('../runtime/desktop-client.cjs');reviewer ||= {projectId:brain.projectId,role:'reviewer',clientId:'fixture-reviewer',token:'e'.repeat(64)};
 await call(root,reviewer,{action:'heartbeat'});const status=await call(root,brain,{action:'status'});const blocked=status.reviewStages.rounds.find(r=>r.state==='blocked'&&r.error?.includes('Reviewer offline'));if(blocked)await call(root,brain,{action:'stage-resume',roundId:blocked.id});
 const r=(await call(root,reviewer,{action:'wait'})).job;
 await call(root,reviewer,{action:'submit',taskId:r.taskId,attemptId:r.attemptId,result:{projectId:r.projectId,taskId:r.taskId,attemptId:r.attemptId,role:'reviewer',artifactId:r.artifactId,verdict:'pass',summary:'Checked',findings:[]}});
 return r;
}
async function approveHttp(root,brain,reviewer){
 const {call}=require('../runtime/desktop-client.cjs');await preliminaryHttp(root,brain,reviewer);const status=await call(root,brain,{action:'status'});const b=(await call(root,brain,{action:status.wakeEnabled?'claim':'wait'})).job;
 return call(root,brain,{action:'stage-submit',roundId:b.roundId,attemptId:b.attemptId,result:finalResult(b)});
}
module.exports.preliminaryHttp=preliminaryHttp;
module.exports.finalResult=finalResult;module.exports.approveHttp=approveHttp;
