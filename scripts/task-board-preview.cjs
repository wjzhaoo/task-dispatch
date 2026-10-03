// Read-only visual fixture for the real console assets; no dispatcher or host connections.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const task=(id,title,state,dependsOn=[],stageId='login',extra={})=>({id,title,state,dependsOn,stageId,roundId:'login-r1',workerId:'mimo',attempts:[],maxAttempts:30,...extra});
const project={id:'preview',workspace:'D:/preview/任务看板设计预览',startup:'started',connections:[],alerts:[],tasks:[
 task('L01','定义登录接口与会话契约','review_ready',[],'login',{stageHeld:true}),
 task('L02','实现账号密码登录','review_ready',['L01'],'login',{stageHeld:true}),
 task('L03','实现登录页和错误提示','review_ready',['L01'],'login',{stageHeld:true}),
 task('L04','接通登录态与退出流程','review_ready',['L02','L03'],'login',{stageHeld:true}),
 task('F01','补齐登录失败提示与过期会话处理','running',['L04'],'login',{roundId:'login-r2'}),
 task('S01','完成基础工程与路由','accepted',[],'base'),
 task('L05','回归登录和刷新恢复流程','blocked',['F01'],'login',{roundId:'login-r2',error:'等待测试环境恢复'}),
 task('D01','规划账户设置页','ready',[],undefined)
],reviewStages:{mode:'stage',rounds:[
 {id:'base-r1',stageId:'base',round:1,state:'completed',verdict:'pass',milestone:'基础工程',members:[{taskId:'S01'}],reviewTaskIds:['S01'],issues:[]},
 {id:'login-r1',stageId:'login',round:1,state:'completed',verdict:'needs_fix',milestone:'完整登录功能',members:['L01','L02','L03','L04'].map(taskId=>({taskId})),reviewTaskIds:['L01','L02','L03','L04'],issues:[{key:'stage:expired',message:'过期会话提示不完整'}]},
 {id:'login-r2',stageId:'login',round:2,state:'collecting',milestone:'完整登录功能',members:[{taskId:'F01'},{taskId:'L05'}],reviewTaskIds:['L01','L02','L03','L04','F01','L05'],issues:[]}
]}};
delete project.tasks.at(-1).stageId;
const snapshot={projects:[project],revision:1,cursor:0,instanceId:'preview',health:{status:'running',dispatch:{}},startedAt:new Date().toISOString(),observedAt:new Date().toISOString(),pid:process.pid,runtimeVersion:'1.0.0'};
const assets={'/catalog/':'index.html','/catalog/app.js':'app.js','/catalog/task-board.mjs':'task-board.mjs','/catalog/style.css':'style.css'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),file=assets[url.pathname];
 if(file){res.writeHead(200,{'Content-Type':/\.m?js$/.test(file)?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'../runtime/console-web',file)));return;}
 if(url.pathname.endsWith('/stream')){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: snapshot\ndata: '+JSON.stringify(snapshot)+'\n\n');return;}
 let data;
 if(url.pathname.endsWith('/session'))data={csrf:'preview'};
 else if(url.pathname.endsWith('/version'))data={runtimeVersion:'1.0.0'};
 else if(url.pathname.endsWith('/projects'))data={projects:[{key:'preview',projectId:'preview',workspace:project.workspace,online:true,taskCount:project.tasks.length}]};
 else if(url.pathname.endsWith('/overview'))data=snapshot;
 else if(url.pathname.endsWith('/events'))data={events:[],nextBefore:null};
 else if(url.pathname.endsWith('/ensure'))data={ok:true};
 else {res.writeHead(405);res.end('Read-only preview');return;}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/catalog/#/p/preview`));
process.once('SIGINT',()=>{server.closeAllConnections();server.close();});
