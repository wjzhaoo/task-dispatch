'use strict';
const fs = require('node:fs'), path = require('node:path');
const { id, read, alive } = require('./storage.cjs');

// A live or ambiguous owner is never removed. Release only this invocation's lock.
async function withFileLock(file, fn, timeoutMs = 30000) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const owner=id(), deadline=Date.now()+timeoutMs;
  while(true) {
    try { fs.writeFileSync(file,JSON.stringify({pid:process.pid,owner}),{flag:'wx',mode:0o600}); break; }
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      try { const old=read(file);if(Number.isInteger(old.pid)&&!alive(old.pid)&&read(file).owner===old.owner)fs.unlinkSync(file); }
      catch(error) { if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error; }
      if(Date.now()>=deadline)throw Error('Timed out waiting for connection/startup lock: '+file);
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  try { return await fn(); }
  finally { if(fs.existsSync(file)&&read(file).owner===owner)fs.unlinkSync(file); }
}
module.exports = { withFileLock };
