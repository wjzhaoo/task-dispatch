// Local protocol fixture. No model, credentials or network.
const readline=require('node:readline');
const mode=process.argv[2], scenario=process.argv[3];
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>send({id:m.id,result});
 if(m.method==='initialize')return reply({userAgent:'fixture'});
 if(m.method==='thread/start'||m.method==='thread/resume')return reply({thread:{id:'s'}});
 if(m.method==='session/create'||m.method==='session/resume')return reply({session:{sessionId:'s'}});
 if(m.method==='session/subscribe')return reply({eventSeq:0,snapshot:{projection:{status:'idle'}}});
 if(m.method==='turn/interrupt')return reply({});
 if(m.method==='turn/start'||m.method==='session/send'){
  reply(mode==='codex'?{turn:{id:'t'}}:{accepted:true});
  if(scenario==='disconnect')return process.exit(0);
  if(scenario==='permission')return send({id:500,method:'permission/request',params:{}});
  if(mode==='codex'){
   send({method:'item/completed',params:{threadId:'s',turnId:'wrong',item:{type:'agentMessage',text:'wrong'}}});
   send({method:'item/completed',params:{threadId:'s',turnId:'t',item:{type:'agentMessage',text:'final'}}});
   send({method:'turn/completed',params:{threadId:'s',turn:{id:'t',status:'completed'}}});
  }else{
   const event=(seq,type,payload)=>send({method:'session/event',params:{sessionId:'s',seq,type,payload}});
   event(1,'turn.started',{inputSource:scenario==='background'?'background_task':'user'});
   event(2,'model.streaming',{kind:'text_delta',delta:'final'});
   event(2,'model.streaming',{kind:'text_delta',delta:'duplicate'});
   event(3,'turn.completed',{resultType:'success'});
  }
 }
});
