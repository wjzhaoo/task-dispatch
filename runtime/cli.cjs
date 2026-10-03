#!/usr/bin/env node
// [AI-added] 2026-09-12 11:00
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomic, read, Store } = require('./core/storage.cjs');
async function main() {
  const args = process.argv.slice(2);
  // [AI-added] 2026-09-17 11:46
  let root;
  const i = args.indexOf('--data');
  if (i >= 0) { if (!args[i + 1]) throw Error('--data requires directory'); root = path.resolve(args[i + 1]); args.splice(i, 2); }
  const [command, a, b] = args;
  if (!command || command === 'help' || command === '--help') {
    console.log(`Task Dispatch (Node >=22)
  init --data DIRECTORY                   create enabled configuration
  start                                  foreground service, no autostart
  status                                 inspect tasks, errors and events
  add-project PROJECT.json               register unique workspace/role profiles
  add-task PROJECT_ID TASK.json           queue a bounded task
  pause PROJECT_ID | resume PROJECT_ID    control future dispatch
  retry PROJECT_ID TASK_ID [--confirmed-stopped] [--restart-worker]
  budget PROJECT_ID MAX_ATTEMPTS|off      optional project cumulative protection
  task-budget PROJECT_ID TASK_ID ADD --reason TEXT  extend task attempt allowance
  configure-validation PROJECT_ID FILE.json  configure independent review checks
  configure-snapshot PROJECT_ID FILE.json   project exclusions and byte limits
  configure-storage FILE.json               retention, automatic cleanup and disk budget
  cleanup-preview | cleanup-apply PREVIEW_ID
  usage [PROJECT_ID] | record-usage FILE.json
  collect-usage                            refresh observed Codex log usage
  Desktop brain controls (desktop-client.cjs --credential FILE --data DIRECTORY):
    activity-start --activity ID --kind planning|troubleshooting|other --source TEXT
    activity-end --activity ID [--usage-file FILE]
    stage-register --file FILE
    stage-submit --file FILE
    stage-resume --round ID
  finish-project PROJECT_ID | reopen-project PROJECT_ID
  prepare-review PROJECT_ID TASK_ID EVIDENCE_FILE.txt
  return-scope PROJECT_ID TASK_ID          return legacy scope rejection to original worker
  reconcile-review PROJECT_ID TASK_ID CONFIG.json  reconcile inspected scope conflict into review
  configure-repair PROJECT_ID TASK_ID REPAIR.json   set authorized repair instructions at blocked boundary
  stop                                   interrupt agents and persist state
  unlock                                 remove lock only if owner PID is gone
  doctor                                 inspect configuration and executable paths
All commands require --data DIRECTORY. New configurations enable real calls; set config.enableRealCalls=false to pause headless dispatch.`); return;
  }
  // [AI-added] 2026-09-17 11:46
  if(!root)throw Error('--data DIRECTORY is required; no user-level public service is created');
  if (command === 'init') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'config.json');
    if (fs.existsSync(file)) throw Error('Configuration already exists; not overwriting');
    const codexJS = path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex/bin/codex.js');
    // [AI-added] 2026-09-14 09:43
/* Previous implementation:
atomic(file, { version: 1, enableRealCalls: false, maxConcurrent: 2, profiles: {
*/
atomic(file, { version: 1, enableRealCalls: true, maxConcurrent: 2, profiles: {
      codex: { adapter: 'codex', command: fs.existsSync(codexJS) ? process.execPath : 'codex', args: fs.existsSync(codexJS) ? [codexJS, 'app-server'] : ['app-server'] },
      // [AI-added] 2026-09-14 09:43
/* Previous implementation:
zcode: { adapter: 'zcode', command: 'zcode', args: ['app-server', '--stdio'], experimentalProtocolAcknowledged: false }
*/
zcode: { adapter: 'zcode', command: 'zcode', args: ['app-server', '--stdio'], experimentalProtocolAcknowledged: true }
    } });
    console.log('Created enabled configuration: ' + file); return;
  }
  if (command === 'unlock') { Store.unlock(root); console.log('Stale lock removed'); return; }
  if (command === 'doctor') {
    const c = read(path.join(root, 'config.json')); require('./server.cjs').validateConfig(c);
    console.log(JSON.stringify({ node: process.version, data: root, enableRealCalls: c.enableRealCalls, profiles: Object.fromEntries(Object.entries(c.profiles).map(([k, p]) => [k, { adapter: p.adapter, command: p.command, executableExists: path.isAbsolute(p.command) ? fs.existsSync(p.command) : 'PATH lookup required', experimentalProtocolAcknowledged: p.experimentalProtocolAcknowledged }])) }, null, 2)); return;
  }
  if (command === 'start') {
    // [AI-added] 2026-09-16: Web launcher requests a stable uncommon port; tests may keep ephemeral ports.
    const portIndex = args.indexOf('--port');
    const port = portIndex < 0 ? 0 : Number(args[portIndex + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid --port');
    const service = await require('./server.cjs').serve(root, { port, logger: entry => console.log(JSON.stringify(entry)) });
    const stop = () => { service.close().catch(e => { console.error(e.message); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  const endpoint = read(path.join(root, 'endpoint.json')), token = fs.readFileSync(path.join(root, 'admin-token'), 'utf8').trim();
  let body;
  if (command === 'add-project') body = { action: command, project: read(a) };
  else if (command === 'add-task') body = { action: command, projectId: a, task: read(b) };
  else if (command === 'budget') body = { action: command, projectId: a, maxTurns: b==='off'?null:Number(b) };
  else if (command === 'task-budget') body = {action:command,projectId:a,taskId:b,additionalAttempts:Number(args[3]),reason:args[args.indexOf('--reason')+1] && args.includes('--reason')?args[args.indexOf('--reason')+1]:undefined};
  else if (command === 'configure-validation') body = {action:command,projectId:a,config:read(b),profileName:args.includes('--profile')?args[args.indexOf('--profile')+1]:undefined};
  else if (command === 'configure-snapshot') body = {action:command,projectId:a,config:read(b)};
  else if (command === 'configure-storage') body = {action:command,config:read(a)};
  else if (command === 'cleanup-preview') body = {action:command};
  else if (command === 'cleanup-apply') body = {action:command,previewId:a};
  else if (command === 'usage') body = {action:command,projectId:a};
  else if (command === 'collect-usage') body = {action:command};
  else if (command === 'record-usage') body = {...read(a),action:command};
  else if (command === 'prepare-review') body = {action:command,projectId:a,taskId:b,evidence:fs.readFileSync(args[3],'utf8')};
  else if (command === 'configure-repair') body = {action:command,projectId:a,taskId:b,config:read(args[3])};
  else if (command === 'reconcile-review') body = {action:command,projectId:a,taskId:b,config:read(args[3])};
  else if (['return-scope','pause', 'resume', 'retry', 'stop','finish-project','reopen-project'].includes(command)) body = { action: command, projectId: a, taskId: b, confirmedStopped: args.includes('--confirmed-stopped'), restartWorker: args.includes('--restart-worker') };
  else if (command !== 'status') throw Error('Unknown command: ' + command);
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/${command === 'status' ? 'status' : 'command'}`, { method: command === 'status' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
