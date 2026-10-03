// Experimental, read-only discovery of this Desktop build's private tools pipe.
// Does not modify Desktop files or start model turns.
const net = require('node:net');
const fs = require('node:fs');
function rpc(pipe, message, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let buffer = Buffer.alloc(0), finished = false;
    const finish = (e, value) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); e ? reject(e) : resolve(value); };
    const timer = setTimeout(() => finish(Error('timeout')), timeoutMs);
    socket.on('error', e => finish(e)); socket.on('close', () => finish(Error('closed')));
    socket.on('connect', () => { const text = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(text.length); socket.write(Buffer.concat([header,text])); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer,chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(); if (size > 8*1024*1024) return finish(Error('oversize'));
      if (buffer.length >= 4+size) { try { finish(null,JSON.parse(buffer.subarray(4,4+size).toString())); } catch(e) { finish(e); } }
    });
  });
}
async function main() {
  const paths = (await fs.promises.readdir('\\\\.\\pipe\\')).filter(name=>name.toLowerCase().includes('codex-browser-use-')).map(name=>'\\\\.\\pipe\\'+name);
  for (const pipe of paths) {
    try {
      const result = await rpc(pipe,{id:1,jsonrpc:'2.0',method:'tools/list',params:{threadStartKind:'all'}});
      const tools = result.result?.tools;
      console.log(JSON.stringify({pipe,tools:tools?.filter(t=>/send_message_to_thread|read_thread/.test(t.name)),error:result.error}));
    } catch(e) { console.log(JSON.stringify({pipe,error:e.message})); }
  }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={rpc};
