'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../runtime/console-web/project-setup.mjs');
const project=()=>({id:'project',tasks:[{id:'first',attempts:[]},{id:'clicked',attempts:[{id:'attempt'}]}],
  goals:[{id:'first-goal'},{id:'clicked-goal'}],connections:[
    {binding:'worker:other',clientId:'other-client'},
    {binding:'brain',clientId:'brain-client',rebindInvitation:{id:'invite'}}
  ]});

test('member actions capture only the clicked member and its original client identity',async()=>{
  const {commandTarget}=await modulePromise,p=project();
  for(const action of ['rebind-invite','detach']) {
    const target=commandTarget(p,action,{binding:'brain',taskId:'first',goalId:'first-goal'});
    assert.deepEqual(target,{projectId:'project',binding:'brain',clientId:'brain-client'});
    assert.ok(Object.isFrozen(target));
  }
  const target=commandTarget(p,'rebind-invite',{binding:'brain'});
  p.connections[1].clientId='replacement';p.connections.reverse();
  assert.equal(target.clientId,'brain-client');
  assert.deepEqual(commandTarget(p,'rebind-cancel',{binding:'brain',invitationId:'invite'}),{projectId:'project',binding:'brain',clientId:'replacement',invitationId:'invite'});
  assert.throws(()=>commandTarget(p,'rebind-cancel',{binding:'brain',invitationId:'stale'}),/邀请已变化/);
});

test('goal and task actions retain the clicked card instead of the first item or selected member',async()=>{
  const {commandTarget}=await modulePromise,p=project();
  for(const action of ['start-goal','cancel-goal']) assert.deepEqual(commandTarget(p,action,{goalId:'clicked-goal',binding:'brain'}),{projectId:'project',goalId:'clicked-goal'});
  for(const action of ['task-budget','reset-task','retry','assign','wake-retry','wake-remind']) {
    assert.deepEqual(commandTarget(p,action,{taskId:'clicked',goalId:'first-goal',binding:'brain'}),{projectId:'project',taskId:'clicked',attemptId:'attempt'});
  }
});

test('removed or unspecified targets fail closed even when other cards remain',async()=>{
  const {commandTarget}=await modulePromise,p=project();
  for(const action of ['start-goal','cancel-goal','task-budget','reset-task','retry','assign','wake-retry','wake-remind','rebind-invite','detach','rebind-cancel']) {
    assert.throws(()=>commandTarget(p,action),/不存在/);
    assert.throws(()=>commandTarget(p,action,{taskId:'gone',goalId:'gone',binding:'gone'}),/不存在/);
  }
  assert.throws(()=>commandTarget({...p,readOnly:true},'pause'),/不可操作/);
});

test('project operations cannot inherit unrelated task or member selection',async()=>{
  const {commandTarget}=await modulePromise;
  for(const action of ['pause','resume','archive-project','restore-project','delete-project','stop',undefined]) {
    assert.deepEqual(commandTarget(project(),action,{taskId:'clicked',binding:'brain',goalId:'clicked-goal'}),{projectId:'project'});
  }
});
