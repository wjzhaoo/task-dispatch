// Read-only visual fixture for the real console assets; no dispatcher or host connections.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const task=(id,title,state,dependsOn=[],stageId='login',extra={})=>({id,title,state,dependsOn,stageId,roundId:'login-r1',workerId:'mimo',currentWorkerId:'mimo',attempts:[],maxAttempts:30,...extra});
const project={id:'preview',title:'登录功能 · 教学演示',workspace:'D:/demo/登录功能',startup:'started',connections:[],alerts:[{taskId:'L05',message:'演示：回归测试环境暂不可用，恢复环境后继续。'}],tasks:[
 task('L01','实现会话过期与退出接口','review_ready',[],'login',{stageHeld:true}),
 task('L02','实现账号密码登录','review_ready',[],'login',{stageHeld:true}),
 task('L03','实现登录页和错误提示','review_ready',[],'login',{stageHeld:true}),
 task('L04','接通登录态与退出流程','review_ready',['L01','L02','L03'],'login',{stageHeld:true}),
 task('F01','补齐登录失败提示与过期会话处理','running',['L04'],'login',{roundId:'login-r2'}),
 task('S01','完成基础工程与路由','accepted',[],'base',{roundId:'base-r1'}),
 task('L05','回归登录和刷新恢复流程','blocked',['F01'],'login',{roundId:'login-r2',error:'等待测试环境恢复'}),
 task('D01','整理登录功能使用说明','ready',[],undefined,{roundId:undefined})
],reviewStages:{mode:'stage',rounds:[
 {id:'base-r1',stageId:'base',round:1,state:'completed',verdict:'pass',milestone:'基础工程',members:[{taskId:'S01'}],reviewTaskIds:['S01'],issues:[]},
 {id:'login-r1',stageId:'login',round:1,state:'completed',verdict:'needs_fix',milestone:'完整登录功能',members:['L01','L02','L03','L04'].map(taskId=>({taskId})),reviewTaskIds:['L01','L02','L03','L04'],issues:[{key:'stage:expired',message:'过期会话提示不完整'}]},
 {id:'login-r2',stageId:'login',round:2,state:'collecting',milestone:'完整登录功能',members:[{taskId:'F01'},{taskId:'L05'}],reviewTaskIds:['L01','L02','L03','L04','F01','L05'],issues:[]}
]}};
delete project.tasks.at(-1).stageId;
const observedAt=new Date().toISOString();
const runtimeVersion=fs.readFileSync(path.join(__dirname,'../VERSION'),'utf8').trim();
const members=[
 {role:'brain',binding:'brain',responsibilities:'拆解目标、安排阶段与完整功能终审',provider:'codex'},
 {role:'reviewer',binding:'reviewer',responsibilities:'逐项检查实现与证据，发现问题退回返修',provider:'qoder'},
 {role:'worker',binding:'worker:mimo',workerId:'mimo',capability:'general',responsibilities:'按任务范围完成实现、验证与修复',provider:'mimo'}
];
project.connections=members.map(member=>({
 id:member.binding,clientId:'demo-'+member.role,...member,communication:'recent',wakeEnabled:true,armed:true,
 active:member.role==='worker'?[{taskId:'F01',claimed:true}]:[],
 observation:{status:'idle',checkedAt:observedAt,source:'演示观测'},contact:{lastRequestAt:observedAt}
}));
project.team={managed:true,total:3,ready:3,canConfigure:false,members:members.map(member=>({
 ...member,connected:true,state:'ready',message:'已就绪'
}))};
project.activeGoalId='login-goal';
project.queue=['settings-goal'];
project.goals=[
 {id:'login-goal',title:'完成登录与会话恢复',state:'active',taskCount:8,completedTaskCount:1,
  objective:'支持账号密码登录、退出与刷新恢复；错误提示清晰；过期会话能安全回到登录页。'},
 {id:'settings-goal',title:'增加账户设置页',state:'queued',taskCount:0,completedTaskCount:0,
  objective:'支持修改昵称与头像，保存后刷新仍保留；沿用现有成员，在当前目标验收后开始。'}
];
for(const task of project.tasks)task.goalId=project.activeGoalId;
const setup={
 id:'setup',title:'游戏存档 · 教学演示',workspace:'D:/projects/my-game',startup:'waiting',
 connections:[],alerts:[],tasks:[],goals:[{
  id:'save-goal',title:'完成游戏存档功能',state:'draft',taskCount:0,completedTaskCount:0,
  objective:'支持手动保存与继续游戏；重启后恢复进度；存档损坏时给出提示；已有功能无回归。'
 }],queue:[],team:{managed:true,total:3,ready:0,canConfigure:true,members:members.map(member=>({
  ...member,provider:undefined,connected:false,state:'missing',message:'等待接入',
  ...(member.role==='worker'?{binding:'worker:default',workerId:'default'}:{})
 }))}
};
const projects=[project,setup];
const snapshot=p=>({projects:[p],revision:1,cursor:0,instanceId:'preview',health:{status:'running',dispatch:{}},startedAt:observedAt,observedAt,pid:process.pid,runtimeVersion});
const assets=Object.fromEntries(['index.html','app.js','task-board.mjs','project-setup.mjs','command-policy.mjs','style.css'].map(file=>['/catalog/'+(file==='index.html'?'':file),file]));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),file=assets[url.pathname];
 const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 // The SPA uses POST ensure to enter a project; this fixture only acknowledges it.
 if(req.method!=='GET'&&!(req.method==='POST'&&/^\/catalog\/api\/p\/(preview|setup)\/ensure$/.test(url.pathname))){json(405,{error:'只读教学演示：操作不会提交，请在正式控制台中执行。'});return;}
 if(file){res.writeHead(200,{'Content-Type':/\.m?js$/.test(file)?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'../runtime/console-web',file)));return;}
 const key=url.pathname.match(/^\/catalog\/api\/p\/([^/]+)\//)?.[1],selected=projects.find(p=>p.id===key);
 if(key&&!selected){json(404,{error:'演示项目不存在'});return;}
 if(selected&&url.pathname.endsWith('/stream')){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: snapshot\ndata: '+JSON.stringify(snapshot(selected))+'\n\n');return;}
 let data;
 if(url.pathname.endsWith('/session'))data={csrf:'preview'};
 else if(url.pathname.endsWith('/version'))data={runtimeVersion};
 else if(url.pathname.endsWith('/projects'))data={observedAt,projects:projects.map(p=>({key:p.id,projectId:p.id,title:p.title,workspace:p.workspace,online:true,workspaceExists:true,dataExists:true,serviceVersion:runtimeVersion,taskCount:p.tasks.length,activeTaskCount:p.tasks.filter(t=>!['accepted','resolved'].includes(t.state)).length}))};
 else if(selected&&url.pathname.endsWith('/overview'))data=snapshot(selected);
 else if(url.pathname.endsWith('/events'))data={events:[],nextBefore:null};
 else if(url.pathname.endsWith('/ensure'))data={ok:true};
 else {json(405,{error:'只读教学演示：操作不会提交，请在正式控制台中执行。'});return;}
 json(200,data);
});
server.listen(0,'127.0.0.1',()=>{
 const base=`http://127.0.0.1:${server.address().port}/catalog/`;
 console.log(`只读教学演示，不连接真实调度或模型。\n任务与队列：${base}#/p/preview\n成员接入：${base}#/p/setup\n创建目标：${base}`);
});
const close=()=>{server.closeAllConnections();server.close();};
process.once('SIGINT',close);
process.once('SIGTERM',close);
