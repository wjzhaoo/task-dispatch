// [AI-added] 2026-09-14 20:10
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';

/* Previous implementation wrote CodeArts Basic Auth credentials from environment
   variables. CodeArts 26.9 does not expose those variables to external plugins.
   V2 keeps authentication inside the already-authenticated SDK client and exposes
   only a random-token loopback bridge to task-dispatch. */
export const TaskDispatch = async (ctx) => {
  const directory = ctx.directory;
  const root = path.join(os.homedir(), '.codeartsdoer', 'task-dispatch');
  const token = crypto.randomBytes(32).toString('hex');
  const json = (res, status, value) => { const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)});res.end(body); };
  const result = value => value?.data ?? value;
  const call = async (name, id, body) => {
    const options={query:{directory}};
    if(id)options.path={id};
    if(body)options.body=body;
    const response=await ctx.client.session[name](options);
    if(response?.error)throw Error(typeof response.error==='string'?response.error:JSON.stringify(response.error));
    return result(response);
  };
  const server=http.createServer((req,res)=>{
    const run=async()=>{
      if(req.headers.authorization!=='Bearer '+token)return json(res,401,{error:'Unauthorized'});
      const url=new URL(req.url,'http://127.0.0.1');
      const match=/^\/v1\/session\/([^/]+)(?:\/(messages|prompt))?$/.exec(url.pathname);
      // [AI-added] 2026-09-14 20:18
      if(req.method==='GET'&&url.pathname==='/v1/sessions')return json(res,200,await call('list'));
      if(req.method==='GET'&&url.pathname==='/v1/status')return json(res,200,await call('status'));
      if(!match)return json(res,404,{error:'Not found'});
      const id=decodeURIComponent(match[1]);
      if(req.method==='GET'&&!match[2])return json(res,200,await call('get',id));
      if(req.method==='GET'&&match[2]==='messages')return json(res,200,await call('messages',id));
      if(req.method==='POST'&&match[2]==='prompt'){
        let size=0,text='';for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('Body too large');text+=chunk;}
        const body=JSON.parse(text);if(!Array.isArray(body.parts))throw Error('Invalid prompt body');
        await call('promptAsync',id,body);res.writeHead(204);return res.end();
      }
      return json(res,405,{error:'Method not allowed'});
    };
    run().catch(error=>json(res,400,{error:error.message}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  // [AI-added] 2026-09-14 20:18
  const writeRecord=(file,value)=>{
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);
  };
  const bridge={version:2,directory,url:`http://127.0.0.1:${address.port}`,token};
  writeRecord(path.join(root,'bridge.json'),bridge);
  const record=sessionId=>{
    if(typeof sessionId!=='string'||!sessionId)return;
    const file=path.join(root,crypto.createHash('sha256').update(sessionId).digest('hex')+'.json');
    writeRecord(file,{...bridge,sessionId});
  };
  /* Previous implementation awaited session.list here, but CodeArts 26.9 does
     not serve SDK requests until plugin initialization has completed. */
  // [AI-added] 2026-09-14 20:28
  return {
    dispose:async()=>new Promise(resolve=>server.close(resolve)),
    event:async({event})=>{
      const p=event.properties||{};
      if(['session.created','session.updated'].includes(event.type)){if(p.info?.directory===directory)record(p.info.id);}
      else if(['session.idle','session.status','message.updated'].includes(event.type))record(p.sessionID||p.info?.sessionID);
    }
  };
};
