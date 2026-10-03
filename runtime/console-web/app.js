import { boardMarkup, buildBoard, renderBoard, matchesTask } from './task-board.mjs';
// [AI-added] 2026-09-19 00:25: Unified single-port console SPA. Home view renders the system project catalog; project view talks to the owning service through the catalog gateway (/catalog/api/p/<key>/*). Text-only rendering; authenticated same-origin monitoring and controls.
const $ = id => document.getElementById(id);
let csrf = null, ctx = null, homeTimer = null, homeProjects = [];
const labels = { brain:'大脑',worker:'执行员',reviewer:'初审端',ready:'待执行',running:'执行中',review_ready:'待审核',reviewing:'审核中',accepted:'已通过',resolved:'已由后续任务解决',blocked:'阻塞',uncertain:'需核实',settled:'已结算',claimed:'已领取',prepared:'已派发',pending:'等待重试',sent:'已送达',sending:'发送中',armed:'已获待命授权',not_parked:'未 park',unconfigured:'未配置',unknown:'未知',recent:'最近有通信',unreachable:'不可达',idle:'空闲',active:'活动',busy:'忙碌',listening:'监听有效',ended:'会话结束',paused:'已暂停',completed:'已完成',waiting:'等待启动',started:'已启动',wait:'阻塞等待',claim_stalled:'领取停滞',wake_reminder_requested:'再次提醒',service_started:'服务启动',service_stopping:'服务停止',desktop_request:'端请求',connection_state:'连接变化',task_state:'任务变化',attempt_state:'执行阶段',wake_state:'唤醒变化',host_observation:'宿主观测',operator_started:'管理操作开始',operator_completed:'管理操作结果',project_state:'项目变化',desktop_attached:'端已绑定',desktop_detached:'端已解绑',attempt_prepared:'任务已派发',worker_submitted:'执行员已提交',review_decision:'审核结果',task_resolved:'任务已由替代任务解决',task_revised:'任务契约已修订',planning_state:'收尾状态',project_registered:'项目登记',task_created:'任务登记',work_started:'开始协作',rebind_invitation_created:'改绑邀请已创建',rebind_invitation_claimed:'改绑邀请已领取',rebind_invitation_completed:'改绑邀请已完成',rebind_invitation_cancelled:'改绑邀请已取消',rebind_invitation_expired:'改绑邀请已过期',archive_project:'归档项目',restore_project:'恢复归档项目',delete_project:'永久删除项目',reset_task:'完全重置任务' };
const label = x => labels[x] || x || '—';
// [AI-added] 2026-09-21 09:38: Resolved historical failures are terminal but remain distinct from accepted work.
const terminalTask = task => ['accepted', 'resolved'].includes(task?.state);
const time = x => x ? new Date(x).toLocaleTimeString('zh-CN', { hour12: false }) : '未观测';
const fullTime = x => x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '未观测';
const baseName = workspace => String(workspace || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
const name = p => baseName(p.workspace) || p.id || '未命名项目';
function node(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function badge(text, kind = '') { return node('span', text, 'badge ' + kind); }
function banner(text) { $('banner').hidden = !text; $('banner').textContent = text || ''; }
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}
// Theme persistence + light/dark switching.
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
// Catalog-level API (home view and session).
async function capi(path, options = {}) {
  const r = await fetch('/catalog/api/' + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.method === 'POST' ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } });
  const value = await r.json(); if (!r.ok) { const e = Error(value.error || '请求失败'); e.definitive = true; throw e; } return value;
}
// Project-level API through the gateway.
async function papi(path, options = {}) {
  const r = await fetch(`/catalog/api/p/${ctx.key}/` + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.method === 'POST' ? { 'X-CSRF-Token': csrf } : {}), ...options.headers } });
  const value = await r.json(); if (!r.ok) { const e = Error(value.error || '请求失败'); e.definitive = true; throw e; } return value;
}
// [AI-added] 2026-09-21 10:20: Keep the running console service version visible on every view.
let consoleVersion = null;
async function loadVersion() {
  const badge = $('build-version');
  try {
    const { runtimeVersion } = await capi('version');
    if (!runtimeVersion) return;
    consoleVersion = runtimeVersion;
    badge.textContent = `v${runtimeVersion}`;
    badge.title = `控制台服务版本 v${runtimeVersion}；项目控制台的「运行版本」是该服务自身的版本`;
    badge.hidden = false;
  } catch { /* An older console process has no version route. */ }
}
function live(ok) {
  const pill = $('live');
  if (!ctx) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.textContent = ok ? '● 实时同步' : '○ 连接中断 · 数据已过期';
  pill.className = 'pill ' + (ok ? '' : 'warning');
}
function teardownProject() {
  if (homeTimer) { clearInterval(homeTimer); homeTimer = null; }
  if (!ctx) return;
  if (ctx.stream) ctx.stream.close();
  if (ctx.tick) clearInterval(ctx.tick);
  const dialog = $('command-dialog');
  if (dialog.open) dialog.close();
  ctx = null;
}
// ---------- Home view ----------
function showHome() {
  teardownProject();
  homeSignature = null;
  $('live').hidden = true; $('export').hidden = true; $('controls').hidden = true;
  $('revision').textContent = '';
  $('view').replaceChildren();
  const head = node('div', undefined, 'home-head');
  const titleWrap = node('div');
  titleWrap.append(node('div', 'PROJECT CATALOG', 'eyebrow'), node('h1', '项目目录'), node('p', '系统缓存中的项目目录表；项目接入或任务变化后自动出现，每 2 秒刷新。'));
  head.append(titleWrap);
  const strip = node('section', undefined, 'summary-strip');
  for (const [id, labelText] of [['h-count', '已登记项目'], ['h-online', '服务运行中'], ['h-active', '未完成待办'], ['h-observed', '最近刷新']]) {
    const stat = node('div', undefined, 'stat');
    stat.append(node('div', labelText, 'label'));
    const value = node('div', '—', 'value'); value.id = id;
    stat.append(value); strip.append(stat);
  }
  const cards = node('section', undefined, 'cards'); cards.id = 'cards';
  // [AI-added] 2026-09-19: collapsed group for workspaces that no longer exist, with index cleanup.
  const invalid = node('details', undefined, 'invalid-home'); invalid.id = 'invalid-home'; invalid.hidden = true;
  invalid.innerHTML = '<summary><span class="invalid-title">无效项目（<span id="invalid-count">0</span>）</span><span class="subtle">工作目录已不存在，仅剩目录索引记录</span><button type="button" id="cleanup-open" class="danger">清理无效项目</button></summary><div id="invalid-cards" class="cards"></div>';
  const empty = node('section', undefined, 'empty-home'); empty.id = 'empty-home'; empty.hidden = true;
  empty.append(node('div', 'T', 'mark'), node('h2', '暂无项目'), node('p', '可以保持此页面打开。在项目会话中执行 start.bat connect 后，项目会自动出现在这里。'));
  $('view').append(head, strip, cards, invalid, empty);
  $('cleanup-open').onclick = e => { e.preventDefault(); e.stopPropagation(); openCleanup(); };
  loadHome();
  homeTimer = setInterval(() => loadHome().catch(() => {}), 2000);
}
let homeSignature = null;
async function loadHome() {
  if (homeBusy) return;
  try {
    const result = await capi('projects');
    const projects = result.projects;
    homeProjects = projects;
    $('h-count').textContent = String(projects.length);
    $('h-online').textContent = String(projects.filter(p => p.online).length);
    $('h-active').textContent = String(projects.reduce((sum, p) => sum + (p.activeTaskCount || 0), 0));
    $('h-observed').textContent = time(result.observedAt);
    // Rebuilding every card on each tick detaches buttons between the accessibility snapshot and
    // the click, so only a real change redraws the grid.
    const signature = JSON.stringify(projects);
    if (signature !== homeSignature) {
      homeSignature = signature;
      const dead = projects.filter(p => !p.workspaceExists);
      $('cards').replaceChildren(...projects.filter(p => p.workspaceExists).map(card));
      $('invalid-home').hidden = !dead.length;
      $('invalid-count').textContent = String(dead.length);
      $('invalid-cards').replaceChildren(...dead.map(card));
      $('empty-home').hidden = projects.length > 0;
    }
    banner('');
  } catch (e) { banner(e.message); }
}
// [AI-added] 2026-09-19: catalog-index cleanup for projects whose workspace disappeared.
// Entries whose service data still exists are reported by the server as kept, not removed.
function openCleanup() {
  const dead = homeProjects.filter(p => !p.workspaceExists), removable = dead.filter(p => !p.dataExists), kept = dead.filter(p => p.dataExists);
  if (!dead.length) return;
  const list = $('cleanup-list');
  list.replaceChildren(...removable.map(p => { const li = node('li'); li.append(node('code', p.workspace)); return li; }));
  if (kept.length) list.append(node('li', '另有 ' + kept.length + ' 个项目服务数据仍在，清理时将保留：' + kept.map(p => baseName(p.workspace) || p.projectId).join('、'), 'kept-note'));
  if (!removable.length) list.prepend(node('li', '这些项目的服务数据仍然存在，目录索引不做清理；请进入对应项目归档或删除。', 'kept-note'));
  $('cleanup-result').hidden = true; $('cleanup-result').textContent = '';
  $('cleanup-confirm').disabled = !removable.length;
  $('cleanup-dialog').showModal();
}
// [AI-added] 2026-09-21: Service lifecycle lives here because every project runs its own service
// process; stop and restart ask for a second click that surfaces the in-flight counts. The
// two-second catalog refresh must not rebuild a card while one of those confirmations is live.
let homeBusy = 0;
function serviceButton(project, action) {
  const labels = { start: '启动服务', stop: '停止服务', restart: '重启服务' };
  const button = node('button', labels[action], action === 'start' ? '' : 'danger');
  button.type = 'button';
  let armed = false, busy = false;
  const release = () => { if (busy) { busy = false; homeBusy--; } };
  const disarm = () => { armed = false; release(); button.textContent = labels[action]; };
  button.onclick = async event => {
    event.stopPropagation();
    if (action !== 'start' && !armed) {
      armed = true; busy = true; homeBusy++;
      button.textContent = `确认${labels[action]}？在途 ${project.inFlight || 0} · 未结算 ${project.unclaimed || 0}`;
      setTimeout(disarm, 8000);
      return;
    }
    if (!busy) { busy = true; homeBusy++; }
    button.disabled = true;
    let result;
    try {
      result = await capi('service', { method: 'POST', body: JSON.stringify({ key: project.key, action, confirmed: action !== 'start' }) });
    } catch (e) { release(); button.disabled = false; banner(e.message); disarm(); await loadHome(); return; }
    release();
    await loadHome();
    banner([`「${baseName(project.workspace)}」${action === 'start' ? '服务已启动' : action === 'restart' ? '服务已重启' : '服务已停止'}`,
      result.serviceVersion ? `运行版本 v${result.serviceVersion}` : '',
      result.unclaimed ? `${result.unclaimed} 个已领取未结算，各端需重新接入` : ''].filter(Boolean).join(' · '));
  };
  return button;
}
function card(project) {
  const article = node('article', undefined, 'project-card');
  const stateText = !project.workspaceExists ? '工作目录不存在' : !project.dataExists ? '项目缓存不可用' : project.completed ? '已完成' : project.paused ? '已暂停' : project.online ? '运行中' : '已登记';
  const bad = !project.workspaceExists || !project.dataExists;
  article.append(badge(stateText, bad ? 'error card-state' : 'muted card-state'));
  article.append(node('h3', baseName(project.workspace) || project.projectId || '未命名项目'));
  article.append(node('code', project.workspace));
  const outdated = project.online && consoleVersion && project.serviceVersion && project.serviceVersion !== consoleVersion;
  article.append(node('p', `任务 ${project.taskCount} · 未完成 ${project.activeTaskCount} · ${project.online ? `服务运行中 · v${project.serviceVersion || '未知'}` : '服务未运行'}`, 'card-meta'));
  if (outdated) article.append(badge(`服务仍为旧版本，待重启`, 'warning'));
  const actions = node('div', undefined, 'card-actions');
  if (project.dataExists) actions.append(project.online ? serviceButton(project, 'stop') : serviceButton(project, 'start'), ...(project.online ? [serviceButton(project, 'restart')] : []));
  const enter = node('button', '进入控制台', 'primary');
  enter.disabled = bad;
  enter.onclick = async () => {
    enter.disabled = true; enter.textContent = '正在打开…';
    try {
      await capi(`p/${project.key}/ensure`, { method: 'POST', body: '{}' });
      location.hash = `#/p/${project.key}`;
    } catch (e) { banner(e.message); enter.disabled = false; enter.textContent = '进入控制台'; }
  };
  actions.append(enter);
  article.append(actions);
  return article;
}
// ---------- Project view ----------
function showProject(key) {
  teardownProject();
  ctx = { key, entry: null, snapshot: null, events: [], nextBefore: null, selected: null, tab: 'overview', stream: null, paused: false, pending: 0, tick: null, cleanupPreview: null, commandSnapshot: null, pendingCommand: null, connected: false };
  $('export').hidden = false; $('controls').hidden = false;
  const view = $('view');
  view.replaceChildren();
  const back = node('a', '← 返回项目目录', 'back-link'); back.href = '#/';
  const head = node('section', undefined, 'project-head');
  const titleWrap = node('div', undefined, 'project-title');
  titleWrap.append(node('div', 'PROJECT CONSOLE', 'eyebrow'), node('h1', '正在连接…', undefined));
  titleWrap.lastChild.id = 'p-name';
  const pathEl = node('div', '', 'workspace-path'); pathEl.id = 'p-workspace';
  const pills = node('div', undefined, 'pill-row'); pills.id = 'p-pills';
  titleWrap.append(pathEl, pills);
  const cluster = node('div', undefined, 'status-cluster'); cluster.id = 'status-cluster';
  cluster.innerHTML = '<div class="status-main"><span id="svc-dot" class="status-dot"></span><div><div id="svc-status" class="status-title">正在连接服务…</div><div id="svc-meta" class="status-meta">等待本地调度服务返回快照</div></div></div><div class="status-metrics"><div class="metric"><span class="metric-label">进程号 PID</span><span id="svc-pid" class="metric-value mono">—</span></div><div class="metric"><span class="metric-label">运行版本</span><span id="svc-version" class="metric-value">—</span></div><div class="metric"><span class="metric-label">已运行</span><span id="svc-uptime" class="metric-value">—</span></div><div class="metric"><span class="metric-label">启动时间</span><span id="svc-started" class="metric-value">—</span></div></div>';
  head.append(titleWrap, cluster);
  const tabs = node('nav', undefined, 'tabs');
  for (const [id, text] of [['overview', '总览'], ['tasks', '任务'], ['events', '事件']]) {
    const b = node('button', undefined, 'tab'); b.dataset.tab = id;
    b.append(document.createTextNode(text));
    if (id !== 'events') { const c = node('span', '', 'tab-count'); c.id = 'tab-count-' + id; b.append(c); }
    b.onclick = () => switchTab(id);
    tabs.append(b);
  }
  const overviewPanel = node('section', undefined, 'tab-panel'); overviewPanel.id = 'tab-overview';
  overviewPanel.innerHTML = '<div class="stats" id="stats"></div><section class="panel"><div class="panel-heading"><div><h2>连接与交接</h2><p>会话身份、宿主观测与工作状态；点击行查看详情</p></div><span id="observed" class="subtle"></span></div><div id="topology" class="topology"></div><div class="table-scroll"><table><thead><tr><th>端 / 角色</th><th>通信证据</th><th>待命授权 / 实时通道</th><th>当前工作</th><th>最近观测</th></tr></thead><tbody id="connections"></tbody></table></div><div id="empty-connections" class="empty" hidden>尚无接入端。请在各平台会话执行 connect；接入后将在这里显示。</div><div id="connection-detail" class="detail-inline" hidden></div></section><section class="panel"><div class="panel-heading"><div><h2>需要关注</h2><p>异常与待处理事项；点击定位到任务或连接</p></div></div><div id="alerts"></div></section>';
  const tasksPanel = node('section', undefined, 'tab-panel'); tasksPanel.id = 'tab-tasks'; tasksPanel.hidden = true;
  tasksPanel.innerHTML = boardMarkup;
  const eventsPanel = node('section', undefined, 'tab-panel'); eventsPanel.id = 'tab-events'; eventsPanel.hidden = true;
  eventsPanel.innerHTML = '<section class="panel"><div class="panel-heading"><div><h2>交互事件</h2><p>实时变化与保留期内历史</p></div><button id="pause-events">暂停滚动</button></div><div class="filters"><input id="search" placeholder="搜索错误、事件或编号" aria-label="搜索事件"><select id="level" aria-label="事件等级"><option value="">所有等级</option><option value="error">错误</option><option value="info">信息</option></select><select id="provider" aria-label="平台"><option value="">所有平台</option><option>qoder</option><option>codex</option><option>mimo</option><option>codearts</option></select><button id="filter-events">筛选</button><button id="clear-filter">清除对象筛选</button></div><div id="event-scope" class="subtle scope"></div><div id="events" class="event-list"></div><button id="older" class="load-more">加载更早事件</button></section>';
  view.append(back, head, tabs, overviewPanel, tasksPanel, eventsPanel);
  $('task-filter').onchange = () => renderTasks();
  $('task-stage').onchange = () => renderTasks();
  $('task-search').oninput = () => renderTasks();
  $('task-clear').onclick = () => { $('task-filter').value = 'all'; $('task-stage').value = ''; $('task-search').value = ''; renderTasks(); };
  document.querySelectorAll('[data-board-view]').forEach(b => b.onclick = () => { ctx.boardView = b.dataset.boardView; renderTasks(); });
  $('pause-events').onclick = () => { ctx.paused = !ctx.paused; ctx.pending = 0; $('pause-events').textContent = ctx.paused ? '恢复实时' : '暂停滚动'; if (!ctx.paused) renderEvents(); };
  $('filter-events').onclick = () => loadEvents();
  $('search').onkeydown = e => { if (e.key === 'Enter') loadEvents(); };
  $('clear-filter').onclick = () => { ctx.selected = null; renderProject(); loadEvents(); };
  $('older').onclick = () => loadEvents(true);
  live(false);
  enterProject();
}
async function enterProject() {
  try {
    const list = await capi('projects');
    ctx.entry = list.projects.find(p => p.key === ctx.key);
    if (!ctx.entry) throw Error('项目不在系统目录清单中，请返回主页刷新');
    $('p-name').textContent = baseName(ctx.entry.workspace) || ctx.entry.projectId || '未命名项目';
    $('p-workspace').textContent = ctx.entry.workspace;
    await papi('ensure', { method: 'POST', body: '{}' });
    await refresh();
    await loadEvents();
    subscribe();
    ctx.tick = setInterval(renderStatus, 1000);
  } catch (e) { live(false); banner(e.message); }
}
function samePath(a, b) {
  const clean = v => String(v || '').replace(/[\\/]+$/, '');
  return clean(a) === clean(b) || clean(a).toLowerCase() === clean(b).toLowerCase();
}
function currentProject() {
  if (!ctx?.snapshot) return null;
  return ctx.snapshot.projects.find(p => samePath(p.workspace, ctx.entry.workspace) || (ctx.entry.projectId && p.id === ctx.entry.projectId)) || null;
}
function switchTab(tab) {
  ctx.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const id of ['overview', 'tasks', 'events']) $('tab-' + id).hidden = id !== tab;
  renderProject();
}
async function refresh() {
  ctx.snapshot = await papi('overview');
  ctx.connected = true;
  live(true);
  renderProject();
}
function renderStatus() {
  const cluster = $('status-cluster');
  if (!cluster || !ctx) return;
  cluster.classList.remove('is-running', 'is-stopping', 'is-down');
  const snapshot = ctx.snapshot;
  if (!snapshot) return;
  const health = snapshot.health?.status || 'unknown';
  const pidText = snapshot.pid != null ? String(snapshot.pid) : '未上报';
  const streamNote = ctx.connected ? '' : ' · 实时同步已断开';
  $('svc-pid').textContent = pidText;
  $('svc-version').textContent = snapshot.runtimeVersion || '—';
  const started = snapshot.startedAt ? Date.parse(snapshot.startedAt) : NaN;
  $('svc-uptime').textContent = Number.isFinite(started) ? formatUptime(Date.now() - started) : '—';
  $('svc-started').textContent = snapshot.startedAt ? fullTime(snapshot.startedAt) : '—';
  if (health === 'stopping') {
    cluster.classList.add('is-stopping');
    $('svc-status').textContent = '服务停止中';
    $('svc-meta').textContent = `进程 PID ${pidText} · 管理台连接即将断开${streamNote}`;
    return;
  }
  if (health === 'running') {
    cluster.classList.add(ctx.connected ? 'is-running' : 'is-stopping');
    $('svc-status').textContent = ctx.connected ? '服务运行中' : '服务运行中（同步中断）';
    $('svc-meta').textContent = (snapshot.health?.dispatch?.reason
      ? `进程 PID ${pidText} · 调度：${snapshot.health.dispatch.reason}`
      : `进程 PID ${pidText} · 实例 ${String(snapshot.instanceId || '').slice(0, 8)} · 快照 ${time(snapshot.observedAt)}`) + streamNote;
    return;
  }
  cluster.classList.add('is-down');
  $('svc-status').textContent = `服务状态：${label(health)}`;
  $('svc-meta').textContent = `进程 PID ${pidText} · 未能识别运行状态，请查看事件流${streamNote}`;
}
function renderHealth() { banner(ctx?.snapshot?.health.dispatch?.reason || (ctx?.snapshot?.health.error ? '观测提示：' + ctx.snapshot.health.error : ctx?.snapshot?.health.wakeError ? '唤醒错误：' + ctx.snapshot.health.wakeError : '')); }
function statCard(titleText, count, hint, onclick, accent) {
  const e = node('button', undefined, 'stat' + (accent ? ' accent' : ''));
  e.type = 'button';
  e.append(node('div', titleText, 'label'));
  const v = node('div', String(count), 'value'); v.append(node('small', hint)); e.append(v);
  e.onclick = onclick;
  return e;
}
function renderProject() {
  const snapshot = ctx?.snapshot;
  if (!snapshot) return;
  const p = currentProject();
  renderStatus();
  renderHealth();
  $('revision').textContent = `revision ${snapshot.revision} · 事件 ${snapshot.cursor}`;
  const pills = $('p-pills');
  pills.replaceChildren();
  if (!p) pills.append(badge('项目未在当前服务登记', 'error'));
  else {
    if (p.archivedAt) pills.append(badge('已归档', 'muted'));
    if (p.completedAt) pills.append(badge('已完成'));
    if (p.paused) pills.append(badge('已暂停', 'warning'));
    if (p.readOnly) pills.append(badge('只读汇总', 'muted'));
  }
  // Previous implementation: renderEvidenceSummary(p?[p]:[]);
  // [AI-added] 2026-09-24 10:58: Render the compact, stateful evidence summary.
  renderEvidenceSummaryV2(p?[p]:[]);
  const connections = p?.connections || [], tasks = p?.tasks || [], alerts = p?.alerts || [];
  $('tab-count-overview').textContent = String(alerts.length || '');
  $('tab-count-tasks').textContent = String(tasks.length);
  // Overview tab: clickable stats, topology, connections, alerts.
  const byState = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
  $('stats').replaceChildren(
    statCard('任务', tasks.length, Object.entries(byState).map(([s, n]) => `${label(s)} ${n}`).join(' · ') || '尚无任务', () => { $('task-filter').value = 'all'; switchTab('tasks'); }, true),
    statCard('在途任务', tasks.filter(t => ['running', 'reviewing'].includes(t.state)).length, '执行与审核', () => { $('task-filter').value = 'active'; switchTab('tasks'); }),
    statCard('已绑定端', connections.length, `${connections.filter(c => c.communication === 'recent').length} 个最近有通信`, () => { switchTab('overview'); document.querySelector('#tab-overview .table-scroll')?.scrollIntoView({ behavior: 'smooth' }); }),
    statCard('需要关注', alerts.length, '点击定位告警', () => { switchTab('overview'); $('alerts').scrollIntoView({ behavior: 'smooth' }); })
  );
  $('observed').textContent = '更新于 ' + time(snapshot.observedAt) + (connections.length > 12 ? ' · 图示前 12 个端，完整连接见表' : '');
  const brainNodes = node('div', undefined, 'node-group'), reviewerNodes = node('div', undefined, 'node-group'), workerNodes = node('div', undefined, 'node-group');
  for (const c of connections.slice(0, 12)) {
    const e = node('button', `${c.provider.toUpperCase()} · ${label(c.role)}`, 'node');
    e.append(node('small', c.active.length ? `${c.active.length} 个在途阶段` : c.armed ? '等待交接' : '已绑定'));
    e.onclick = () => selectConnection(c.id);
    (c.role === 'brain' ? brainNodes : c.role === 'reviewer' ? reviewerNodes : workerNodes).append(e);
  }
  if (!brainNodes.childNodes.length) brainNodes.append(node('div', '大脑待接入', 'node'));
  if (!reviewerNodes.childNodes.length) reviewerNodes.append(node('div', '初审端待接入', 'node'));
  if (!workerNodes.childNodes.length) workerNodes.append(node('div', '执行员待接入', 'node'));
  const service = node('div', '调度服务', 'node service'); service.append(node('small', '事件 · 队列 · 交接'));
  $('topology').replaceChildren(brainNodes, node('span', '⇄', 'arrow'), reviewerNodes, node('span', '⇄', 'arrow'), service, node('span', '⇄', 'arrow'), workerNodes);
  $('connections').replaceChildren(...connections.map(c => {
    const tr = node('tr', undefined, ctx.selected?.kind === 'connection' && ctx.selected.id === c.id ? 'selected' : '');
    const title = node('td', `${c.provider.toUpperCase()} / ${label(c.role)}`); title.append(node('small', c.workerId || c.binding));
    const communication = node('td'); communication.append(badge(label(c.communication), c.communication === 'unknown' ? 'muted' : ''));
    const wakeText = !c.wakeEnabled ? '未配置唤醒' : !c.armed ? '未 park' : c.observationStale ? '已获待命授权 · 实时观测过期' : c.observation?.status === 'unreachable' ? '已获待命授权 · 通道不可达' : c.provider === 'qoder' ? '已获待命授权 · 桥接可达' : '已获待命授权';
    const wake = node('td'); wake.append(badge(wakeText, !c.armed || c.observation?.status === 'unreachable' ? 'muted' : ''));
    const state = node('td', c.active.map(a => `${a.taskId} · ${a.claimed ? '已领取' : '待领取'}`).join('，') || '暂无在途任务');
    const observed = node('td', time(c.observation?.checkedAt || c.contact?.lastRequestAt)); observed.append(node('small', c.observation?.source || '客户端请求'));
    tr.append(title, communication, wake, state, observed);
    tr.onclick = () => selectConnection(c.id);
    return tr;
  }));
  $('empty-connections').hidden = !!connections.length;
  renderConnectionDetail();
  $('alerts').replaceChildren(...alerts.slice(0, 15).map(a => {
    const e = node('div', a.message, 'alert');
    e.append(node('small', `${a.taskId ? '任务 ' + a.taskId : ''}${a.binding ? ' / ' + a.binding : ''}`));
    e.onclick = () => { if (a.taskId) selectTask(a.taskId); else if (a.binding) { const c = connections.find(c => c.binding === a.binding); if (c) selectConnection(c.id); } };
    return e;
  }));
  if (!alerts.length) $('alerts').append(node('div', '当前没有待处理异常', 'empty'));
  renderTasks();
  renderEvents();
}
function detailRows(entries) { const dl = node('dl'); for (const [k, v] of entries) { dl.append(node('dt', k), node('dd', String(v ?? '未观测'))); } return dl; }
function renderConnectionDetail() {
  const box = $('connection-detail');
  const sel = ctx.selected;
  if (sel?.kind !== 'connection') { box.hidden = true; box.replaceChildren(); return; }
  const c = currentProject()?.connections.find(c => c.id === sel.id);
  if (!c) { box.hidden = false; box.replaceChildren(node('p', '该绑定已移除或被新会话替换。')); return; }
  const o = c.observation;
  box.hidden = false;
  box.replaceChildren(
    node('h3', `${c.provider.toUpperCase()} · ${label(c.role)} · 连接详情`),
    detailRows([['绑定代次', c.clientId], ['会话', c.sessionId || '未提供'], ['最近请求', c.contact ? `${fullTime(c.contact.lastRequestAt)} / ${c.contact.action}` : '未观测'], ['改绑邀请', c.rebindInvitation ? `${c.rebindInvitation.id} / ${c.rebindInvitation.status} / ${fullTime(c.rebindInvitation.expiresAt)}` : '无'], ['待命授权', c.wakeEnabled ? c.armed ? '有效（允许下一项任务唤醒）' : '未 park' : '未配置'], ['授权时间', c.armed ? fullTime(c.armedAt) : '—'], ['实时宿主状态', `${label(o?.status)}${c.observationStale ? '（观测过期）' : ''}`], ['证据来源', o?.source], ['观测时间', fullTime(o?.checkedAt)], ['最近错误', c.continuationError || o?.error || '无']])
  );
  if (c.provider === 'qoder') box.append(node('h3', 'Qoder 直接桥接'), detailRows([['桥接状态', o?.status === 'unreachable' ? '不可达' : o?.checkedAt ? '可达' : '未观测'], ['会话状态', label(o?.status)], ['最近探测', fullTime(o?.checkedAt)], ['说明', '任务由 App Plugin 直接续接原会话；送达后仍需检查任务是否 claim。']]));
}
function taskActions(t) {
  const p = currentProject(), actions = node('div', undefined, 'task-actions');
  if (!p || p.readOnly) return actions;
  const add = (text, action) => { const b = node('button', text); b.type = 'button'; b.onclick = () => openCommand(action, t.id); actions.append(b); };
  const last = t.attempts.at(-1);
  if (['blocked', 'uncertain'].includes(t.state)) add('重试', 'retry');
  if (t.budgetExhausted) add('追加额度', 'task-budget');
  if (t.waitingForWorker || t.state === 'blocked') add('改派', 'assign');
  if (last && !last.settled && !last.claimedBy && (last.wakeNotice?.status === 'sent' || last.wakeNotice?.claimStatus === 'stalled')) add('再次提醒', 'wake-remind');
  return actions;
}
function boardOptions() {
  return { view:ctx.boardView || 'graph', query:$('task-search').value, stage:$('task-stage').value, filter:$('task-filter').value, selected:ctx.selected?.kind === 'task' ? ctx.selected.id : null };
}
function renderTasks() {
  if (!$('tasks')) return;
  renderBoard($('tab-tasks'), currentProject() || {}, boardOptions(), {
    select:selectTask, taskActions,
    stage:id => { $('task-stage').value = id; $('task-filter').value = 'all'; $('task-search').value = ''; renderTasks(); }
  });
  renderTaskDetail();
}
function renderTaskDetail() {
  const box = $('task-detail');
  const sel = ctx.selected;
  if (sel?.kind !== 'task') { box.hidden = true; box.replaceChildren(); return; }
  const t = currentProject()?.tasks.find(t => t.id === sel.id);
  if (!t) { box.hidden = false; box.replaceChildren(node('p', '该任务已移除。')); return; }
  box.hidden = false;
  box.replaceChildren(node('h3', `${t.id} · ${(t.stageHeld?'初审通过，等待阶段终审':label(t.state))}`), detailRows([['任务', t.title], ['契约版本', t.contractRevision || 1], ['依赖', t.dependsOn.join('、') || '无'],
    ['替代目标', (t.supersedes || []).join('、') || '无'], ['解决依据', t.resolution ? `${t.resolution.replacementTaskId}：${t.resolution.reason}` : '无'],
    ['大脑处置', t.attention && !t.attention.acknowledged ? '待大脑领取并处理' : ['blocked','uncertain'].includes(t.state) ? '通知已确认，任务仍需正式处置' : '无'], ['当前错误', t.error || '无']]));
  box.append(taskActions(t));
  const board = buildBoard(currentProject()), group = board.stages.find(s => s.id === t.stageId);
  box.append(node('h3', board.reviews.get(t.id).text));
  if (group) {
    box.append(detailRows([['所属阶段', group.latest.milestone], ['本次整体审核范围', [...group.taskIds].join('、')], ['最新轮次', group.latest.id]]));
    for (const r of group.rounds.filter(r => (r.reviewTaskIds || r.members.map(m => m.taskId)).includes(t.id))) {
      box.append(detailRows([['大脑终审轮次', r.id], ['阶段结论', ({pass:'通过',needs_fix:'需补修',blocked:'阻塞'}[r.verdict] || '尚未结算')], ['终审领取', r.attempt?.claimedAt ? fullTime(r.attempt.claimedAt) : '未领取']]));
    }
  } else box.append(node('p', '尚未登记阶段，提交阶段计划后统一终审。', 'subtle'));
  for (const a of t.attempts) {
    box.append(node('h3', `${label(a.role)} · ${a.provider || '未知平台'}`));
    const timeline = node('div', undefined, 'timeline');
    for (const [title, at] of [['已派发', a.startedAt], [`通知：${label(a.wakeNotice?.status)}`, a.wakeNotice?.at], ['已领取', a.claimedAt], [a.progress?.stage ? `${label(a.progress?.stage)} · ${a.progress?.summary}` : '暂无进度上报', a.progress?.at], [a.settled ? '已结算' : '等待下一步', null]]) {
      const step = node('div', title, 'step'); step.append(node('small', at ? fullTime(at) : '—')); timeline.append(step);
    }
    box.append(timeline);
    const u = a.usage, usageText = u ? `输入 ${u.inputTokens ?? '未知'}（缓存 ${u.cachedInputTokens ?? '未知'}），输出 ${u.outputTokens ?? '未知'}（推理 ${u.reasoningOutputTokens ?? '未知'}）` : `未统计：${a.usageStatus?.message || '原因未知'}`;
    box.append(detailRows([['消耗状态', u ? (a.usageStatus?.status === 'measured' ? '完整计量' : '时间窗口计量') : '不可用'], ['Token', usageText], ['模型', u?.model || a.model || '未知'], ['来源', u?.source || a.usageStatus?.reason || '未知']]));
  }
}
function selectTask(id) {
  const board = buildBoard(currentProject()), task = board.byId.get(id);
  if (task && !matchesTask(task, board, boardOptions())) { $('task-filter').value = 'all'; $('task-stage').value = ''; $('task-search').value = ''; }
  ctx.selected = { kind: 'task', id }; switchTab('tasks'); loadEvents();
  [...document.querySelectorAll('.board-task')].find(e => e.dataset.taskId === id)?.scrollIntoView({ block:'nearest', inline:'nearest' });
}
function selectConnection(id) {
  const c = currentProject()?.connections.find(c => c.id === id);
  if (!c) return;
  ctx.selected = { kind: 'connection', id, binding: c.binding };
  switchTab('overview');
  loadEvents();
}
// ---------- Events ----------
function params() {
  const q = new URLSearchParams({ limit: '100' });
  const p = currentProject();
  if (p) q.set('projectId', p.id);
  if (ctx.selected?.kind === 'task') q.set('taskId', ctx.selected.id);
  if (ctx.selected?.kind === 'connection') q.set('binding', ctx.selected.binding);
  for (const [id, key] of [['search', 'q'], ['provider', 'provider'], ['level', 'level']]) if ($(id)?.value) q.set(key, $(id).value);
  return q;
}
function matchesEvent(e) {
  const q = params();
  return ['projectId', 'taskId', 'binding', 'provider', 'level'].every(k => !q.get(k) || e[k] === q.get(k)) && (!q.get('q') || JSON.stringify(e).toLowerCase().includes(q.get('q').toLowerCase()));
}
function renderEvents() {
  const list = $('events');
  if (!list || !ctx) return;
  list.replaceChildren(...ctx.events.filter(matchesEvent).slice(0, 600).map(e => {
    const row = node('div', undefined, 'event ' + e.level);
    const content = node('div');
    content.append(node('strong', `${label(e.type)}${e.action ? ' / ' + e.action : ''}${e.status ? ' · ' + label(e.status) : ''}`), node('p', e.error || e.summary || [e.projectId, e.taskId, e.binding].filter(Boolean).join(' / ')), node('code', `${e.attemptId ? e.attemptId.slice(0, 12) + ' · ' : ''}#${e.sequence}${e.durationMs !== undefined ? ' · ' + e.durationMs + ' ms' : ''}`));
    row.append(node('time', time(e.at)), node('span', undefined, 'dot'), content);
    return row;
  }));
  if (!ctx.events.length) list.append(node('div', '当前筛选没有事件', 'empty'));
  $('event-scope').textContent = ctx.selected ? `筛选：${ctx.selected.kind === 'task' ? '任务' : '连接'} ${ctx.selected.kind === 'task' ? ctx.selected.id : ctx.selected.binding}` : '当前项目事件';
  $('older').disabled = !ctx.nextBefore;
}
async function loadEvents(older = false) {
  if (!ctx) return;
  try {
    const q = params();
    if (older && ctx.nextBefore) q.set('before', ctx.nextBefore);
    const result = await papi('events?' + q);
    ctx.events = older ? [...ctx.events, ...result.events] : result.events;
    ctx.nextBefore = result.nextBefore;
    renderEvents();
  } catch (e) { banner(e.message); }
}
function subscribe() {
  if (ctx.stream) ctx.stream.close();
  const stream = new EventSource(`/catalog/api/p/${ctx.key}/stream?cursor=${ctx.snapshot.cursor}&instanceId=${encodeURIComponent(ctx.snapshot.instanceId)}`);
  ctx.stream = stream;
  stream.onopen = () => { ctx.connected = true; live(true); renderHealth(); };
  stream.onerror = () => { ctx.connected = false; live(false); banner('与服务的实时连接已断开，当前显示最后快照。服务停止后请返回项目目录重新进入。'); };
  stream.addEventListener('snapshot', e => { ctx.snapshot = JSON.parse(e.data); ctx.connected = true; live(true); renderProject(); });
  stream.addEventListener('reset', () => { loadEvents(); });
  stream.addEventListener('event', e => {
    const v = JSON.parse(e.data);
    if (!ctx.events.some(x => x.sequence === v.sequence)) { ctx.events.unshift(v); ctx.events = ctx.events.slice(0, 600); }
    if (ctx.paused) { ctx.pending++; $('pause-events').textContent = `恢复实时（${ctx.pending}）`; }
    else renderEvents();
  });
}
// ---------- Command dialog ----------
function fillOptions(id, values, value) {
  $(id).replaceChildren(...values.map(([v, t]) => { const e = node('option', t); e.value = v; return e; }));
  if (value) $(id).value = value;
}
const lifecycleActions = { 'archive-project': '归档项目', 'restore-project': '恢复归档项目', 'delete-project': '永久删除项目', 'reset-task': '完全重置任务' };
function commandTargets() {
  const p = ctx.commandSnapshot?.projects.find(p => p.id === $('command-project').value && !p.readOnly);
  fillOptions('command-task', (p?.tasks || []).map(t => [t.id, t.id + ' · ' + t.title]), ctx.selected?.kind === 'task' ? ctx.selected.id : null);
  fillOptions('command-binding', (p?.connections || []).map(c => [c.binding, c.provider + ' / ' + label(c.role) + ' / ' + c.binding]), ctx.selected?.binding);
}
function impact() {
  const action = $('action').value;
  const descriptions = { pause: '暂停只阻止后续调度，当前回合继续。', resume: '继续项目调度，可能立即派发已排队任务。', retry: '重试会重新排队；uncertain 状态必须先核实旧执行进程停止。', 'rebind-invite': '生成 30 分钟一次性改绑邀请，并按 Codex、MiMo、Qoder、CodeArts 或等待型平台给出对应提示词；不勾选停止确认时安全等待旧端结算，勾选后会转移合法的在途所有权。', 'rebind-cancel': '取消尚未完成的改绑邀请，不改变当前绑定。', detach: '解绑可能终止审核所有权；在途执行受服务保护，不能强制移除。', stop: '停止整个服务，所有管理台连接断开；执行中任务可能需要核实。重启需返回项目目录重新进入。', 'cleanup-apply': '仅执行最近清理预览中的目录清理，请先核对预览结果。', 'wake-retry': '仅加速检查明确可重试的 pending 通知；不重发 sent 或 uncertain 通知。', 'wake-remind': '为当前未领取 attempt 补充一次待命授权并发送独立提醒；必须填写原因，送达不确定时禁止执行。', 'finish-project': '仅允许结束所有任务已通过或由已通过替代任务解决的项目，等待端将退出。' };
  if (lifecycleActions[action]) {
    const p = ctx.commandSnapshot?.projects.find(p => p.id === $('command-project').value);
    $('impact').textContent = `项目 ID：${p?.id || '—'}。` + ({ 'archive-project': '默认隐藏并暂停项目，保留所有历史。', 'restore-project': '恢复后保持暂停，核对后再继续。', 'delete-project': '永久删除调度记录并撤销连接；保留审计、源工程及磁盘产物。', 'reset-task': '清空执行、审核、唤醒、产物关联和次数，额度恢复 30。保留任务定义、旧记录审计及源文件。项目会暂停；已有执行的下游任务必须级联重置。' }[action]);
    return;
  }
  $('impact').textContent = descriptions[action] || '操作会记录目标、原因与结果。状态变化后服务会拒绝旧操作。';
}
function commandFields() {
  const a = $('action').value;
  const visible = { 'command-project': false, 'command-task': ['retry', 'task-budget', 'assign', 'wake-retry', 'wake-remind'].includes(a), 'command-binding': ['detach', 'rebind-invite'].includes(a), 'invitation-id': a === 'rebind-cancel', 'worker-id': a === 'assign', additional: a === 'task-budget', 'confirmed-stopped': ['retry', 'rebind-invite'].includes(a), 'restart-worker': a === 'retry' };
  for (const [id, show] of Object.entries(visible)) $(id).closest('label').hidden = !show;
  $('confirm-text-label').hidden = !['delete-project', 'reset-task'].includes(a);
  $('reset-dependents-label').hidden = a !== 'reset-task';
  $('lifecycle-preview').hidden = !lifecycleActions[a];
  if (a === 'reset-task') $('command-task').closest('label').hidden = false;
  if (['delete-project', 'reset-task'].includes(a)) $('confirmed-stopped').closest('label').hidden = false;
}
function openCommand(actionValue, targetTaskId) {
  if (!ctx?.snapshot) return;
  if (ctx.pendingCommand) { $('command-dialog').showModal(); return; }
  const p = currentProject();
  if (!p || p.readOnly) { banner('当前项目为只读汇总或不可用，不能执行管理操作。'); return; }
  ctx.commandSnapshot = structuredClone(ctx.snapshot);
  if (actionValue && [...$('action').options].some(o => o.value === actionValue)) $('action').value = actionValue; else $('action').selectedIndex = 0;
  fillOptions('command-project', [[p.id, name(p)]], p.id);
  commandTargets();
  if (targetTaskId) $('command-task').value = targetTaskId;
  impact(); commandFields();
  $('confirm-impact').checked = false;
  $('command-result').textContent = '';
  $('command-dialog').showModal();
}
// [AI-added] 2026-09-19: A generated rebind invitation deserves a copyable popup, not raw JSON.
// [AI-added] 2026-09-21: One invitation carries an adapted prompt per host platform; switching
// platform re-renders the command instead of regenerating the invitation.
let invitationResult = null;
function renderInvitationVariant() {
  const variant = invitationResult?.platforms.find(item => item.provider === $('invitation-platform').value) || invitationResult?.platforms.at(-1);
  if (!variant) return;
  $('invitation-text').value = variant.text;
  $('invitation-hint').textContent = `${variant.label}：${variant.sessionHint}`;
}
function showInvitation(result) {
  invitationResult = result;
  $('invitation-meta').textContent = `邀请 ${result.invitationId} · 30 分钟内有效 · 目标：${result.role === 'worker' ? '执行员' + (result.workerId ? ' ' + result.workerId : '') : result.role === 'reviewer' ? '初审端' : '大脑'} · ${result.recover ? '确认恢复（将转移在途所有权）' : '安全交接（旧端有在途任务时等待结算）'}`;
  fillOptions('invitation-platform', result.platforms.map(item => [item.provider, item.label + (item.sessionIdRequired ? ' · 需要 --session-id' : '')]));
  $('invitation-platform').value = result.provider;
  renderInvitationVariant();
  $('copy-invitation').textContent = '复制提示词';
  $('invitation-dialog').showModal();
}
function wireCommandDialog() {
  $('controls').onclick = () => openCommand();
  $('close-dialog').onclick = () => $('command-dialog').close();
  $('command-project').onchange = () => { commandTargets(); commandFields(); };
  $('action').onchange = () => { impact(); commandFields(); };
  $('close-invitation').onclick = () => $('invitation-dialog').close();
  $('invitation-platform').onchange = renderInvitationVariant;
  $('invitation-done').onclick = () => $('invitation-dialog').close();
  $('copy-invitation').onclick = async () => {
    const box = $('invitation-text');
    try { await navigator.clipboard.writeText(box.value); }
    catch { box.select(); document.execCommand('copy'); }
    $('copy-invitation').textContent = '已复制';
    setTimeout(() => { $('copy-invitation').textContent = '复制提示词'; }, 1500);
  };
  $('lifecycle-preview').onclick = async () => {
    try {
      const result = await papi('commands', { method: 'POST', body: JSON.stringify({ action: 'lifecycle-preview', operation: $('action').value, commandId: crypto.randomUUID(), instanceId: ctx.commandSnapshot.instanceId, revision: ctx.commandSnapshot.revision, projectId: $('command-project').value, taskId: $('command-task').value }) });
      $('command-result').textContent = JSON.stringify(result, null, 2);
    } catch (e) { $('command-result').textContent = e.message; }
  };
  $('command-form').onsubmit = async e => {
    e.preventDefault();
    const action = $('action').value, p = ctx.commandSnapshot.projects.find(p => p.id === $('command-project').value), t = p?.tasks.find(t => t.id === $('command-task').value), c = p?.connections.find(c => c.binding === $('command-binding').value);
    let command = ctx.pendingCommand;
    if (!command && lifecycleActions[action]) command = { commandId: crypto.randomUUID(), instanceId: ctx.commandSnapshot.instanceId, revision: ctx.commandSnapshot.revision, action, projectId: $('command-project').value, taskId: $('command-task').value, confirmText: $('confirm-text').value, resetDependents: $('reset-dependents').checked, confirmed: $('confirm-impact').checked, confirmedStopped: $('confirmed-stopped').checked, reason: $('reason').value };
    command = command || { commandId: crypto.randomUUID(), instanceId: ctx.commandSnapshot.instanceId, revision: ctx.commandSnapshot.revision, action, projectId: p?.id, taskId: t?.id, binding: c?.binding, clientId: c?.clientId, invitationId: $('invitation-id').value, attemptId: t?.attempts.at(-1)?.id, workerId: $('worker-id').value, additionalAttempts: Number($('additional').value), reason: $('reason').value, confirmed: $('confirm-impact').checked, confirmedStopped: $('confirmed-stopped').checked, restartWorker: $('restart-worker').checked, previewId: ctx.cleanupPreview };
    ctx.pendingCommand = command;
    $('execute').disabled = true;
    try {
      const result = await papi('commands', { method: 'POST', body: JSON.stringify(command) });
      ctx.pendingCommand = null;
      if (command.action === 'cleanup-preview') ctx.cleanupPreview = result.previewId;
      $('command-result').textContent = JSON.stringify(result, null, 2);
      $('confirm-impact').checked = false;
      if (command.action === 'rebind-invite' && result?.platforms?.length) showInvitation(result);
      if (command.action !== 'stop') {
        await refresh(); ctx.commandSnapshot = structuredClone(ctx.snapshot); commandTargets();
        // [AI-added] 2026-09-19: Keep the operator's chosen target visible; otherwise the rebuilt
        // dropdown falls back to the first connection and reads as another role's rebind.
        if (command.binding && [...$('command-binding').options].some(o => o.value === command.binding)) $('command-binding').value = command.binding;
        if (command.taskId && [...$('command-task').options].some(o => o.value === command.taskId)) $('command-task').value = command.taskId;
      }
    } catch (error) {
      if (error.definitive) ctx.pendingCommand = null;
      $('command-result').textContent = error.message + (ctx.pendingCommand ? '\n结果尚未确认，再次点击将查询同一命令，不会重复执行。' : '\n请关闭并重新打开控制面板，核对最新状态。');
    } finally { $('execute').disabled = false; }
  };
}
// [AI-added] 2026-09-19: cleanup dialog submit reports the removal result inline and refreshes the home list.
function wireCleanupDialog() {
  $('close-cleanup').onclick = () => $('cleanup-dialog').close();
  $('cleanup-cancel').onclick = () => $('cleanup-dialog').close();
  $('cleanup-form').onsubmit = async e => {
    e.preventDefault();
    $('cleanup-confirm').disabled = true;
    const result = $('cleanup-result');
    try {
      const value = await capi('cleanup-invalid', { method: 'POST', body: '{}' });
      const removed = value.removed || [], kept = value.kept || [];
      result.textContent = [
        removed.length ? '已移除 ' + removed.length + ' 条登记记录：' + removed.map(p => p.workspace).join('；') : '没有可移除的登记记录。',
        kept.length ? '保留 ' + kept.length + ' 条（服务数据仍在）：' + kept.map(p => p.workspace).join('；') : ''
      ].filter(Boolean).join('\n');
      result.hidden = false;
      loadHome().catch(() => {});
    } catch (error) {
      result.textContent = error.message;
      result.hidden = false;
      $('cleanup-confirm').disabled = false;
    }
  };
}
// ---------- Router & boot ----------
function route() {
  const match = location.hash.match(/^#\/p\/([^/]+)$/);
  if (match) showProject(decodeURIComponent(match[1]));
  else showHome();
}
window.addEventListener('hashchange', route);
async function boot() {
  initTheme();
  loadVersion();
  wireCommandDialog();
  wireCleanupDialog();
  $('refresh').onclick = () => { if (ctx) refresh().catch(e => banner(e.message)); else loadHome(); };
  $('export').onclick = () => { if (ctx) location.href = `/catalog/api/p/${ctx.key}/diagnostics?` + params(); };
  try {
    const hash = new URLSearchParams(location.hash.slice(1)), ticket = hash.get('ticket');
    if (ticket) {
      history.replaceState(null, '', '/catalog/');
      const r = await fetch('/catalog/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
      csrf = result.csrf;
    } else csrf = (await capi('session')).csrf;
    route();
  } catch (e) { banner(e.message); }
}
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
// [AI-added] 2026-09-24 10:58: Native disclosure keeps the overview compact and keyboard accessible.
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
