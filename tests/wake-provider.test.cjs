const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Wake}=require('../runtime/core/wake.cjs');
test('unconnected MiMo cannot silently route to Codex',()=>{
 const codex={read:()=>{throw Error('must not call');}};
 const wake=new Wake({store:{}},codex);
 assert.equal(wake.forProvider(),codex);
 assert.throws(()=>wake.forProvider('mimo'),/not connected/);
});
test('provider resolver preserves explicit provider routing',()=>{
 const mimo={},codex={};
 const wake=new Wake({store:{}},{forProvider:p=>{if(p==='mimo')return mimo;if(p==='codex')return codex;throw Error('unknown');}});
 assert.equal(wake.forProvider('mimo'),mimo);
 assert.equal(wake.forProvider(),codex);
 assert.throws(()=>wake.forProvider('invalid'));
});
// [AI-added] 2026-09-16 00:00
test('Qoder is registered under both product ids and exposes the direct bridge surface',()=>{
 const {WakeProviders}=require('../runtime/adapters/mimo-wake.cjs');
 const providers=new WakeProviders();
 const qoder=providers.forProvider('qoder');
 assert.equal(qoder,providers.forProvider('qodercn'));
 for(const name of ['read','send','bridge','sessions','messages'])assert.equal(typeof qoder[name],'function');
 assert.equal(qoder.lease,undefined);
 assert.equal(typeof providers.forProvider('codex').send,'function');
 assert.equal(typeof providers.forProvider('mimo').send,'function');
 assert.equal(providers.forProvider('codearts'),providers.forProvider('codeartsdoer'));
 const opencode=providers.forProvider('opencode');
 assert.equal(opencode,providers.forProvider('open-code'));
 for(const name of ['verify','read','send'])assert.equal(typeof opencode[name],'function');
});
