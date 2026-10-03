// [AI-added] 2026-09-22 09:55: Historical counts survive mutable task resets and duplicate transport events.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {summary}=require('../runtime/core/workflow-metrics.cjs');
test('repairs pair only the same task and artifact, deduplicate event ids and retain missing-history flags',()=>{
 const state={projects:{p:{id:'p',tasks:{T:{id:'T',repairs:0,attempts:[{id:'r',role:'reviewer',claimedAt:'x',settled:true},{id:'b',role:'brain',settled:true},{id:'prepared',role:'brain'}]}}}},events:[]};
 const add=(id,type,other={})=>state.events.push({id,type,projectId:'p',taskId:'T',...other});
 add('1','review_decision',{attemptId:'r',artifactId:'a',verdict:'pass'});add('2','review_decision',{attemptId:'b',artifactId:'b',verdict:'needs_fix'});add('3','review_decision',{attemptId:'b',artifactId:'a',verdict:'needs_fix'});add('4','scope_returned');add('5','operator_retry');add('6','settlement_recovered');state.events.push({...state.events[2]});
 const s=summary(state)[0];assert.equal(s.businessRepairs,2);assert.equal(s.postPreReviewReturns,1);assert.equal(s.matchedCandidates,1);assert.equal(s.scopeReturns,1);assert.equal(s.unclassifiedRetries,1);assert.equal(s.infrastructureRecoveries,1);assert.equal(s.claimed,1);assert.equal(s.prepared,3);assert.equal(s.historyComplete,false);
});
test('reset history retains phase identity and a replacement cannot match another task candidate',()=>{
 const state={projects:{p:{id:'p',tasks:{A:{id:'A',attempts:[]},B:{id:'B',attempts:[]}}}},events:[
 {id:'1',projectId:'p',taskId:'A',type:'attempt_prepared',attemptId:'r',role:'reviewer'},
 {id:'2',projectId:'p',taskId:'A',type:'review_decision',attemptId:'r',artifactId:'same',verdict:'pass'},
 {id:'3',projectId:'p',taskId:'B',type:'review_decision',role:'brain',artifactId:'same',verdict:'needs_fix'},
 {id:'4',projectId:'p',taskId:'A',type:'review_decision',role:'brain',artifactId:'same',verdict:'needs_fix'},
 {id:'5',projectId:'p',taskId:'A',type:'wake_repair',attempted:false},
 ]};const s=summary(state)[0];assert.equal(s.businessRepairs,2);assert.equal(s.matchedCandidates,1);assert.equal(s.prepared,1);assert.equal(s.historyComplete,false);assert.equal(s.infrastructureRecoveries,0);
});
