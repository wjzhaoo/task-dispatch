'use strict';
// [AI-added] 2026-09-17 20:21: Bound host adapter calls so one hung response cannot freeze dispatch notifications.
function bounded(label,invoke,timeoutMs){
 let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error(`${label} timed out after ${timeoutMs} ms`);error.code='HOST_CALL_TIMEOUT';reject(error);},timeoutMs);});
 return Promise.race([Promise.resolve().then(invoke),timeout]).finally(()=>clearTimeout(timer));
}
function read(adapter,binding,timeoutMs=15000){return bounded('Host read',()=>adapter.read(binding),timeoutMs);}
function send(adapter,binding,message,timeoutMs=30000){return bounded('Host send',()=>adapter.send(binding,message),timeoutMs);}
module.exports={bounded,read,send};
