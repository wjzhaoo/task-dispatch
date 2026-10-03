// [AI-added] 2026-09-24 14:24: Active suffixed Codex rollouts provide the current wake turn.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const usage = require('../runtime/core/codex-usage.cjs');
const { CodexWake } = require('../runtime/adapters/codex-wake.cjs');

test('Codex turn resolution chooses the current suffixed rollout over an older exact-name log', async t => {
  const base = path.resolve(__dirname, '../tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'codex-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions'), workspace = path.join(root, 'work');
  fs.mkdirSync(sessions); fs.mkdirSync(workspace);
  const id = '11111111-1111-1111-1111-111111111111';
  const old = path.join(sessions, `rollout-2026-09-24T10-16-05-${id}.jsonl`);
  const current = path.join(sessions, `rollout-2026-09-24T11-30-53-${id}_22222222-2222-2222-2222-222222222222.jsonl`);
  const meta = { type: 'session_meta', payload: { id, cwd: workspace } };
  fs.writeFileSync(old, JSON.stringify(meta) + '\n');
  fs.writeFileSync(current, [meta, { type: 'turn_context', payload: { turn_id: 'current-turn' } }].map(JSON.stringify).join('\n'));
  // [AI-added] 2026-09-24 14:24: Rollout start time wins even if a copied old file has a newer mtime.
  fs.utimesSync(old, new Date('2026-09-24T12:00:00Z'), new Date('2026-09-24T12:00:00Z'));
  assert.equal(usage.discover(sessions, id), old);
  assert.equal(usage.discoverCurrent(sessions, id), current);
  assert.equal(await new CodexWake().resolveTurn(id, workspace, sessions), 'current-turn');
  assert.equal(await new CodexWake().resolveTurn(id, path.join(root, 'other'), sessions), undefined);
});
