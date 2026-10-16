const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const defaults = () => [{ workerId: 'default', capability: 'general', responsibilities: '完成当前目标的实现与验证' }];
const pathKey = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const states = { draft: '待开始', queued: '排队中', active: '执行中', blocked: '阻塞', completed: '已完成', cancelled: '已取消' };
let createDialog, teamDialog, pendingCreate = null, createContext;

function workerRow(worker, box) {
  const row = element('div', undefined, 'setup-worker');
  for (const [key, label, placeholder] of [['workerId', '执行员编号', '例如 worker-2'], ['capability', '能力标签', 'general / strong / economy'], ['responsibilities', '职责', '负责的工作']]) {
    const field = element('label', label), input = element('input');
    input.name = key; input.value = worker[key] || ''; input.placeholder = placeholder; input.required = true;
    input.maxLength = key === 'responsibilities' ? 1000 : 64;
    if (key !== 'responsibilities') input.pattern = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}';
    field.append(input); row.append(field);
  }
  const remove = element('button', '移除'); remove.type = 'button';
  remove.onclick = () => { if (box.children.length > 1) row.remove(); else box.closest('form').querySelector('[role="alert"]').textContent = '至少保留一名执行员'; };
  remove.setAttribute('aria-label', '移除执行员 ' + (worker.workerId || box.children.length + 1)); row.append(remove);
  return row;
}
function fillWorkers(box, workers) { box.replaceChildren(...workers.map(worker => workerRow(worker, box))); }
function readWorkers(box) {
  const rows = [...box.children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.name, input.value.trim()])));
  if (new Set(rows.map(worker => worker.workerId)).size !== rows.length) throw Error('执行员编号不能重复');
  return rows;
}
function addWorker(box, error) {
  if (box.children.length >= 20) { error.textContent = '最多配置 20 名执行员'; return; }
  box.append(workerRow({}, box));
}
function revealInvalid(form) { form.addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true); }

export function openCreateTask({ api, onCreated, workspace = '', existing = false, projects = [] }) {
  if (!createDialog) {
    createDialog = element('dialog', undefined, 'setup-dialog'); createDialog.id = 'create-task-dialog';
    createDialog.innerHTML = '<form id="setup-form"><div class="dialog-heading"><h2 id="setup-heading">创建目标</h2><button type="button" id="setup-close" aria-label="关闭创建目标">✕</button></div><p class="subtle">同一项目的目标按顺序执行；已有成员直接沿用，只邀请缺少的成员。</p><label>目标名称<input id="setup-title" required maxlength="120" placeholder="例如：完成游戏存档功能"></label><label>项目工作目录<input id="setup-workspace" list="setup-projects" required placeholder="已有项目目录的绝对路径" spellcheck="false"><datalist id="setup-projects"></datalist></label><label>目标与验收要求<textarea id="setup-objective" required maxlength="12000" rows="5" placeholder="说明要完成什么，以及如何判断完成"></textarea></label><p id="setup-reuse" class="impact" hidden>将沿用这个项目的成员和历史。当前目标执行期间，新增目标会排队等待。</p><div id="setup-new-team"><div class="setup-fixed"><span>大脑</span><span>初审端</span><span>执行员</span></div><p class="subtle">默认三名成员。平台及模型由各成员会话明确选择，通用执行员不预设模型档位。</p><details id="setup-advanced"><summary>高级成员设置</summary><div class="panel-heading"><h3>执行员</h3><button type="button" id="setup-add">添加执行员</button></div><div id="setup-workers"></div></details></div><p id="setup-error" class="setup-error" role="alert"></p><div class="dialog-actions"><button type="submit" class="primary" id="setup-submit" value="auto">创建并开始</button><button type="submit" id="setup-save" value="manual">仅保存</button></div><p class="subtle">「创建并开始」即授权开始；成员就绪且轮到这个目标时自动执行。「仅保存」后可再选择开始。</p></form>';
    document.body.append(createDialog); revealInvalid($('setup-form'));
  }
  const context = existing ? workspace : 'home';
  const changedContext = createContext !== context;
  if (changedContext) { $('setup-form').reset(); fillWorkers($('setup-workers'), defaults()); pendingCreate = null; createContext = context; }
  if (!$('setup-workers').children.length) fillWorkers($('setup-workers'), defaults());
  $('setup-heading').textContent = existing ? '新增目标' : '创建目标';
  if (existing || changedContext) $('setup-workspace').value = workspace;
  $('setup-workspace').readOnly = existing;
  $('setup-projects').replaceChildren(...projects.filter(project => project.workspaceExists).map(project => { const option = element('option'); option.value = project.workspace; return option; }));
  const reusesProject = () => existing || projects.some(project => pathKey(project.workspace) === pathKey($('setup-workspace').value));
  const updateMode = () => {
    const reuse = reusesProject(); $('setup-reuse').hidden = !reuse; $('setup-new-team').hidden = reuse;
    $('setup-workers').querySelectorAll('input,button').forEach(input => { input.disabled = reuse; });
  };
  $('setup-workspace').oninput = updateMode; updateMode();
  $('setup-close').onclick = () => createDialog.close(); $('setup-error').textContent = '';
  $('setup-add').onclick = () => addWorker($('setup-workers'), $('setup-error'));
  const form = $('setup-form');
  form.onsubmit = async event => {
    event.preventDefault();
    let payload;
    try {
      payload = { title: $('setup-title').value.trim(), workspace: $('setup-workspace').value.trim(), objective: $('setup-objective').value.trim(), startMode: event.submitter?.value === 'manual' ? 'manual' : 'auto',
        ...(!reusesProject() ? { workers: readWorkers($('setup-workers')) } : {}) };
    } catch (error) { $('setup-error').textContent = error.message; return; }
    const signature = JSON.stringify(payload);
    if (!pendingCreate || pendingCreate.signature !== signature) pendingCreate = { signature, payload: { commandId: crypto.randomUUID(), ...payload } };
    const request = pendingCreate, controls = [...form.elements].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; }); $('setup-error').textContent = '';
    const chosen = event.submitter || $('setup-submit'), previousText = chosen.textContent; chosen.textContent = '正在保存…';
    const preventClose = event => event.preventDefault(); createDialog.addEventListener('cancel', preventClose);
    try {
      const result = await api('projects', { method: 'POST', body: JSON.stringify(request.payload) });
      pendingCreate = null; createDialog.close(); form.reset(); fillWorkers($('setup-workers'), defaults()); await onCreated(result);
    } catch (error) { $('setup-error').textContent = error.message + '；原内容已保留，可以重试。'; }
    finally { controls.forEach(([control, disabled]) => { control.disabled = disabled; }); chosen.textContent = previousText; createDialog.removeEventListener('cancel', preventClose); }
  };
  createDialog.showModal();
}

export function openTeamSettings({ project, onSave }) {
  if (!teamDialog) {
    teamDialog = element('dialog', undefined, 'setup-dialog'); teamDialog.id = 'team-settings-dialog';
    teamDialog.innerHTML = '<form id="team-form"><div class="dialog-heading"><h2>调整成员</h2><button id="team-close" type="button" aria-label="关闭调整成员">✕</button></div><p class="subtle">大脑与初审端保留；已有会话继续沿用，替换会话请使用改绑邀请。</p><div id="team-workers"></div><button id="team-add" type="button">添加执行员</button><p id="team-error" class="setup-error" role="alert"></p><div class="dialog-actions"><button type="submit" class="primary">保存成员配置</button></div></form>';
    document.body.append(teamDialog);
  }
  fillWorkers($('team-workers'), project.team.members.filter(member => member.role === 'worker'));
  $('team-error').textContent = ''; $('team-close').onclick = () => teamDialog.close();
  $('team-add').onclick = () => addWorker($('team-workers'), $('team-error'));
  $('team-form').onsubmit = async event => {
    event.preventDefault(); const controls = [...$('team-form').elements];
    const preventClose = event => event.preventDefault(); teamDialog.addEventListener('cancel', preventClose);
    try {
      const workers = readWorkers($('team-workers')); controls.forEach(control => { control.disabled = true; });
      await onSave(workers); teamDialog.close();
    } catch (error) { $('team-error').textContent = error.message; }
    finally { controls.forEach(control => { control.disabled = false; }); teamDialog.removeEventListener('cancel', preventClose); }
  };
  teamDialog.showModal();
}

export function renderTeam(project, { onInvite, onGoalAction, onConfigure }) {
  let panel = $('project-team'), goalPanel = $('project-goals');
  if (!project?.team) { panel?.remove(); goalPanel?.remove(); return; }
  if (!goalPanel) { goalPanel = element('section', undefined, 'panel goals-panel'); goalPanel.id = 'project-goals'; $('stats').before(goalPanel); }
  if (!panel) { panel = element('section', undefined, 'panel team-panel'); panel.id = 'project-team'; $('stats').before(panel); }
  const team = project.team, goals = project.goals || [], queue = project.queue || [], blocked = !!project.archivedAt || !!project.completedAt;
  if (team.ready < team.total) { if (panel.nextElementSibling !== goalPanel) goalPanel.before(panel); }
  else if (goalPanel.nextElementSibling !== panel) panel.before(goalPanel);
  const goalSignature = JSON.stringify([goals, queue, project.activeGoalId, team.ready, team.total, project.paused, blocked]);
  if (goalPanel.dataset.signature !== goalSignature) {
    goalPanel.dataset.signature = goalSignature;
    const heading = element('div', undefined, 'panel-heading'), intro = element('div');
    intro.append(element('h2', '目标队列'), element('p', `执行中 ${goals.filter(goal => ['active', 'blocked'].includes(goal.state)).length} · 排队 ${queue.length} · 待开始 ${goals.filter(goal => goal.state === 'draft').length}`)); heading.append(intro);
    const list = element('div', undefined, 'goal-list');
    const order = goal => goal.id === project.activeGoalId ? -1 : goal.state === 'queued' ? queue.indexOf(goal.id) : goal.state === 'draft' ? queue.length : queue.length + 1;
    for (const goal of [...goals].sort((a, b) => order(a) - order(b))) {
      const row = element('article', undefined, 'goal-card' + (goal.id === project.activeGoalId ? ' is-current' : ''));
      const top = element('div', undefined, 'goal-heading'); top.append(element('h3', goal.title), element('span', states[goal.state] || goal.state, 'badge ' + (goal.state === 'blocked' ? 'error' : goal.state === 'draft' || goal.state === 'queued' ? 'warning' : ''))); row.append(top);
      const facts = [`执行任务 ${goal.completedTaskCount} / ${goal.taskCount}`];
      if (goal.state === 'queued') facts.push('队列第 ' + (queue.indexOf(goal.id) + 1) + ' 位');
      row.append(element('p', facts.join(' · '), 'subtle'));
      if (goal.blockedReason) row.append(element('p', goal.blockedReason, 'setup-error'));
      if (goal.state === 'queued' && !project.activeGoalId && queue[0] === goal.id) row.append(element('p', project.paused ? '项目暂停，等待继续' : `等待成员就绪 ${team.ready} / ${team.total}，就绪后自动开始`, 'subtle'));
      const details = element('details'), summary = element('summary', '目标与验收要求'); details.append(summary, element('p', goal.objective || '沿用原项目已登记的工作', 'task-objective'));
      details.open = goal.id === project.activeGoalId; row.append(details);
      if (goal.summary) row.append(element('p', goal.summary));
      const actions = element('div', undefined, 'goal-actions'), error = element('p', '', 'setup-error'); error.setAttribute('role', 'alert');
      for (const [action, text] of goal.state === 'draft' ? [['start-goal', '开始排队'], ['cancel-goal', '取消目标']] : goal.state === 'queued' ? [['cancel-goal', '取消目标']] : []) {
        const button = element('button', text, action === 'start-goal' ? 'primary' : ''); button.type = 'button'; button.disabled = blocked;
        button.onclick = async () => { button.disabled = true; try { await onGoalAction(project, goal, action); } catch (failure) { error.textContent = failure.message; } finally { button.disabled = blocked; } }; actions.append(button);
      }
      row.append(actions, error); list.append(row);
    }
    if (!goals.length) list.append(element('p', '尚无目标，点击「新增目标」开始。', 'subtle'));
    goalPanel.replaceChildren(heading, list);
  }
  const signature = JSON.stringify(team) + blocked;
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  const heading = element('div', undefined, 'panel-heading'), intro = element('div');
  intro.append(element('h2', '项目成员'), element('p', `已就绪 ${team.ready} / ${team.total} · 后续目标直接复用，缺少的成员可以同时加入。`)); heading.append(intro);
  const configure = element('button', '调整成员'); configure.type = 'button'; configure.disabled = !team.canConfigure;
  configure.title = team.canConfigure ? '调整执行员配置' : '活动目标结束后可调整成员'; configure.onclick = () => onConfigure(project); heading.append(configure);
  const grid = element('div', undefined, 'team-grid');
  for (const member of team.members) {
    const row = element('article', undefined, 'team-member');
    row.append(element('h3', member.role === 'brain' ? '大脑' : member.role === 'reviewer' ? '初审端' : member.workerId === 'default' ? '执行员' : '执行员 · ' + member.workerId),
      element('p', member.responsibilities), element('span', member.message, 'badge ' + (member.state === 'ready' ? '' : 'warning')));
    if (member.connected) row.append(element('small', '沿用当前会话' + (member.provider ? ' · ' + member.provider : ''), 'subtle'));
    if (!member.connected && !blocked) {
      const invite = element('button', '复制加入邀请'); invite.type = 'button';
      invite.onclick = async () => { invite.disabled = true; try { await onInvite(project, member); } finally { invite.disabled = false; } }; row.append(invite);
    }
    grid.append(row);
  }
  panel.replaceChildren(heading, grid);
}
