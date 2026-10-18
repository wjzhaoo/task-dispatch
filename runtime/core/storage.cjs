// [AI-added] 2026-09-12 11:00
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const id = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function readableName(value, fallback = 'project') {
  const name = Array.from(path.basename(path.resolve(value)).normalize('NFKC')).map(character => {
    if (/[a-zA-Z0-9]/.test(character)) return character.toLowerCase();
    if (/^[\p{Letter}\p{Number}]$/u.test(character)) return `-u${character.codePointAt(0).toString(16)}-`;
    return '-';
  }).join('').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return name || fallback;
}
function workspaceKey(workspace) {
  const dir = path.resolve(workspace);
  return `${readableName(dir)}-${sha(dir.toLowerCase()).slice(0, 8)}`;
}
function desktopProjectId(workspace) { return `desktop-${workspaceKey(workspace)}`; }
// [AI-added] 2026-09-22 09:20: Only rename contention is automatically retryable.
class StorageWriteError extends Error {
  constructor(cause,file,tmp,retryable){super(cause.message,{cause});this.name='StorageWriteError';this.code=cause.code;this.file=file;this.temporaryFile=tmp;this.retryable=retryable;}
}
function atomic(file, value, options = {}) {
  const io=options.io||fs,wait=options.wait||(ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms));
  const tmp = `${file}.${id()}.tmp`;let phase='write',complete=false;
  try {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const fd = io.openSync(tmp, 'wx', 0o600);
    try { io.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    complete=true;phase='rename';
    const delays=[20,60,120];
    for(let n=0;;n++){
      try{io.renameSync(tmp,file);return;}
      catch(e){if(!['EPERM','EBUSY'].includes(e.code)||n===delays.length)throw e;wait(delays[n]);}
    }
  }catch(e){
    // A complete failed replacement is retained for diagnosis; never remove the target.
    if(!complete){try{io.unlinkSync(tmp);}catch{}}
    throw new StorageWriteError(e,file,tmp,phase==='rename'&&['EPERM','EBUSY'].includes(e.code));
  }
}
function atomicChanged(file,value) {
  if(fs.existsSync(file)&&JSON.stringify(read(file))===JSON.stringify(value))return false;
  atomic(file,value);return true;
}
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function overlaps(a, b) {
  const inside = (x, y) => { const r = path.relative(x, y); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
  return inside(a, b) || inside(b, a);
}
function plainDirectory(dir) {
  const abs = path.resolve(dir);
  for (let p = abs; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('Symlink/junction directory is not supported: ' + p);
    if (p === path.dirname(p)) break;
  }
  if (!fs.statSync(abs).isDirectory()) throw Error('Not a directory: ' + abs);
  return fs.realpathSync(abs);
}
function validateState(state) {
  if (!state || state.version !== 2 || !state.projects || !Array.isArray(state.events) || !Number.isSafeInteger(state.revision)) throw Error('Unsupported/corrupt state: version-2 service data is required; old data is not migrated');
  const { workerId } = require('./bindings.cjs'), { limit } = require('./attempts.cjs');
  const { normalizeProvider } = require('./platforms.cjs');
  for (const p of Object.values(state.projects)) {
    if (p.mode !== 'desktop' || !p.tasks || typeof p.projectBudgetEnabled !== 'boolean' || !Number.isSafeInteger(p.turns)) throw Error('Unsupported project structure: ' + p.id);
    if (p.maxTurns !== null) limit(p.maxTurns);
    if (p.webSetup && (!p.goals || Array.isArray(p.goals) || !Array.isArray(p.goalQueue) || !p.staffing || !Array.isArray(p.staffing.workers) || !p.webSetup.invitations)) throw Error('Unsupported managed project structure: ' + p.id);
    for (const goal of Object.values(p.goals || {})) if (goal.legacy || goal.legacyFingerprint) throw Error('Unsupported goal structure: ' + goal.id);
    for (const round of Object.values(p.reviewStages || {})) {
      if (!Array.isArray(round.members) || !Array.isArray(round.reviewTaskIds) || round.members.some(m => !round.reviewTaskIds.includes(m.taskId))) throw Error('Unsupported stage review structure: ' + round.id);
    }
    for (const b of [...Object.values(p.bindings || {}),...Object.values(p.handovers || {}).filter(b=>b.connection).map(b=>({...b,...b.connection}))]) {
      for (const provider of [b.provider, b.wake?.provider]) normalizeProvider(provider);
      if (b.wake && (!b.wake.provider || !require('./platforms.cjs').WAKE_PROVIDERS.includes(b.wake.provider))) throw Error('Wake binding requires an explicit supported provider');
      if (b.wake && (!b.sessionId || b.sessionId !== b.wake.threadId)) throw Error('Wake session differs from connected session');
      if (b.wake && b.provider !== b.wake.provider) throw Error('Wake provider differs from connected provider');
      if (b.continuation && !b.provider) throw Error('Unsupported connection structure: explicit provider is required');
      if (b.wake?.provider === 'qoder' && b.wake.descriptorPath !== undefined && (typeof b.wake.descriptorPath !== 'string' || !path.isAbsolute(b.wake.descriptorPath) || path.basename(b.wake.descriptorPath) !== 'task-dispatch-bridge.json')) throw Error('Invalid Qoder bridge descriptor path');
      if (b.wake?.provider === 'qoder' && !b.wake.workspace) throw Error('Qoder binding workspace is required');
    }
    for (const task of Object.values(p.tasks)) {
      if (!Object.hasOwn(task, 'plannedRequiredCapability') || !task.plannedWorkerId || !task.currentWorkerId || !Array.isArray(task.attempts)) throw Error('Unsupported task structure: ' + task.id);
      if (task.reviewOnly || task.repairAuthorized || ['existing-candidate','operator-reconciled'].includes(task.reviewMode)) throw Error('Unsupported imported review task: ' + task.id);
      if (!Number.isSafeInteger(task.contractRevision) || task.contractRevision < 1) throw Error('Unsupported task contract revision: ' + task.id);
      limit(task.maxAttempts); workerId(task.plannedWorkerId); workerId(task.currentWorkerId);
      for (const run of task.attempts) {
        if (!Number.isSafeInteger(run.contractRevision) || run.contractRevision < 1) throw Error('Unsupported attempt contract revision: ' + run.id);
        if (run.snapshotPolicy) require('./snapshot.cjs').frozenPolicy(run.snapshotPolicy);
      }
    }
  }
  return state;
}
class Store {
  constructor(root) {
    require('./data-root.cjs').assertServiceRoot(root);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = plainDirectory(root);
    this.lock = path.join(this.root, 'service.lock');
    this.file = path.join(this.root, 'state.json');
    this.owner = id();
    try { fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, owner: this.owner }), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw Error('Service lock exists. Use unlock only after its process has exited.');
    }
    try {
      this.state = fs.existsSync(this.file) ? read(this.file) : { version: 2, revision: 0, projects: {}, events: [] };
      validateState(this.state);
      if (!fs.existsSync(this.file)) atomic(this.file, this.state);
    } catch (e) { this.close(); throw e; }
  }
  change(fn) { return this.transaction(() => fn(this.state)); }
  transaction(fn) {
    if (this.batching) return fn();
    const previous = this.state;
    this.state = structuredClone(previous); this.batching = true;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw Error('State transactions must be synchronous');
      validateState(this.state);
      if (JSON.stringify(this.state) !== JSON.stringify(previous)) {
        this.state.revision = previous.revision + 1;
        atomic(this.file, this.state);
        this.batching = false;
        try { this.onCommit?.(this.state); } catch (error) { this.observationError = error.message; }
      } else this.state = previous;
      return result;
    } catch (error) { this.state = previous; throw error; }
    finally { this.batching = false; }
  }
  event(state, type, data = {}) { state.events.push({ id: id(), at: new Date().toISOString(), type, ...data }); }
  close() {
    if (fs.existsSync(this.lock) && read(this.lock).owner === this.owner) fs.unlinkSync(this.lock);
  }
  static unlock(root) {
    const file = path.join(root, 'service.lock');
    const lock = read(file);
    if (!Number.isInteger(lock.pid) || alive(lock.pid)) throw Error('Owner is alive or lock is ambiguous; do not unlock');
    fs.unlinkSync(file);
  }
}
module.exports = { Store, validateState, atomic, atomicChanged, StorageWriteError, read, id, sha, readableName, workspaceKey, desktopProjectId, overlaps, plainDirectory, alive };
