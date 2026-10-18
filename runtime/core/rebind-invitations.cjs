// [AI-added] 2026-09-17 11:46
'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const {bindingKey}=require('./bindings.cjs');
const {buildRebindInvitation}=require('./invitations.cjs');
const roleOf=key=>['brain','reviewer'].includes(key)?key:'worker';
const workerOf=key=>key==='worker'?'default':key.startsWith('worker:')?key.slice(7):undefined;
function create(store,root,input){
 const p=store.state.projects[input.projectId],old=p?.bindings?.[input.binding];
 if(!p||!old||old.clientId!==input.clientId)throw Error('绑定已变化，请刷新后重试');
 if(input.confirmedStopped===true&&typeof input.reason!=='string')throw Error('恢复改绑需要记录原因');
 const id=crypto.randomUUID(),now=Date.now(),role=roleOf(input.binding),workerId=workerOf(input.binding),recover=input.confirmedStopped===true;
 store.change(s=>{const q=s.projects[p.id];q.rebindInvitations||={};const superseded=[];for(const invite of Object.values(q.rebindInvitations))if(invite.binding===input.binding&&['pending','claimed'].includes(invite.status)){invite.status='superseded';invite.finishedAt=new Date(now).toISOString();superseded.push(invite.id);}
  if(q.handovers?.[input.binding]?.invitationId&&superseded.includes(q.handovers[input.binding].invitationId))delete q.handovers[input.binding];
  q.rebindInvitations[id]={id,binding:input.binding,role,workerId,previousClientId:old.clientId,status:'pending',recover,reason:input.reason||'',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+30*60*1000).toISOString()};
  store.event(s,'rebind_invitation_created',{projectId:p.id,binding:input.binding,clientId:old.clientId,summary:recover?'confirmed recovery':'safe handover'});});
 const capability=old.capabilities?.[0];
 // [AI-added] 2026-09-21: The console shows the variant matching the platform being replaced first.
 const preferred=old.provider;
 return buildRebindInvitation({role,workerId,capability,workspace:p.workspace,dataRoot:root,clientPath:path.resolve(__dirname,'../desktop-client.cjs'),referencePath:path.resolve(__dirname,'../../skills/task-dispatch/references/connection.md'),invitationId:id,recover,preferredProvider:preferred});
}
function authorize(store,{workspace,invitationId,role,workerId,recover,clientId}){
 const p=Object.values(store.state.projects).find(project=>project.workspace===workspace),invite=p?.rebindInvitations?.[invitationId],key=bindingKey({role,workerId});
 if(invite?.status==='completed'&&invite.clientId===clientId&&p.bindings?.[key]?.clientId===clientId)return {project:p,invite,key,completed:true};
 if(!invite||!['pending','claimed'].includes(invite.status))throw Error('Managed rebind invitation is missing, completed or cancelled');
 if(Date.parse(invite.expiresAt)<=Date.now()){update(store,p.id,invitationId,'expired',invite.clientId);throw Error('Managed rebind invitation expired; generate a new one in the console');}
 if(invite.binding!==key||invite.role!==role||(invite.workerId||undefined)!==(role==='worker'?(workerId||'default'):undefined))throw Error('Managed rebind invitation role/worker mismatch');
 if(invite.recover!==(recover===true))throw Error('Managed rebind recovery flags do not match operator approval');
 if(p.bindings?.[key]?.clientId!==invite.previousClientId)throw Error('Binding changed after invitation creation');
 return {project:p,invite,key};
}
function update(store,projectId,invitationId,status,clientId){
 const current=store.state.projects[projectId]?.rebindInvitations?.[invitationId];
 if(!current||['completed','cancelled','superseded','expired'].includes(current.status)||(current.status===status&&(!clientId||current.clientId===clientId)))return;
 store.change(s=>{const invite=s.projects[projectId]?.rebindInvitations?.[invitationId];invite.status=status;invite.clientId=clientId||invite.clientId;if(!['pending','claimed'].includes(status))invite.finishedAt=new Date().toISOString();store.event(s,'rebind_invitation_'+status,{projectId,binding:invite.binding,clientId:invite.clientId});});
}
function cancel(store,projectId,invitationId){
 const invite=store.state.projects[projectId]?.rebindInvitations?.[invitationId];if(!invite||!['pending','claimed'].includes(invite.status))throw Error('邀请不存在或已结束');
 store.change(s=>{const q=s.projects[projectId],current=q.rebindInvitations[invitationId];current.status='cancelled';current.finishedAt=new Date().toISOString();if(q.handovers?.[current.binding]?.invitationId===invitationId)delete q.handovers[current.binding];store.event(s,'rebind_invitation_cancelled',{projectId,binding:current.binding,clientId:current.clientId});});return {cancelled:true,invitationId};
}
module.exports={create,authorize,update,cancel};
