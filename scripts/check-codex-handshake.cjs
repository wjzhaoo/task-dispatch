// Explicit diagnostic only: initialize the local server without starting a model turn.
const fs=require('node:fs'),path=require('node:path');
const {Transport}=require('../runtime/adapters/transport.cjs');
(async()=>{
 const cli=path.join(process.env.APPDATA||'', 'npm/node_modules/@openai/codex/bin/codex.js');
 if(!fs.existsSync(cli))throw Error('npm Codex entry not found; configure your executable separately');
 const rpc=new Transport({command:process.execPath,args:[cli,'app-server']},process.cwd());
 try {const r=await rpc.request('initialize',{clientInfo:{name:'task_dispatch_check',version:'0.2.0'}});await rpc.send('initialized',{});console.log(JSON.stringify({initialized:true,userAgent:r.userAgent,modelTurnsStarted:0}));}
 finally{await rpc.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
