#!/usr/bin/env node
// [AI-added] 2026-09-15 18:52
'use strict';
// task-dispatch hook entry for Qoder / QoderCN.
//
// The installer registers this script for SessionStart, UserPromptSubmit and Stop.
// Qoder feeds the event JSON on stdin and honours the exit code: 0 continues, 2
// blocks and feeds stderr back to the model. The Stop handler is registered with
// asyncRewake, so while the session is parked this process keeps watching the
// service wake slot and exits 2 only when a real task was published for this very
// session.
//
// stdout carries JSON only, diagnostics go to stderr, and every failure path exits
// 0: a broken hook must never block the host IDE.
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  if (message) process.stderr.write('[task-dispatch-qoder] ' + message + '\n');
  process.exit(0);
}
function options(argv) {
  const result = { event: null, data: null, configDir: null, seconds: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') result.data = argv[++i];
    else if (arg.startsWith('--data=')) result.data = arg.slice(7);
    else if (arg === '--config-dir') result.configDir = argv[++i];
    else if (arg.startsWith('--config-dir=')) result.configDir = arg.slice('--config-dir='.length);
    else if (arg === '--seconds') result.seconds = Number(argv[++i]);
    else if (arg.startsWith('--seconds=')) result.seconds = Number(arg.slice('--seconds='.length));
    else if (!arg.startsWith('-') && !result.event) result.event = arg;
  }
  return result;
}
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
// The runtime path is recorded by the installer link file; the hook never invents
// paths and never reads a credential token.
function loadCore(linkFile) {
  const link = JSON.parse(fs.readFileSync(linkFile, 'utf8'));
  if (![1, 2].includes(link.version) || typeof link.client !== 'string' || !path.isAbsolute(link.client)) throw Error('Invalid runtime link');
  // [AI-added] 2026-09-16 16:00
  const runtime = path.dirname(link.client);
  return { core: require(path.join(runtime, 'adapters', 'qoder-wake.cjs')), dataRoots: require(path.join(runtime, 'core', 'data-root.cjs')), link };
}
async function main() {
  const argv = options(process.argv.slice(2));
  const input = readInput();
  const linkFile = path.join(__dirname, 'runtime-link.json');
  if (!fs.existsSync(linkFile)) return fail('runtime-link.json is missing; reinstall the task-dispatch skill');
  let core, dataRoots, link;
  try { ({ core, dataRoots, link } = loadCore(linkFile)); } catch (e) { return fail('runtime unavailable: ' + e.message); }
  // [AI-added] 2026-09-16 16:43
  const explicitData = argv.data || process.env.TASK_DISPATCH_DATA || link.data;
  const workspace = [input.cwd, input.workspace, input.directory]
    .find(value => typeof value === 'string' && value.trim());
  if (!explicitData && !workspace) return fail('workspace is missing; provide host workspace metadata or --data');
  const dataRoot = dataRoots.resolveDataRoot({ data: explicitData, workspace });
  const requested = Number.isFinite(argv.seconds) ? argv.seconds : Number(process.env.TASK_DISPATCH_QODER_PARK_SECONDS);
  const parkSeconds = Number.isFinite(requested) && requested > 0
    ? Math.min(core.MAX_PARK_SECONDS, Math.max(1, Math.floor(requested)))
    : undefined;
  const result = await core.handleHookEvent({
    event: argv.event || input.hook_event_name,
    input,
    dataRoot,
    ...(parkSeconds ? { parkMs: parkSeconds * 1000 } : {}),
    env: process.env,
    configDir: core.resolveConfigDir(process.env, argv.configDir)
  });
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  process.exit(result.exitCode === 2 ? 2 : 0);
}
main().catch(error => fail(error && error.message));
