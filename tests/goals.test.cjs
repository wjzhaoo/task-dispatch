'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Store, sha } = require('../runtime/core/storage.cjs');
const { Dispatcher } = require('../runtime/core/dispatcher.cjs');
const { Desktop } = require('../runtime/core/desktop.cjs');
const { Wake } = require('../runtime/core/wake.cjs');
const goals = require('../runtime/core/goals.cjs'), setup = require('../runtime/core/project-setup.cjs'), stages = require('../runtime/core/stage-review.cjs');

function fixture(t) {
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('tmp/goals-')), workspace = path.join(dir, 'work'); fs.mkdirSync(workspace);
  const store = new Store(path.join(dir, 'service')), d = new Dispatcher(store,{maxConcurrent:2});
  const desktop = new Desktop(d), adapter = { read: async b => ({ thread: { id: b.threadId, cwd: workspace, status: { type: 'idle' } }, turns: [] }), send: async () => ({}) };
  const wake = new Wake(desktop, adapter);
  t.after(async () => { await wake.close(); await d.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const create = (extra = {}) => {
    const result = setup.create(d, { commandId: crypto.randomUUID(), workspace, title: '新增目标', objective: '实现并通过阶段验收', ...extra });
    if (extra.startMode !== 'manual' && setup.team(desktop, store.state.projects[result.projectId]).ready === 3) goals.authorize(d, result.projectId, result.goalId, true);
    return result;
  };
  const first = create(), projectId = first.projectId, p = () => store.state.projects[projectId], identities = {};
  async function connect() {
    for (const role of ['brain', 'reviewer', 'worker']) {
      identities[role] = desktop.attach({ workspace, role, clientId: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), sessionId: role,
        ...(role === 'worker' ? { workerId: 'default', capabilities: ['general'] } : {}), joinInvitationId: setup.joinId(p(), role) });
      await wake.bind(identities[role], { provider: 'codex', threadId: role, turnId: 'test-turn' });
    }
    for (const role of ['brain', 'reviewer', 'worker']) wake.park(identities[role]);
    d.tick();
    assert.equal(p().activeGoalId, null);
    assert.equal(p().planning, undefined);
    goals.authorize(d, projectId, first.goalId, true); d.tick();
  }
  async function drain() { for (let i = 0; i < 15; i++) { await Promise.all([...d.active.values()].map(value => value.promise)); d.tick(); if (!d.active.size) return; } assert.fail('Dispatcher did not drain'); }
  async function passGoal(taskId) {
    desktop.claim(identities.brain);
    desktop.plan(identities.brain, { id: taskId, title: taskId, instructions: '实现目标', acceptance: '文件正确', allowedPaths: [taskId + '.txt'], workerId: 'default', requiredCapability: 'general' });
    stages.register(desktop, identities.brain, { stageId: 's-' + taskId, roundId: 'r-' + taskId, milestone: taskId, acceptance: '实现及集成正确', members: [{ taskId }] });
    await drain();
    const worker = desktop.claim(identities.worker); assert.equal(worker.taskId, taskId);
    fs.writeFileSync(path.join(workspace, taskId + '.txt'), taskId, 'utf8');
    desktop.submit(identities.worker, { taskId, attemptId: worker.attemptId, result: { projectId, taskId, attemptId: worker.attemptId, role: 'worker', status: 'submitted', summary: 'implemented', checks: [], unverified: [] } });
    await drain(); wake.park(identities.worker);
    const reviewer = desktop.claim(identities.reviewer); assert.equal(reviewer.taskId, taskId);
    desktop.submit(identities.reviewer, { taskId, attemptId: reviewer.attemptId, result: { projectId, taskId, attemptId: reviewer.attemptId, role: 'reviewer', artifactId: reviewer.artifactId, verdict: 'pass', summary: 'checked', findings: [] } });
    await drain(); wake.park(identities.reviewer);
    const brain = desktop.claim(identities.brain); assert.equal(brain.kind, 'stage_review');
    stages.submit(desktop, identities.brain, { roundId: brain.roundId, attemptId: brain.attemptId, result: require('./stage-fixture.cjs').finalResult(brain) });
    await drain(); desktop.claim(identities.brain);
  }
  return { dir, workspace, store, d, desktop, wake, create, first, p, identities, connect, drain, passGoal };
}

test('one directory keeps its team and creates an ordered goal queue; saved goals need explicit authorization', async t => {
  const x = fixture(t); assert.equal(x.p().staffing.workers.length, 1); assert.equal(setup.team(x.desktop, x.p()).total, 3);
  await x.connect(); assert.equal(x.p().activeGoalId, x.first.goalId);
  const planningId = x.p().planning.id, staffing = structuredClone(x.p().staffing), bindings = structuredClone(x.p().bindings);
  const second = x.create({ title: '第二目标', workers: [{ workerId: 'ignored', capability: 'strong', responsibilities: '不能覆盖活动团队' }] });
  const draft = x.create({ title: '仅保存', startMode: 'manual' }), third = x.create({ title: '第三目标' });
  assert.equal(second.projectId, x.first.projectId); assert.deepEqual(x.p().goalQueue, [second.goalId, third.goalId]);
  assert.equal(x.p().goals[draft.goalId].state, 'draft'); assert.equal(x.p().goals[draft.goalId].startAuthorizedAt, null);
  assert.equal(x.p().planning.id, planningId); assert.deepEqual(x.p().staffing, staffing); assert.deepEqual(x.p().bindings, bindings);
  assert.throws(() => goals.authorize(x.d, x.p().id, draft.goalId, false), /明确授权/);
  goals.authorize(x.d, x.p().id, draft.goalId, true); goals.authorize(x.d, x.p().id, draft.goalId, true);
  assert.deepEqual(x.p().goalQueue, [second.goalId, third.goalId, draft.goalId]);
  goals.cancel(x.d, x.p().id, third.goalId); assert.equal(goals.cancel(x.d, x.p().id, third.goalId).duplicate, true);
  assert.deepEqual(x.p().goalQueue, [second.goalId, draft.goalId]);
  assert.throws(() => goals.cancel(x.d, x.p().id, x.first.goalId), /尚未开始/);
  assert.throws(() => x.desktop.staff(x.identities.brain, { staffing: { workers: setup.defaultWorkers() } }), /活动目标/);
  assert.throws(() => x.d.finishProject(x.p().id), /未完成目标/);
});

test('two real stages finish two goals in order while retaining the same bindings and all review evidence', async t => {
  const x = fixture(t); await x.connect();
  const bindings = Object.fromEntries(Object.entries(x.p().bindings).map(([key, b]) => [key, b.clientId]));
  const second = x.create({ title: '第二目标' });
  assert.throws(() => x.desktop.finishGoal(x.identities.worker, { goalId: x.first.goalId, summary: 'not allowed' }), /Only brain/);
  assert.throws(() => x.desktop.finishGoal(x.identities.brain, { goalId: x.first.goalId, summary: 'empty is not done' }), /未完成/);
  await x.passGoal('A');
  const contract = x.p().reviewStages['r-A'].contractHash, artifact = x.p().tasks.A.artifactId;
  assert.equal(x.p().tasks.A.goalId, x.first.goalId); assert.equal(x.p().reviewStages['r-A'].goalId, x.first.goalId);
  x.desktop.finishGoal(x.identities.brain, { goalId: x.first.goalId, summary: '第一目标通过完整阶段终审' });
  x.wake.park(x.identities.brain); x.d.tick();
  assert.equal(x.p().goals[x.first.goalId].state, 'completed'); assert.equal(x.p().activeGoalId, second.goalId);
  const reset = { action: 'reset-task', projectId: x.p().id, taskId: 'A', confirmText: 'A', confirmed: true, confirmedStopped: true, reason: '检查历史目标重置' };
  const admin = { d: x.d, monitor: { wake: { busy: false } } };
  assert.throws(() => require('../runtime/core/lifecycle.cjs').apply(admin, reset), /另一个目标活动/);
  const planningId = x.p().planning.id;
  assert.equal(x.desktop.finishGoal(x.identities.brain, { goalId: x.first.goalId, summary: 'repeat' }).duplicate, true);
  assert.equal(x.p().planning.id, planningId);
  assert.throws(() => x.desktop.plan(x.identities.brain, { ...x.p().tasks.A }), /其他目标/);
  await x.passGoal('B');
  x.desktop.finishGoal(x.identities.brain, { goalId: second.goalId, summary: '第二目标通过完整阶段终审' });
  assert.equal(x.wake.park(x.identities.brain).parked, true); x.d.tick();
  assert.equal(x.p().activeGoalId, null); assert.equal(x.p().completedAt, undefined); assert.equal(x.p().planning, undefined);
  assert.equal(x.p().reviewStages['r-A'].contractHash, contract); assert.equal(x.p().tasks.A.artifactId, artifact);
  assert.deepEqual(Object.fromEntries(Object.entries(x.p().bindings).map(([key, b]) => [key, b.clientId])), bindings);
  x.d.finishProject(x.p().id); assert.ok(x.p().completedAt);
  require('../runtime/core/lifecycle.cjs').apply(admin, reset);
  assert.equal(x.p().tasks.A.goalId, x.first.goalId); assert.equal(x.p().activeGoalId, x.first.goalId); assert.equal(x.p().goals[x.first.goalId].state, 'active');
  assert.equal(x.p().goals[second.goalId].state, 'completed'); assert.equal(x.p().paused, true); assert.equal(x.p().reviewStages['r-A'].state, 'reset');
});

test('blocked goals hold the queue; tasks and stages cannot be registered against a different goal', async t => {
  const x = fixture(t); await x.connect(); const second = x.create();
  const job = x.desktop.claim(x.identities.brain);
  x.desktop.closeout(x.identities.brain, { planningId: job.planningId, outcome: 'blocked', summary: '缺少输入', planEvidence: '已检查项目', reason: '需要设计输入' });
  assert.equal(x.p().goals[x.first.goalId].state, 'blocked'); assert.equal(x.p().activeGoalId, x.first.goalId);
  const task = { id: 'T', title: 'T', instructions: 'implement', acceptance: 'correct', allowedPaths: ['T.txt'], workerId: 'default', requiredCapability: 'general' };
  assert.throws(() => x.desktop.plan(x.identities.brain, { ...task, goalId: second.goalId }), /其他目标/);
  x.desktop.plan(x.identities.brain, task);
  assert.throws(() => stages.register(x.desktop, x.identities.brain, { goalId: second.goalId, stageId: 's', roundId: 'r', milestone: 'T', acceptance: 'correct', members: [{ taskId: 'T' }] }), /其他目标/);
  x.store.change(s => { s.projects[x.p().id].tasks.T.goalId = second.goalId; });
  assert.throws(() => stages.register(x.desktop, x.identities.brain, { stageId: 's', roundId: 'r', milestone: 'T', acceptance: 'correct', members: [{ taskId: 'T' }] }), /其他目标/);
  x.store.change(s => { s.projects[x.p().id].tasks.T.goalId = x.first.goalId; });
  assert.throws(() => x.desktop.finishGoal(x.identities.brain, { summary: 'not complete' }), /未完成/);
  assert.equal(x.p().goals[second.goalId].state, 'queued');
});

test('idle team edits keep existing sessions; a generic default worker does not claim a strong model capability', async t => {
  const x = fixture(t);
  goals.cancel(x.d, x.p().id, x.first.goalId);
  setup.configureTeam(x.desktop, x.p().id, [{ workerId: 'default', capability: 'general', responsibilities: '通用实现' }, { workerId: 'extra', capability: 'strong', responsibilities: '关键实现' }]);
  assert.equal(setup.team(x.desktop, x.p()).total, 4);
  const worker = x.desktop.attach({ workspace: x.workspace, role: 'worker', clientId: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), capabilities: [], joinInvitationId: setup.joinId(x.p(), 'worker') });
  const bindings = structuredClone(x.p().bindings);
  assert.throws(() => setup.configureTeam(x.desktop, x.p().id, [{ workerId: 'default', capability: 'strong', responsibilities: '强模型' }]), /显式改绑/);
  setup.configureTeam(x.desktop, x.p().id, setup.defaultWorkers());
  assert.deepEqual(x.p().bindings, bindings); assert.equal(x.p().bindings.worker.clientId, worker.clientId);
  x.d.finishProject(x.p().id); assert.ok(x.p().completedAt);
});

test('incomplete managed projects are rejected without rewriting state',t=>{
 const x=fixture(t),before=fs.readFileSync(x.store.file);
 assert.throws(()=>x.store.change(state=>delete state.projects[x.p().id].goals),/Unsupported managed project/);
 assert.deepEqual(fs.readFileSync(x.store.file),before);
 assert.throws(()=>x.store.change(state=>state.projects[x.p().id].goals[x.first.goalId].legacy=true),/Unsupported goal/);
 assert.deepEqual(fs.readFileSync(x.store.file),before);
});

test('adding a web goal never adopts an unmanaged executing project',async t=>{
 const x=await require('./stage-fixture.cjs').setup(t);x.task('A');x.register(x.definition(['A']));
 const before=structuredClone(x.p()),revision=x.store.state.revision;
 assert.throws(()=>setup.create(x.d,{commandId:crypto.randomUUID(),workspace:x.workspace,title:'目标',objective:'完成并验收'}),/Unsupported managed project/);
 assert.deepEqual(x.p(),before);assert.equal(x.store.state.revision,revision);
});

test('accepted tasks without a passed stage cannot finish a goal',async t=>{
 const x=fixture(t);await x.connect();
 x.desktop.plan(x.identities.brain,{id:'A',title:'A',instructions:'实现',acceptance:'正确',allowedPaths:['A.txt'],workerId:'default',requiredCapability:'general'});
 x.store.change(state=>state.projects[x.p().id].tasks.A.state='accepted');
 assert.throws(()=>x.desktop.finishGoal(x.identities.brain,{summary:'已完成'}),/必须通过完整阶段终审/);
});
