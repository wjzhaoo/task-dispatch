'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../runtime/console-web/task-board.mjs');
const task=(id,dependsOn=[],extra={})=>({id,title:id,state:'ready',dependsOn,attempts:[],...extra});
const round=(id,stageId,ids,extra={})=>({id,stageId,state:'collecting',members:ids.map(taskId=>({taskId})),reviewTaskIds:ids,...extra});

test('worker search uses the current assignment after reassignment',async()=>{
 const {buildBoard,matchesTask}=await modulePromise,b=buildBoard({tasks:[task('A',[],{plannedWorkerId:'economy',currentWorkerId:'specialist'})]});
 assert.equal(matchesTask(b.tasks[0],b,{query:'specialist'}),true);assert.equal(matchesTask(b.tasks[0],b,{query:'economy'}),false);
});
test('whole-project totals remain independent of search and completed-task filters',async()=>{
 const {buildBoard,matchesTask}=await modulePromise,p={tasks:[task('A',[],{state:'accepted'}),task('B'),task('C',[],{state:'resolved'}),task('D',[],{state:'blocked'})]},b=buildBoard(p);
 assert.deepEqual(b.counts,{total:4,accepted:1,resolved:1,complete:2,brain:0,attention:1});
 assert.deepEqual(b.tasks.filter(t=>matchesTask(t,b,{filter:'active',query:'D'})).map(t=>t.id),['D']);assert.equal(b.counts.total,4);
});
test('repair round retains original task review badges and shows cumulative membership',async()=>{
 const {buildBoard}=await modulePromise,p={tasks:[task('A',[],{stageId:'login',stageHeld:true}),task('F',[],{stageId:'login'})],reviewStages:{rounds:[round('r1','login',['A'],{state:'completed',verdict:'needs_fix'}),round('r2','login',['A','F'],{state:'reviewing',members:[{taskId:'F'}]})]}};
 const b=buildBoard(p);assert.equal(b.counts.brain,2);assert.deepEqual([...b.stages[0].taskIds],['A','F']);assert.equal(b.reviews.get('A').text,'大脑终审中');assert.equal(b.reviews.get('F').text,'大脑终审中');
 p.reviewStages.rounds[1].state='completed';p.reviewStages.rounds[1].verdict='pass';p.tasks.forEach(t=>t.state='accepted');const passed=buildBoard(p);assert.equal(passed.counts.brain,0);assert.equal(passed.reviews.get('A').key,'passed');
});
test('topological layers show forks, joins, transitive dependencies and isolated tasks',async()=>{
 const {buildBoard}=await modulePromise,b=buildBoard({tasks:[task('D',['B','C']),task('B',['A']),task('C',['A']),task('A'),task('E')]});
 assert.deepEqual(b.layers,[['A','E'],['B','C'],['D']]);assert.equal(b.edges.length,4);assert.deepEqual(b.unresolved,[]);
});
test('cycles, affected descendants and missing dependencies remain visible',async()=>{
 const {buildBoard}=await modulePromise,b=buildBoard({tasks:[task('A',['B']),task('B',['A']),task('C',['A']),task('D',['missing']),task('E')]});
 assert.deepEqual(b.unresolved,['A','B','C','D']);assert.deepEqual(b.missing,[{from:'missing',to:'D'}]);assert.equal(b.counts.total,5);assert.deepEqual(b.layers,[['E']]);
});
test('reset audit rounds do not mark reset tasks as awaiting old brain review',async()=>{
 const {buildBoard}=await modulePromise,b=buildBoard({tasks:[task('A')],reviewStages:{rounds:[round('r1','old',['A'],{state:'reset'})]}});
 assert.equal(b.stages.length,0);assert.equal(b.reviews.get('A').key,'draft');assert.equal(b.counts.brain,0);
});
test('stage and brain filters include originals awaiting repair, but exclude drafts and completed stages',async()=>{
 const {buildBoard,matchesTask}=await modulePromise,b=buildBoard({tasks:[task('A',[],{stageId:'s'}),task('B'),task('C',[],{stageId:'done',state:'accepted'})],reviewStages:{rounds:[round('r1','s',['A'],{state:'completed',verdict:'needs_fix'}),round('r2','done',['C'],{state:'completed',verdict:'pass'})]}});
 assert.equal(b.reviews.get('A').key,'repair');assert.deepEqual(b.tasks.filter(t=>matchesTask(t,b,{filter:'brain'})).map(t=>t.id),['A']);assert.equal(matchesTask(b.tasks[0],b,{stage:'done'}),false);
});
