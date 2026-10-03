// [AI-added] 2026-09-19 00:45: Deprecated. Replaced by the unified frontend in runtime/console-web/ (single-port gateway console). Kept for reference only; do not wire into new code.
// [AI-added] 2026-09-16: Text-only rendering; authenticated same-origin monitoring and controls.
// [AI-added] 2026-09-16 21:07: Theme persistence + service status strip (PID / uptime).
const $ = id => document.getElementById(id);
let snapshot, projectId = '', selected, csrf, stream, events = [], nextBefore, paused = false, pending = 0, cleanupPreview, connected = false, commandSnapshot, pendingCommand;
// [AI-added] 2026-09-17 18:54: Add claim-stall and reminder labels to the live console.
const labels = { brain:'大脑',worker:'执行员',reviewer:'初审端',ready:'待执行',running:'执行中',review_ready:'待审核',reviewing:'审核中',accepted:'已通过',resolved:'已由后续任务解决',blocked:'阻塞',uncertain:'需核实',settled:'已结算',claimed:'已领取',prepared:'已派发',pending:'等待重试',sent:'已送达',sending:'发送中',armed:'已获待命授权',not_parked:'未 park',unconfigured:'未配置',unknown:'未知',recent:'最近有通信',unreachable:'不可达',idle:'空闲',active:'活动',busy:'忙碌',listening:'监听有效',ended:'会话结束',paused:'已暂停',completed:'已完成',waiting:'等待启动',started:'已启动',wait:'阻塞等待',claim_stalled:'领取停滞',wake_reminder_requested:'再次提醒',service_started:'服务启动',service_stopping:'服务停止',desktop_request:'端请求',connection_state:'连接变化',task_state:'任务变化',attempt_state:'执行阶段',wake_state:'唤醒变化',host_observation:'宿主观测',operator_started:'管理操作开始',operator_completed:'管理操作结果',project_state:'项目变化',desktop_attached:'端已绑定',desktop_detached:'端已解绑',attempt_prepared:'任务已派发',worker_submitted:'执行员已提交',review_decision:'审核结果',task_resolved:'任务已由替代任务解决',task_revised:'任务契约已修订',planning_state:'收尾状态',project_registered:'项目登记',task_created:'任务登记',work_started:'开始协作',rebind_invitation_created:'改绑邀请已创建',rebind_invitation_claimed:'改绑邀请已领取',rebind_invitation_completed:'改绑邀请已完成',rebind_invitation_cancelled:'改绑邀请已取消',rebind_invitation_expired:'改绑邀请已过期' };
const label = x => labels[x] || x || '—';
// [AI-added] 2026-09-21 09:38: The compatibility console shares terminal-task semantics with the unified console.
const terminalTask = task => ['accepted', 'resolved'].includes(task?.state);
const time = x => x ? new Date(x).toLocaleTimeString('zh-CN',{hour12:false}) : '未观测';
const fullTime = x => x ? new Date(x).toLocaleString('zh-CN',{hour12:false}) : '未观测';
const name = p => p.workspace.split(/[\\/]/).filter(Boolean).at(-1) || p.id;
function node(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function badge(text, kind = '') { return node('span', text, 'pill ' + kind); }
function banner(text) { $('banner').hidden = !text; $('banner').textContent = text || ''; }
// [AI-added] 2026-09-16 21:07: Light/dark theme with localStorage preference.
function systemTheme() { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('td-theme', next); } catch { /* private mode */ }
  const btn = $('theme-toggle');
  if (btn) { btn.textContent = next === 'dark' ? '日间' : '夜间'; btn.title = next === 'dark' ? '切换到日间模式' : '切换到夜间模式'; }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('td-theme'); } catch { /* ignore */ }
  applyTheme(saved || systemTheme());
  $('theme-toggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', e => {
    let current = null;
    try { current = localStorage.getItem('td-theme'); } catch { /* ignore */ }
    if (!current) applyTheme(e.matches ? 'dark' : 'light');
  });
}
// [AI-added] 2026-09-16 21:07: Always-visible service process status (PID / version / uptime).
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}
function renderServiceStatus() {
  const strip = $('service-status');
  if (!strip) return;
  strip.classList.remove('is-running', 'is-stopping', 'is-down');
  if (!snapshot) {
    $('svc-status').textContent = '正在连接服务…';
    $('svc-meta').textContent = '等待本地调度服务返回快照';
    $('svc-pid').textContent = '—';
    $('svc-version').textContent = '—';
    $('svc-uptime').textContent = '—';
    $('svc-started').textContent = '—';
    return;
  }
  const health = snapshot.health?.status || 'unknown';
  const pidText = snapshot.pid != null ? String(snapshot.pid) : '未上报';
  const streamNote = connected ? '' : ' · 实时同步已断开';
  $('svc-pid').textContent = pidText;
  $('svc-version').textContent = snapshot.runtimeVersion || '—';
  const started = snapshot.startedAt ? Date.parse(snapshot.startedAt) : NaN;
  $('svc-uptime').textContent = Number.isFinite(started) ? formatUptime(Date.now() - started) : '—';
  $('svc-started').textContent = snapshot.startedAt ? fullTime(snapshot.startedAt) : '—';
  if (health === 'stopping') {
    strip.classList.add('is-stopping');
    $('svc-status').textContent = '服务停止中';
    $('svc-meta').textContent = `进程 PID ${pidText} · 管理台连接即将断开${streamNote}`;
    return;
  }
  if (health === 'running') {
    strip.classList.add(connected ? 'is-running' : 'is-stopping');
    $('svc-status').textContent = connected ? '服务运行中' : '服务运行中（同步中断）';
    $('svc-meta').textContent = (snapshot.health?.dispatch?.reason
      ? `进程 PID ${pidText} · 调度：${snapshot.health.dispatch.reason}`
      : `进程 PID ${pidText} · 实例 ${String(snapshot.instanceId || '').slice(0, 8)} · 快照 ${time(snapshot.observedAt)}`) + streamNote;
    return;
  }
  strip.classList.add('is-down');
  $('svc-status').textContent = `服务状态：${label(health)}`;
  $('svc-meta').textContent = `进程 PID ${pidText} · 未能识别运行状态，请查看事件流${streamNote}`;
}
async function api(path, options) {
  const r = await fetch('/admin/api/' + path, { ...options, headers: { 'Content-Type':'application/json', ...(options?.method === 'POST' ? {'X-CSRF-Token':csrf} : {}), ...options?.headers } });
  const value = await r.json(); if (!r.ok) { const e = Error(value.error || '请求失败'); e.definitive = true; throw e; } return value;
}
function visibleProjects() { return snapshot.projects.filter(p => !p.archivedAt || $('show-archived').checked); }
function currentProjects() { return visibleProjects().filter(p => !projectId || p.id === projectId); }
function live(ok) { connected = ok; $('live').textContent = ok ? '● 实时同步' : '○ 连接中断 · 数据已过期'; $('live').className = 'pill ' + (ok ? '' : 'warning'); renderServiceStatus(); }
function render() {
  if (!snapshot) return;
  if (projectId && !visibleProjects().some(p => p.id === projectId)) { projectId = ''; selected = null; }
  const projects = currentProjects(), connections = projects.flatMap(p => p.connections), tasks = projects.flatMap(p => p.tasks), alerts = projects.flatMap(p => p.alerts);
  // Previous implementation: renderEvidenceSummary(projects);
  // [AI-added] 2026-09-24 11:01: Keep the direct console consistent with the unified view.
  renderEvidenceSummaryV2(projects);
  fillOptions('mobile-project',[['','所有项目'],...visibleProjects().map(p=>[p.id,name(p)])],projectId);
  $('page-title').textContent = projectId ? name(projects[0] || {workspace:projectId,id:projectId}) : '全局总览';
  $('page-subtitle').textContent = projectId ? (projects[0]?.workspace || '项目不可用') + (projects[0]?.readOnly ? ' · 跨服务只读汇总' : '') : '汇总公共缓存与各项目缓存中的任务记录。';
  $('projects').replaceChildren(...visibleProjects().map(p => { const b=node('button', name(p)+(p.archivedAt?'（已归档）':'')+(p.readOnly?' · 汇总':''), 'nav' + (projectId === p.id ? ' active' : '')); b.append(node('small',`${p.connections.length} 个端 · ${p.tasks.length} 项任务 · ${p.service?.kind==='public'?'公共缓存':p.service?.kind==='project'?'项目缓存':'自定义缓存'}${p.service?.online?'':'（离线）'}`)); b.onclick=()=>selectProject(p.id); return b; }));
  $('all-projects').className='nav'+(!projectId?' active':'');
  const counts = [['项目',projects.length,'已登记'],['已绑定端',connections.length,`${connections.filter(c=>c.communication==='recent').length} 个最近有通信`],['在途任务',tasks.filter(t=>['running','reviewing'].includes(t.state)).length,'执行与审核'],['需要关注',alerts.length,'可查看证据']];
  $('stats').replaceChildren(...counts.map(([title,count,hint],i)=>{const e=node('div',undefined,'stat'+(i===1?' accent':''));e.append(node('div',title,'label'));const v=node('div',String(count),'value');v.append(node('small',hint));e.append(v);return e;}));
  $('observed').textContent='更新于 '+time(snapshot.observedAt)+(connections.length>12?' · 图示前 12 个端，完整连接见表':''); $('revision').textContent=`revision ${snapshot.revision} · 事件 ${snapshot.cursor}`;
  // [AI-added] 2026-09-17 18:45: Give the reviewer its own middle stage instead of stacking it with workers.
  const brainNodes=node('div',undefined,'node-group'),reviewerNodes=node('div',undefined,'node-group'),workerNodes=node('div',undefined,'node-group');
  for(const c of connections.slice(0,12)){const e=node('button',`${c.provider.toUpperCase()} · ${label(c.role)}`,'node');e.append(node('small',c.active.length?`${c.active.length} 个在途阶段`:c.armed?'等待交接':'已绑定'));e.onclick=()=>selectConnection(c.id);(c.role==='brain'?brainNodes:c.role==='reviewer'?reviewerNodes:workerNodes).append(e);}
  if(!brainNodes.childNodes.length)brainNodes.append(node('div','大脑待接入','node'));if(!reviewerNodes.childNodes.length)reviewerNodes.append(node('div','初审端待接入','node'));if(!workerNodes.childNodes.length)workerNodes.append(node('div','执行员待接入','node'));
  const service=node('div','调度服务','node service');service.append(node('small','事件 · 队列 · 交接'));
  $('topology').replaceChildren(brainNodes,node('span','⇄','arrow'),reviewerNodes,node('span','⇄','arrow'),service,node('span','⇄','arrow'),workerNodes);
  $('connections').replaceChildren(...projects.flatMap(p=>p.connections.map(c=>{
    const tr=node('tr',undefined,selected?.id===c.id?'selected':'');const title=node('td',`${c.provider.toUpperCase()} / ${label(c.role)}`);title.append(node('small',`${name(p)} · ${c.workerId || c.binding}`));
    const communication=node('td');communication.append(badge(label(c.communication),c.communication==='unknown'?'muted':''));
    const wakeText=!c.wakeEnabled?'未配置唤醒':!c.armed?'未 park':c.observationStale?'已获待命授权 · 实时观测过期':c.observation?.status==='unreachable'?'已获待命授权 · 通道不可达':c.provider==='qoder'?'已获待命授权 · 桥接可达':'已获待命授权';
    const wake=node('td');wake.append(badge(wakeText,!c.armed||c.observation?.status==='unreachable'?'muted':''));
    const state=node('td',c.active.map(a=>`${a.taskId} · ${a.claimed?'已领取':'待领取'}`).join('，')||'暂无在途任务');
    const observed=node('td',time(c.observation?.checkedAt || c.contact?.lastRequestAt));observed.append(node('small',c.observation?.source || '客户端请求'));
    tr.append(title,communication,wake,state,observed);tr.onclick=()=>selectConnection(c.id);return tr;
  })));
  $('empty-connections').hidden=!!connections.length;$('task-count').textContent=`${tasks.length} 项任务`;
  // [AI-added] 2026-09-17 18:45: Put state-appropriate recovery entry points next to the affected task.
  $('tasks').replaceChildren(...projects.flatMap(p=>p.tasks.filter(t=>$('task-filter').value==='all'||!terminalTask(t)).map(t=>{const e=node('div',undefined,'task');const title=node('div',undefined,'task-title');title.append(node('strong',t.title),node('small',`${name(p)} / ${t.id} · ${t.attempts.length}/${t.maxAttempts} 次尝试`));e.append(node('div',terminalTask(t)?'✓':'↗','task-icon'),title,badge((t.stageHeld?'初审通过，等待阶段终审':label(t.state)),['blocked','uncertain'].includes(t.state)?'error':['ready','resolved'].includes(t.state)?'muted':''));if(!p.readOnly){const actions=node('div',undefined,'task-actions'),add=(text,action)=>{const b=node('button',text);b.type='button';b.onclick=event=>{event.stopPropagation();openCommand(action,p.id,t.id);};actions.append(b);};const last=t.attempts.at(-1);if(['blocked','uncertain'].includes(t.state))add('重试','retry');if(t.budgetExhausted)add('追加额度','task-budget');if(t.waitingForWorker||t.state==='blocked')add('改派','assign');if(last&&!last.settled&&!last.claimedBy&&(last.wakeNotice.status==='sent'||last.wakeNotice.claimStatus==='stalled'))add('再次提醒','wake-remind');if(actions.childNodes.length)e.append(actions);}e.onclick=()=>selectTask(p.id,t.id);return e;})));
  if(!$('tasks').childNodes.length)$('tasks').append(node('div',tasks.length?'当前没有未完成任务，可切换查看所有任务。':'还没有任务。大脑登记任务后，这里会呈现各阶段。','empty'));
  $('alert-count').textContent=String(alerts.length);$('alerts').replaceChildren(...projects.flatMap(p=>p.alerts.slice(0,15).map(a=>{const e=node('div',a.message,'alert');e.append(node('small',`${name(p)}${a.taskId?' / '+a.taskId:''}${a.binding?' / '+a.binding:''}`));e.onclick=()=>{if(a.taskId)selectTask(p.id,a.taskId);else if(a.binding)selectConnection(p.connections.find(c=>c.binding===a.binding)?.id);else selectProject(p.id);};return e;})));
  if(!alerts.length)$('alerts').append(node('div','当前没有待处理异常','empty'));
  renderQuickControls(projects);renderDetail(); renderHealth(); renderServiceStatus();
}
// [AI-added] 2026-09-17 18:45: Keep routine project controls on the selected project's home page.
function renderQuickControls(projects){const panel=$('quick-controls'),actions=$('quick-project-actions'),p=projectId?projects[0]:null;panel.hidden=!p||p.readOnly;if(panel.hidden){actions.replaceChildren();return;}const values=[];const add=(text,action,kind='')=>{const b=node('button',text,kind);b.type='button';b.onclick=()=>openCommand(action,p.id);values.push(b);};if(p.completedAt)add('重新开启项目','reopen-project');else if(p.paused)add('继续项目','resume','primary');else add('暂停项目','pause');if(!p.completedAt&&p.tasks.length&&p.tasks.every(terminalTask))add('结束项目','finish-project','primary');add('高级后台控制',null);values.at(-1).onclick=()=>openCommand();actions.replaceChildren(...values);panel.hidden=false;}
function renderHealth(){banner(snapshot?.health.dispatch?.reason || (snapshot?.health.error?'观测提示：'+snapshot.health.error:snapshot?.health.wakeError?'唤醒错误：'+snapshot.health.wakeError:''));}
function detailRows(entries){const dl=node('dl');for(const [k,v]of entries){dl.append(node('dt',k),node('dd',String(v??'未观测')));}return dl;}
function renderDetail(){
  if(!selected){
    const p=projectId?snapshot.projects.find(p=>p.id===projectId):null;
    if(p){
      $('detail-title').textContent=name(p)+' · 项目详情';$('detail').replaceChildren(detailRows([['工作目录',p.workspace],['服务数据目录',p.service?.dataRoot],['目录类型',p.service?.kind==='public'?'公共缓存':p.service?.kind==='project'?'项目缓存':'自定义缓存'],['服务状态',p.service?.online?'运行中':'未运行（最后保存状态）'],['操作范围',p.readOnly?'由该项目自己的服务执行管理操作。':'当前服务可直接操作']]));
      // [AI-added] 2026-09-17 13:54
      if(p.readOnly){const open=node('button','打开并管理此项目','primary');open.type='button';open.onclick=async()=>{open.disabled=true;try{const result=await api('open-project',{method:'POST',body:JSON.stringify({projectId:p.id})});location.href=result.url;}catch(error){banner(error.message);open.disabled=false;}};$('detail').append(open);}
      return;
    }
    $('detail-title').textContent='服务详情';$('detail').replaceChildren(detailRows([['调度状态',snapshot.health.dispatch?.reason||'可调度'],['已发现服务目录',snapshot.services?.length||1],['汇总项目',snapshot.projects.length],['运行版本',snapshot.runtimeVersion],['进程 PID',snapshot.pid],['服务启动',fullTime(snapshot.startedAt)],['服务实例',snapshot.instanceId],['事件保留',`${snapshot.health.retention.maxFiles} 段 × ${snapshot.health.retention.maxBytes/1024/1024} MiB`],['实时说明','当前服务每 2 秒更新；其他服务目录读取最后持久化状态。']]));return;}
  const p=snapshot.projects.find(p=>p.id===selected.projectId);if(!p)return;
  if(selected.kind==='connection'){
    const c=p.connections.find(c=>c.id===selected.id);if(!c){$('detail').replaceChildren(node('p','该绑定已移除或被新会话替换。'));return;}
    $('detail-title').textContent=`${c.provider.toUpperCase()} · ${label(c.role)}`;
    // [AI-added] 2026-09-17 11:46
    const o=c.observation;$('detail').replaceChildren(detailRows([['绑定代次',c.clientId],['会话',c.sessionId||'未提供'],['最近请求',c.contact?`${fullTime(c.contact.lastRequestAt)} / ${c.contact.action}`:'未观测'],['改绑邀请',c.rebindInvitation?`${c.rebindInvitation.id} / ${c.rebindInvitation.status} / ${fullTime(c.rebindInvitation.expiresAt)}`:'无'],['待命授权',c.wakeEnabled?c.armed?'有效（允许下一项任务唤醒）':'未 park':'未配置'],['授权时间',c.armed?fullTime(c.armedAt):'—'],['实时宿主状态',`${label(o?.status)}${c.observationStale?'（观测过期）':''}`],['证据来源',o?.source],['观测时间',fullTime(o?.checkedAt)],['最近错误',c.continuationError||o?.error||'无']]));
    if(c.provider==='qoder')$('detail').append(node('h3','Qoder 直接桥接'),detailRows([['桥接状态',o?.status==='unreachable'?'不可达':o?.checkedAt?'可达':'未观测'],['会话状态',label(o?.status)],['最近探测',fullTime(o?.checkedAt)],['说明','任务由 App Plugin 直接续接原会话；送达后仍需检查任务是否 claim。']]));
  }else{
    const t=p.tasks.find(t=>t.id===selected.id);if(!t)return;$('detail-title').textContent=t.id+' · '+(t.stageHeld?'初审通过，等待阶段终审':label(t.state));$('detail').replaceChildren(detailRows([['任务',t.title],['契约版本',t.contractRevision||1],['依赖',t.dependsOn.join('、')||'无'],['替代目标',(t.supersedes||[]).join('、')||'无'],['解决依据',t.resolution?`${t.resolution.replacementTaskId}：${t.resolution.reason}`:'无'],['大脑处置',t.attention&&!t.attention.acknowledged?'待大脑领取并处理':['blocked','uncertain'].includes(t.state)?'通知已确认，任务仍需正式处置':'无'],['当前错误',t.error||'无']]));
    for(const a of t.attempts){$('detail').append(node('h3',`${label(a.role)} · ${a.provider||'未知平台'}`));const timeline=node('div',undefined,'timeline');for(const [title,at]of [['已派发',a.startedAt],[`通知：${label(a.wakeNotice.status)}`,a.wakeNotice.at],['已领取',a.claimedAt],[a.progress.stage?`${label(a.progress.stage)} · ${a.progress.summary}`:'暂无进度上报',a.progress.at],[a.settled?'已结算':'等待下一步',null]]){const step=node('div',title,'step');step.append(node('small',at?fullTime(at):'—'));timeline.append(step);}$('detail').append(timeline);const u=a.usage,usageText=u?`输入 ${u.inputTokens??'未知'}（缓存 ${u.cachedInputTokens??'未知'}），输出 ${u.outputTokens??'未知'}（推理 ${u.reasoningOutputTokens??'未知'}）`:`未统计：${a.usageStatus?.message||'原因未知'}`;$('detail').append(detailRows([['消耗状态',u?(a.usageStatus?.status==='measured'?'完整计量':'时间窗口计量'):'不可用'],['Token',usageText],['模型',u?.model||a.model||'未知'],['来源',u?.source||a.usageStatus?.reason||'未知']]));}
  }
}
function selectProject(id){projectId=id;selected=null;render();loadEvents();}
function selectConnection(id){for(const p of snapshot.projects){const c=p.connections.find(c=>c.id===id);if(c){selected={kind:'connection',id,projectId:p.id,binding:c.binding};render();loadEvents();return;}}}
function selectTask(pid,id){selected={kind:'task',id,projectId:pid};render();loadEvents();}
function params(){const q=new URLSearchParams({limit:'100'});if(selected?.projectId||projectId)q.set('projectId',selected?.projectId||projectId);if(selected?.kind==='task')q.set('taskId',selected.id);if(selected?.kind==='connection')q.set('binding',selected.binding);for(const [id,key]of [['search','q'],['provider','provider'],['level','level']])if($(id).value)q.set(key,$(id).value);return q;}
function matches(e){const q=params();return ['projectId','taskId','binding','provider','level'].every(k=>!q.get(k)||e[k]===q.get(k))&&(!q.get('q')||JSON.stringify(e).toLowerCase().includes(q.get('q').toLowerCase()));}
function renderEvents(){ $('events').replaceChildren(...events.filter(matches).slice(0,600).map(e=>{const row=node('div',undefined,'event '+e.level);const content=node('div');content.append(node('strong',`${label(e.type)}${e.action?' / '+e.action:''}${e.status?' · '+label(e.status):''}`),node('p',e.error||e.summary||[e.projectId,e.taskId,e.binding].filter(Boolean).join(' / ')),node('code',`${e.attemptId?e.attemptId.slice(0,12)+' · ':''}#${e.sequence}${e.durationMs!==undefined?' · '+e.durationMs+' ms':''}`));row.append(node('time',time(e.at)),node('span',undefined,'dot'),content);return row;}));if(!events.length)$('events').append(node('div','当前筛选没有事件','empty'));$('event-scope').textContent=selected?`筛选：${selected.kind==='task'?'任务':'连接'} ${selected.kind==='task'?selected.id:selected.binding}`:projectId?'当前项目事件':'所有项目事件';$('older').disabled=!nextBefore;}
async function loadEvents(older=false){try{const q=params();if(older&&nextBefore)q.set('before',nextBefore);const result=await api('events?'+q);events=older?[...events,...result.events]:result.events;nextBefore=result.nextBefore;renderEvents();}catch(e){banner(e.message);}}
async function refresh(){snapshot=await api('overview');connected=true;render();}
function subscribe(){if(stream)stream.close();stream=new EventSource(`/admin/api/stream?cursor=${snapshot.cursor}&instanceId=${encodeURIComponent(snapshot.instanceId)}`);stream.onopen=()=>{live(true);renderHealth();};stream.onerror=()=>{live(false);banner('与服务的实时连接已断开，当前显示最后快照。服务停止后请重新运行本地启动器。');};stream.addEventListener('snapshot',e=>{snapshot=JSON.parse(e.data);live(true);render();});stream.addEventListener('reset',()=>{loadEvents();});stream.addEventListener('event',e=>{const v=JSON.parse(e.data);if(!events.some(x=>x.sequence===v.sequence)){events.unshift(v);events=events.slice(0,600);}if(paused){pending++;$('pause-events').textContent=`恢复实时（${pending}）`;}else renderEvents();});}
function fillOptions(id,values,value){$(id).replaceChildren(...values.map(([v,t])=>{const e=node('option',t);e.value=v;return e;}));if(value)$(id).value=value;}
function commandTargets(){const p=commandSnapshot.projects.find(p=>p.id===$('command-project').value&&!p.readOnly);fillOptions('command-task',(p?.tasks||[]).map(t=>[t.id,t.id+' · '+t.title]),selected?.kind==='task'?selected.id:null);fillOptions('command-binding',(p?.connections||[]).map(c=>[c.binding,c.provider+' / '+label(c.role)+' / '+c.binding]),selected?.binding);}
// [AI-added] 2026-09-17 11:46
// [AI-added] 2026-09-17 18:54: Explain the explicit reminder recovery boundary before confirmation.
function impact(){const action=$('action').value;const descriptions={pause:'暂停只阻止后续调度，当前回合继续。',resume:'继续项目调度，可能立即派发已排队任务。',retry:'重试会重新排队；uncertain 状态必须先核实旧执行进程停止。','rebind-invite':'生成 30 分钟一次性提示词；不勾选停止确认时安全等待旧端结算，勾选后会转移合法的在途所有权。','rebind-cancel':'取消尚未完成的改绑邀请，不改变当前绑定。',detach:'解绑可能终止审核所有权；在途执行受服务保护，不能强制移除。',stop:'停止整个服务，所有管理台连接断开；执行中任务可能需要核实。重启需运行本地启动器。','cleanup-apply':'仅执行最近清理预览中的目录清理，请先核对预览结果。','wake-retry':'仅加速检查明确可重试的 pending 通知；不重发 sent 或 uncertain 通知。','wake-remind':'为当前未领取 attempt 补充一次待命授权并发送独立提醒；必须填写原因，送达不确定时禁止执行。','finish-project':'仅允许结束所有任务已通过或由已通过替代任务解决的项目，等待端将退出。'};$('impact').textContent=descriptions[action]||'操作会记录目标、原因与结果。状态变化后服务会拒绝旧操作。';}
$('command-project').onchange=commandTargets;$('action').onchange=()=>{impact();commandFields();};
// [AI-added] 2026-09-17 11:46
// [AI-added] 2026-09-17 18:54: Show task targeting for manual reminder recovery.
function commandFields(){const a=$('action').value;const visible={ 'command-project':!['cleanup-preview','cleanup-apply','stop'].includes(a),'command-task':['retry','task-budget','assign','wake-retry','wake-remind'].includes(a),'command-binding':['detach','rebind-invite'].includes(a),'invitation-id':a==='rebind-cancel','worker-id':a==='assign',additional:a==='task-budget','confirmed-stopped':['retry','rebind-invite'].includes(a),'restart-worker':a==='retry'};for(const[id,show]of Object.entries(visible))$(id).closest('label').hidden=!show;}
// [AI-added] 2026-09-17 18:45: Home-page actions reuse the guarded command dialog and receipt protocol.
function openCommand(actionValue,targetProjectId,targetTaskId){if(!snapshot)return;if(pendingCommand){$('command-dialog').showModal();return;}commandSnapshot=structuredClone(snapshot);const writable=commandSnapshot.projects.filter(p=>!p.readOnly),target=targetProjectId||selected?.projectId||projectId;if(actionValue&&[...$('action').options].some(o=>o.value===actionValue))$('action').value=actionValue;else $('action').selectedIndex=0;fillOptions('command-project',writable.map(p=>[p.id,name(p)]),writable.some(p=>p.id===target)?target:writable[0]?.id);commandTargets();if(targetTaskId)$('command-task').value=targetTaskId;impact();commandFields();$('confirm-impact').checked=false;$('command-result').textContent=writable.length?'':'当前服务没有可操作项目；汇总自其他项目缓存的记录为只读。';$('command-dialog').showModal();}
$('controls').onclick=()=>openCommand();
$('close-dialog').onclick=()=>$('command-dialog').close();
// [AI-added] 2026-09-17 11:46
$('command-form').onsubmit=async e=>{e.preventDefault();const action=$('action').value,p=commandSnapshot.projects.find(p=>p.id===$('command-project').value),t=p?.tasks.find(t=>t.id===$('command-task').value),c=p?.connections.find(c=>c.binding===$('command-binding').value);const command=pendingCommand||{commandId:crypto.randomUUID(),instanceId:commandSnapshot.instanceId,revision:commandSnapshot.revision,action,projectId:p?.id,taskId:t?.id,binding:c?.binding,clientId:c?.clientId,invitationId:$('invitation-id').value,attemptId:t?.attempts.at(-1)?.id,workerId:$('worker-id').value,additionalAttempts:Number($('additional').value),reason:$('reason').value,confirmed:$('confirm-impact').checked,confirmedStopped:$('confirmed-stopped').checked,restartWorker:$('restart-worker').checked,previewId:cleanupPreview};pendingCommand=command;$('execute').disabled=true;try{const result=await api('commands',{method:'POST',body:JSON.stringify(command)});pendingCommand=null;if(command.action==='cleanup-preview')cleanupPreview=result.previewId;$('command-result').textContent=JSON.stringify(result,null,2);$('confirm-impact').checked=false;if(command.action!=='stop'){await refresh();commandSnapshot=structuredClone(snapshot);commandTargets();}}catch(error){if(error.definitive)pendingCommand=null;$('command-result').textContent=error.message+(pendingCommand?'\n结果尚未确认，再次点击将查询同一命令，不会重复执行。':'\n请关闭并重新打开控制面板，核对最新状态。');}finally{$('execute').disabled=false;}};
$('all-projects').onclick=()=>selectProject('');$('refresh').onclick=()=>refresh().catch(e=>banner(e.message));$('filter-events').onclick=()=>loadEvents();$('search').onkeydown=e=>{if(e.key==='Enter')loadEvents();};$('clear-filter').onclick=()=>{selected=null;render();loadEvents();};$('older').onclick=()=>loadEvents(true);$('pause-events').onclick=()=>{paused=!paused;pending=0;$('pause-events').textContent=paused?'恢复实时':'暂停滚动';if(!paused)renderEvents();};$('export').onclick=()=>{location.href='/admin/api/diagnostics?'+params();};
async function boot(){ initTheme(); $('endpoint').textContent=location.host;setInterval(() => { if (snapshot) renderServiceStatus(); }, 1000);try{const hash=new URLSearchParams(location.hash.slice(1));const ticket=hash.get('ticket');history.replaceState(null,'','/admin/');if(ticket){const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});const result=await r.json();if(!r.ok)throw Error(result.error);csrf=result.csrf;}else csrf=(await api('session')).csrf;await refresh();await loadEvents();subscribe();}catch(e){live(false);banner(e.message);}}
$('mobile-project').onchange=()=>selectProject($('mobile-project').value);
$('task-filter').onchange=()=>render();
// Lifecycle controls are initialized before loading the first snapshot.
const lifecycleActions = {'archive-project':'归档项目','restore-project':'恢复归档项目','delete-project':'永久删除项目','reset-task':'完全重置任务'};
for(const [value,text] of Object.entries(lifecycleActions)){const option=node('option',text);option.value=value;$('action').append(option);labels[value.replaceAll('-','_')]=text;}
const archiveLabel=node('label',undefined,'subtle');const archiveCheck=node('input');archiveCheck.type='checkbox';archiveCheck.id='show-archived';archiveLabel.append(archiveCheck,document.createTextNode(' 显示已归档项目'));$('stats').before(archiveLabel);archiveCheck.onchange=()=>{render();loadEvents();};
function inputLabel(id,text,type='text'){const label=node('label',text,type==='checkbox'?'check':'');const input=node('input');input.type=type;input.id=id;label.append(input);$('impact').before(label);return input;}
inputLabel('confirm-text','确认目标 ID（删除填项目 ID，重置填任务 ID）');
inputLabel('reset-dependents','同时重置全部下游任务','checkbox');
const previewButton=node('button','预览影响范围');previewButton.type='button';previewButton.id='lifecycle-preview';$('impact').before(previewButton);
const originalFields=commandFields;
commandFields=function(){originalFields();const a=$('action').value;const lifecycle=!!lifecycleActions[a];$('confirm-text').closest('label').hidden=!['delete-project','reset-task'].includes(a);$('reset-dependents').closest('label').hidden=a!=='reset-task';previewButton.hidden=!lifecycle;if(a==='reset-task')$('command-task').closest('label').hidden=false;if(['delete-project','reset-task'].includes(a))$('confirmed-stopped').closest('label').hidden=false;
if(lifecycle){const p=commandSnapshot.projects.find(p=>p.id===$('command-project').value);$('impact').textContent=`项目 ID：${p?.id||'—'}。`+({'archive-project':'默认隐藏并暂停项目，保留所有历史。','restore-project':'恢复后保持暂停，核对后再继续。','delete-project':'永久删除调度记录并撤销连接；保留审计、源工程及磁盘产物。','reset-task':'清空执行、审核、唤醒、产物关联和次数，额度恢复 30。保留任务定义、旧记录审计及源文件。项目会暂停；已有执行的下游任务必须级联重置。'}[a]);}};
$('command-project').onchange=()=>{commandTargets();commandFields();};
previewButton.onclick=async()=>{try{const result=await api('commands',{method:'POST',body:JSON.stringify({action:'lifecycle-preview',operation:$('action').value,commandId:crypto.randomUUID(),instanceId:commandSnapshot.instanceId,revision:commandSnapshot.revision,projectId:$('command-project').value,taskId:$('command-task').value})});$('command-result').textContent=JSON.stringify(result,null,2);}catch(e){$('command-result').textContent=e.message;}};
const originalSubmit=$('command-form').onsubmit;
$('command-form').onsubmit=async e=>{if(!pendingCommand&&lifecycleActions[$('action').value]){pendingCommand={commandId:crypto.randomUUID(),instanceId:commandSnapshot.instanceId,revision:commandSnapshot.revision,action:$('action').value,projectId:$('command-project').value,taskId:$('command-task').value,confirmText:$('confirm-text').value,resetDependents:$('reset-dependents').checked,confirmed:$('confirm-impact').checked,confirmedStopped:$('confirmed-stopped').checked,reason:$('reason').value};}await originalSubmit(e);};
boot();


// [AI-added] 2026-09-22 10:20: Historical workflow counts and unique observations remain distinct.
function renderEvidenceSummary(projects) {
  let box=$('evidence-summary');
  if(!box){box=node('section',undefined,'panel');box.id='evidence-summary';$('stats').after(box);}
  box.replaceChildren(node('h2','返工、用量与阶段轮次'));
  box.append(node('p','尝试数不等于模型调用数。未知用量不按零计算；上报量与时间窗观测不相加，尚不能计算费用节省。'));
  for(const p of projects){
    const u=p.usage,m=u?.workflow?.[0],c=u?.totals?.[0]?.coverage;
    box.append(node('h3',p.id));
    if(!m){box.append(node('p','尚无统计数据'));continue;}
    box.append(detailRows([['准备 / 领取 / 结算',m.prepared+' / '+m.claimed+' / '+m.settled],['累计业务返修 / 越界退回',m.businessRepairs+' / '+m.scopeReturns],['初审放行后终审退回',m.postPreReviewReturns+' / '+m.matchedCandidates+' 个有效候选（'+m.matchedTasks+' 项任务）'],['基础设施异常 / 恢复 / 未分类重试',m.infrastructureFailures+' / '+m.infrastructureRecoveries+' / '+m.unclassifiedRetries],['历史覆盖',m.historyComplete?'已有记录可配对；不包含未记录的沟通':'历史不完整，计数仅代表可查记录'],['去重观测输入 / 输出',(u.observedUniqueTokens?.inputTokens??'未知')+' / '+(u.observedUniqueTokens?.outputTokens??'未知')],['计量覆盖',c?c.records+' 条记录，'+c.unknown+' 条未知；冲突增量 '+c.conflictingEvents+'，窗口外增量 '+c.unallocatedEvents:'未知']]));
    for(const a of u.activityGroups||[])box.append(node('p',({'planning':'规划','troubleshooting':'排障','other':'其他'}[a.kind]||a.kind)+' · '+a.source+' · '+(a.endedAt?'已结束':'未结束')+' · 输入 '+(a.usage?.inputTokens??'未知')+' / 输出 '+(a.usage?.outputTokens??'未知')+' · '+a.observation.message));
    box.append(node('p','阶段集中终审'));
    for(const b of p.reviewStages?.rounds||[]){const states={collecting:'成员准备中',preparing:'复合候选验证中',ready:'等待大脑领取',reviewing:'大脑审核中',blocked:'需要处理',completed:'本轮已终审',cancelled:'已取消',reset:'已重置'};box.append(detailRows([['阶段轮次',b.stageId+' / '+b.id+' · '+b.milestone+' · '+({pass:'阶段通过',needs_fix:'待追加修复',blocked:'阶段未验收'}[b.verdict]||'执行中')+' · '+(states[b.state]||b.state)],['成员',b.members.map(m=>m.taskId+'：'+(m.held?'初审通过，等待阶段终审':label(m.state))).join('；')],['候选版本',b.compositeArtifactHash||'尚未冻结'],['阶段终审',b.attempt?b.attempt.id+' · '+(b.attempt.settled?'已结算':b.attempt.claimedAt?'已领取':'未领取'):'尚未准备'],['等待 / 异常',b.error||b.wakeNotice?.error||'无'],['分项结论',b.results?b.results.map(r=>r.taskId+'：'+({pass:'通过',needs_fix:'需修复',blocked:'阻塞'}[r.verdict]||r.verdict)).join('；'):'尚无结论']]));}
  }
}
// [AI-added] 2026-09-24 11:01: Native disclosure preserves details without filling the overview.
const evidenceOpenByProject = new Map();
function renderEvidenceSummaryV2(projects) {
  let box = $('evidence-summary');
  const key = projects.map(project => project.id).join('|') || 'empty';
  if (!box) {
    box = node('details', undefined, 'panel evidence-summary');
    box.id = 'evidence-summary';
    $('stats').after(box);
    box.addEventListener('toggle', () => evidenceOpenByProject.set(box.dataset.projectKey, box.open));
  } else if (box.dataset.projectKey !== key) {
    evidenceOpenByProject.set(box.dataset.projectKey, box.open);
  }
  if (box.dataset.projectKey !== key) box.open = evidenceOpenByProject.get(key) ?? false;
  box.dataset.projectKey = key;
  const metrics = projects.map(project => project.usage?.workflow?.[0]).filter(Boolean);
  const repairs = metrics.reduce((total, metric) => total + metric.businessRepairs, 0);
  const coverages = projects.map(project => project.usage?.totals?.[0]?.coverage);
  const unknown = coverages.every(Boolean) ? coverages.reduce((total, coverage) => total + coverage.unknown, 0) : null;
  const runningBatches = projects.flatMap(project => project.reviewStages?.rounds || []).filter(batch => !['completed', 'cancelled', 'reset'].includes(batch.state)).length;
  const quickText = !metrics.length ? '暂无统计数据' : `业务返修 ${repairs} · ${unknown === null ? '计量未观测' : '计量未知 ' + unknown + ' 条'} · 进行中阶段轮次 ${runningBatches}`;
  const summary = node('summary', undefined, 'evidence-toggle');
  summary.append(node('strong', '返工、用量与阶段轮次'), node('span', quickText, 'evidence-quick'), node('span', '查看明细', 'evidence-hint'));
  const body = node('div', undefined, 'evidence-body');
  body.append(node('p', '尝试数不等于模型调用数。未知用量不按零计算；上报量与时间窗观测不相加，尚不能计算费用节省。'));
  for (const project of projects) {
    const usage = project.usage, metric = usage?.workflow?.[0], coverage = usage?.totals?.[0]?.coverage;
    body.append(node('h3', project.id));
    if (!metric) { body.append(node('p', '尚无统计数据')); continue; }
    body.append(detailRows([['准备 / 领取 / 结算', metric.prepared + ' / ' + metric.claimed + ' / ' + metric.settled], ['累计业务返修 / 越界退回', metric.businessRepairs + ' / ' + metric.scopeReturns], ['初审放行后终审退回', metric.postPreReviewReturns + ' / ' + metric.matchedCandidates + ' 个有效候选（' + metric.matchedTasks + ' 项任务）'], ['基础设施异常 / 恢复 / 未分类重试', metric.infrastructureFailures + ' / ' + metric.infrastructureRecoveries + ' / ' + metric.unclassifiedRetries], ['历史覆盖', metric.historyComplete ? '已有记录可配对；不包含未记录的沟通' : '历史不完整，计数仅代表可查记录'], ['去重观测输入 / 输出', (usage.observedUniqueTokens?.inputTokens ?? '未知') + ' / ' + (usage.observedUniqueTokens?.outputTokens ?? '未知')], ['计量覆盖', coverage ? coverage.records + ' 条记录，' + coverage.unknown + ' 条未知；冲突增量 ' + coverage.conflictingEvents + '，窗口外增量 ' + coverage.unallocatedEvents : '未知']]));
    for (const activity of usage.activityGroups || []) body.append(node('p', ({ planning:'规划', troubleshooting:'排障', other:'其他' }[activity.kind] || activity.kind) + ' · ' + activity.source + ' · ' + (activity.endedAt ? '已结束' : '未结束') + ' · 输入 ' + (activity.usage?.inputTokens ?? '未知') + ' / 输出 ' + (activity.usage?.outputTokens ?? '未知') + ' · ' + activity.observation.message));
    body.append(node('p', '阶段集中终审'));
    for (const batch of project.reviewStages?.rounds || []) {
      const states = { collecting:'成员准备中', preparing:'复合候选验证中', ready:'等待大脑领取', reviewing:'大脑审核中', blocked:'需要处理', completed:'本轮已终审', cancelled:'已取消', reset:'已重置' };
      body.append(detailRows([['阶段轮次', batch.stageId + ' / ' + batch.id + ' · ' + batch.milestone + ' · ' + ({pass:'阶段通过',needs_fix:'待追加修复',blocked:'阶段未验收'}[batch.verdict]||'执行中') + ' · ' + (states[batch.state] || batch.state)], ['成员', batch.members.map(member => member.taskId + '：' + (member.held ? '初审通过，等待阶段终审' : label(member.state))).join('；')], ['候选版本', batch.compositeArtifactHash || '尚未冻结'], ['阶段终审', batch.attempt ? batch.attempt.id + ' · ' + (batch.attempt.settled ? '已结算' : batch.attempt.claimedAt ? '已领取' : '未领取') : '尚未准备'], ['等待 / 异常', batch.error || batch.wakeNotice?.error || '无'], ['待解决问题', (batch.issues || []).map(issue => issue.key + '：' + issue.message).join('；') || '无'], ['分项结论', batch.results ? batch.results.map(result => result.taskId + '：' + ({ pass:'通过', needs_fix:'需修复', blocked:'阻塞' }[result.verdict] || result.verdict)).join('；') : '尚无结论']]));
    }
  }
  box.replaceChildren(summary, body);
}
