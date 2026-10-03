const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {Agent,factory}=require('../runtime/adapters/agents.cjs');
for(const adapter of ['codex','zcode'])for(const scenario of ['success','permission','disconnect',...(adapter==='zcode'?['background']:[])]){
 test(adapter+' stdio '+scenario,async()=>{
  const agent=new Agent({adapter,command:process.execPath,args:[path.join(__dirname,'mock-agent.cjs'),adapter,scenario],timeoutMs:3000});
  const run=agent.run({cwd:__dirname,role:'brain',prompt:'test',onSession:id=>assert.equal(id,'s'),signal:new AbortController().signal});
  if(scenario==='success')assert.equal((await run).text,'final');else await assert.rejects(run);
 });
}
test('real and experimental calls require configuration opt-in',()=>{
 assert.throws(()=>factory({enableRealCalls:false})({adapter:'codex'}),/disabled/);
 assert.throws(()=>factory({enableRealCalls:true})({adapter:'zcode'}),/Acknowledged/);
});
