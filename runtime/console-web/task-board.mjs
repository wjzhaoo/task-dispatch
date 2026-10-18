// Stage-aware task presentation. Does not change scheduling or task state.
const terminal = task => ['accepted', 'resolved'].includes(task.state);
const stateLabels = { ready:'待执行', running:'执行中', review_ready:'待初审', reviewing:'初审中', accepted:'已验收', resolved:'已由后续任务解决', blocked:'阻塞', uncertain:'需核实' };
export function reviewStatus(round) {
  if (!round) return { key:'draft', text:'需大脑终审 · 未登记阶段' };
  if (round.verdict === 'pass') return { key:'passed', text:'大脑终审通过' };
  if (round.round > 1 && round.state === 'collecting') return { key:'repair', text:'待补修后大脑复审' };
  if (round.state === 'completed') return { key:'repair', text:'大脑退回 · 待补修复审' };
  return { key:round.state, text:({ reviewing:'大脑终审中', ready:'待大脑领取终审', preparing:'准备大脑终审', blocked:'大脑终审受阻' })[round.state] || '需大脑阶段终审' };
}

export function buildBoard(project = {}) {
  const tasks = project.tasks || [], byId = new Map(tasks.map(t => [t.id, t]));
  const rounds = (project.reviewStages?.rounds || []).filter(r => r.state !== 'reset');
  const stages = new Map();
  for (const round of rounds) {
    const group = stages.get(round.stageId) || { id:round.stageId, rounds:[], taskIds:new Set() };
    group.rounds.push(round); group.latest = round;
    for (const id of round.reviewTaskIds || round.members.map(m => m.taskId)) {
      if (byId.get(id)?.stageId === round.stageId) group.taskIds.add(id);
    }
    stages.set(group.id, group);
  }
  const edges = [], missing = [], children = new Map(tasks.map(t => [t.id, []]));
  const indegree = new Map(tasks.map(t => [t.id, 0])), rank = new Map(tasks.map(t => [t.id, 0]));
  for (const task of tasks) for (const id of new Set(task.dependsOn || [])) {
    if (!byId.has(id)) { missing.push({ from:id, to:task.id }); indegree.set(task.id, indegree.get(task.id) + 1); continue; }
    edges.push({ from:id, to:task.id }); children.get(id).push(task.id);
    indegree.set(task.id, indegree.get(task.id) + 1);
  }
  const queue = tasks.filter(t => indegree.get(t.id) === 0).map(t => t.id);
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i])) {
    rank.set(id, Math.max(rank.get(id), rank.get(queue[i]) + 1));
    indegree.set(id, indegree.get(id) - 1); if (!indegree.get(id)) queue.push(id);
  }
  const unresolved = tasks.filter(t => indegree.get(t.id) > 0).map(t => t.id);
  const layers = [];
  for (const task of tasks) if (!indegree.get(task.id)) (layers[rank.get(task.id)] ||= []).push(task.id);
  const reviews = new Map(tasks.map(t => [t.id, reviewStatus(stages.get(t.stageId)?.latest)]));
  return { tasks, byId, stages:[...stages.values()], edges, missing, unresolved, layers, reviews,
    counts:{ total:tasks.length, accepted:tasks.filter(t => t.state === 'accepted').length,
      resolved:tasks.filter(t => t.state === 'resolved').length, complete:tasks.filter(terminal).length,
      brain:tasks.filter(t => !terminal(t) && stages.has(t.stageId)).length,
      attention:tasks.filter(t => ['blocked','uncertain'].includes(t.state)).length } };
}

export function matchesTask(task, board, options = {}) {
  const query = (options.query || '').trim().toLocaleLowerCase();
  const text = [task.id, task.title, task.stageId, task.currentWorkerId].join(' ').toLocaleLowerCase();
  return (!query || text.includes(query)) && (!options.goal || task.goalId === options.goal) && (!options.stage || task.stageId === options.stage) &&
    (options.filter === 'active' ? !terminal(task) : options.filter === 'brain' ? !terminal(task) && board.reviews.get(task.id)?.key !== 'draft' : options.filter === 'attention' ? ['blocked','uncertain'].includes(task.state) : true);
}

export const boardMarkup = `
  <section class="board-summary" id="board-summary" aria-label="全部任务进度"></section>
  <section class="panel board-stages"><div class="panel-heading"><div><h2>阶段与大脑终审</h2><p>同一阶段的原任务与补修任务，一起接受整体验收</p></div></div><div id="board-stages"></div></section>
  <section class="panel task-board"><div class="panel-heading"><div><h2>任务全景</h2><p>查看前后依赖，追踪每项任务的审核去向</p></div><span id="task-count" class="subtle" aria-live="polite"></span></div>
  <div class="board-toolbar"><div class="board-views" role="group" aria-label="任务视图"><button type="button" data-board-view="graph" aria-pressed="true">依赖图</button><button type="button" data-board-view="list" aria-pressed="false">任务列表</button></div>
  <input id="task-search" type="search" placeholder="搜索任务、编号或执行员" aria-label="搜索任务">
  <select id="task-goal" aria-label="筛选目标"><option value="">全部目标</option></select>
  <select id="task-stage" aria-label="筛选阶段"><option value="">全部阶段</option></select>
  <select id="task-filter" aria-label="任务显示范围"><option value="all">全部任务</option><option value="active">未完成任务</option><option value="brain">待大脑终审</option><option value="attention">阻塞与异常</option></select>
  <button type="button" id="task-clear">清除筛选</button></div>
  <p class="board-help" id="board-help">箭头表示前置任务 → 后续任务。同层无前后依赖，可并行规划；当前项目仍串行执行。</p>
  <div id="board-selection" class="board-help"></div><div id="board-warning" role="status"></div><div id="tasks"></div><div id="task-detail" class="detail-inline" hidden></div></section>`;

function el(tag, text, cls) {
  const item = document.createElement(tag); if (text !== undefined) item.textContent = text;
  if (cls) item.className = cls; return item;
}
function pill(text, cls = '') { return el('span', text, 'board-pill ' + cls); }
function taskState(task) { return task.stageHeld ? '初审通过' : stateLabels[task.state] || task.state; }
function button(text, action, cls) { const b = el('button', text, cls); b.type = 'button'; b.onclick = action; return b; }

export function renderBoard(root, project, options, actions) {
  const get = id => root.querySelector('#' + id), board = buildBoard(project);
  const goalSelect = get('task-goal'), savedGoal = goalSelect.value;
  goalSelect.replaceChildren(el('option', '全部目标')); goalSelect.firstChild.value = '';
  for (const goal of project.goals || []) { const option = el('option', goal.title); option.value = goal.id; goalSelect.append(option); }
  goalSelect.value = (project.goals || []).some(goal => goal.id === savedGoal) ? savedGoal : '';
  goalSelect.hidden = !project.goals?.length;
  options = { ...options, goal: goalSelect.value };
  const { counts } = board, stageSelect = get('task-stage'), savedStage = stageSelect.value;
  stageSelect.replaceChildren(el('option', '全部阶段'));
  stageSelect.firstChild.value = '';
  for (const s of board.stages) { const o = el('option', s.latest.milestone + ' · ' + s.id); o.value = s.id; stageSelect.append(o); }
  stageSelect.value = board.stages.some(s => s.id === savedStage) ? savedStage : '';
  options = { ...options, stage:stageSelect.value };
  const summary = get('board-summary'); summary.replaceChildren();
  for (const [title, value, note] of [['全部任务', counts.total, '包含原任务、补修及未登记草案'], ['已验收', counts.accepted, `另有 ${counts.resolved} 项由后续任务解决`], ['待大脑终审', counts.brain, '已纳入阶段、尚未最终验收'], ['阻塞与异常', counts.attention, '需要处置后继续推进']]) {
    const item = el('div', undefined, 'board-metric'); item.append(el('span', title), el('strong', value), el('small', note)); summary.append(item);
  }
  const progress = el('div', undefined, 'board-progress'), bar = el('progress'); bar.max = counts.total || 1; bar.value = counts.complete; bar.setAttribute('aria-label', '全部任务完成进度');
  progress.append(el('span', `整体完成 ${counts.complete} / ${counts.total}`), bar, el('span', `${counts.total ? Math.round(counts.complete / counts.total * 100) : 0}%`)); summary.append(progress);
  const stages = get('board-stages'); stages.replaceChildren();
  for (const group of board.stages) {
    const r = group.latest, status = reviewStatus(r), item = el('article', undefined, 'board-stage');
    const title = el('div'); title.append(el('strong', r.milestone), el('small', `${group.id} · 第 ${r.round || group.rounds.length} 轮 · ${r.id}`));
    const passed = [...group.taskIds].filter(id => board.byId.get(id)?.stageHeld || terminal(board.byId.get(id))).length;
    item.append(title, pill(status.text, 'brain ' + status.key), el('span', `累计 ${group.taskIds.size} 项 · 初审通过/已终结 ${passed} 项 · 本轮 ${r.members.length} 项`, 'board-stage-count'));
    item.append(button('查看任务', () => actions.stage(group.id), 'board-link'));
    if (r.issues?.length) item.append(el('p', `${r.issues.length} 个终审问题：${r.issues.map(i => i.message).join('；')}`, 'board-stage-issues'));
    stages.append(item);
  }
  if (!board.stages.length) stages.append(el('p', '尚未登记阶段。任务草案纳入阶段后，将统一交由大脑终审。', 'board-help'));
  const matching = new Set(board.tasks.filter(t => matchesTask(t, board, options)).map(t => t.id));
  get('task-count').textContent = `全部 ${counts.total} 项 · 匹配 ${matching.size} 项`;
  root.querySelectorAll('[data-board-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.boardView === options.view)));
  const selection = get('board-selection'); selection.replaceChildren();
  if (board.byId.has(options.selected)) {
    selection.append(el('span', '已选中 ' + options.selected + ' · ' + board.byId.get(options.selected).title + ' '), button('查看审核详情', () => get('task-detail').scrollIntoView({ block:'start' }), 'board-link'));
  }
  const warning = get('board-warning'); warning.replaceChildren();
  if (board.missing.length) warning.append(el('p', '缺失前置任务：' + board.missing.map(e => `${e.from} → ${e.to}`).join('；'), 'board-error'));
  if (board.unresolved.length) warning.append(el('p', '以下任务因循环、缺失前置或受其影响，无法分层：' + board.unresolved.join('、'), 'board-error'));
  const focusedId = document.activeElement?.closest('.board-task')?.dataset.taskId;
  const container = get('tasks'), scrollLeft = container.scrollLeft, scrollTop = container.scrollTop;
  container.tabIndex = options.view === 'graph' ? 0 : -1;
  container.setAttribute('aria-label', options.view === 'graph' ? '任务依赖图，可横向滚动查看后续任务' : '任务列表');
  container.className = options.view === 'graph' ? 'board-graph-scroll' : 'board-list'; container.replaceChildren();
  if (!counts.total) { container.append(el('div', '尚无任务。大脑登记完整计划后，这里显示全部任务和依赖关系。', 'empty')); return board; }
  if (!matching.size) container.append(el('p', '没有匹配的任务。可清除筛选查看全部任务。', 'board-help'));
  const related = new Set([options.selected]);
  for (const e of board.edges) if ([e.from, e.to].includes(options.selected)) { related.add(e.from); related.add(e.to); }
  function card(id, graph) {
    const task = board.byId.get(id), review = board.reviews.get(id);
    const item = el('article', undefined, 'board-task' + (id === options.selected ? ' is-selected' : '') + (!matching.has(id) ? ' is-filtered' : '') + (options.selected && related.has(id) ? ' is-related' : ''));
    item.dataset.taskId = id;
    const heading = button(undefined, () => actions.select(id), 'board-task-heading');
    heading.append(el('small', id), el('strong', task.title)); heading.title = `${id} · ${task.title}`;
    heading.setAttribute('aria-label', `查看任务 ${id}：${task.title}`); item.append(heading);
    const badges = el('div', undefined, 'board-task-badges'); badges.append(pill(taskState(task), ['blocked','uncertain'].includes(task.state) ? 'danger' : terminal(task) ? 'passed' : ''), pill(review.text, 'brain ' + review.key)); item.append(badges);
    item.append(el('small', `${task.stageId || '未登记阶段'} · 执行员 ${task.currentWorkerId || 'default'}`, 'board-task-meta'));
    if (graph) { const deps = el('small', '前置：' + ((task.dependsOn || []).join('、') || '无'), 'board-task-meta'); deps.title = deps.textContent; item.append(deps); }
    if (!graph) {
      const deps = el('div', undefined, 'board-dependencies'); deps.append(el('span', '前置：'));
      for (const dep of task.dependsOn || []) deps.append(byLink(dep));
      if (!task.dependsOn?.length) deps.append(el('span', '无'));
      const next = board.edges.filter(e => e.from === id).map(e => e.to); deps.append(el('span', '后续：'));
      for (const dep of next) deps.append(byLink(dep)); if (!next.length) deps.append(el('span', '无')); item.append(deps);
      const buttons = actions.taskActions?.(task); if (buttons) item.append(buttons);
    }
    return item;
  }
  function byLink(id) { return board.byId.has(id) ? button(id, () => actions.select(id), 'board-link') : el('span', id + '（缺失）', 'board-error'); }
  if (options.view === 'list') for (const t of board.tasks) { if (matching.has(t.id)) container.append(card(t.id, false)); }
  else {
    const layers = [...board.layers]; if (board.unresolved.length) layers.push(board.unresolved);
    const width = layers.length * 316 + 32, height = Math.max(...layers.map(l => l.length), 1) * 190 + 64;
    const canvas = el('div', undefined, 'board-canvas'); canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    const positions = new Map();
    layers.forEach((ids, col) => {
      const unresolved = col === layers.length - 1 && board.unresolved.length;
      const label = el('div', (unresolved ? '依赖异常' : `依赖层 ${col + 1}`) + ` · ${ids.length} 项` + (ids.length > 1 && !unresolved ? ' · 可并行规划' : ''), 'board-layer'); label.style.left = 24 + col * 316 + 'px'; canvas.append(label);
      ids.forEach((id, row) => { const x = 24 + col * 316, y = 52 + row * 190, item = card(id, true); item.style.left = x + 'px'; item.style.top = y + 'px'; positions.set(id, { x, y }); canvas.append(item); });
    });
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('aria-hidden', 'true');
    for (const edge of board.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
      const x1 = from.x + 264, y1 = from.y + 78, x2 = to.x - 4, y2 = to.y + 78;
      const path = document.createElementNS(ns, 'path'), tip = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`);
      tip.setAttribute('d', `M ${x2 - 6} ${y2 - 4} L ${x2} ${y2} L ${x2 - 6} ${y2 + 4}`);
      for (const p of [path, tip]) { p.setAttribute('class', 'board-edge' + ([edge.from, edge.to].includes(options.selected) ? ' is-highlighted' : '')); svg.append(p); }
    }
    canvas.prepend(svg); container.append(canvas);
  }
  container.scrollLeft = scrollLeft; container.scrollTop = scrollTop;
  if (focusedId) [...container.querySelectorAll('.board-task')].find(e => e.dataset.taskId === focusedId)?.querySelector('.board-task-heading')?.focus({ preventScroll:true });
  return board;
}
