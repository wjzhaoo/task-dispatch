#!/usr/bin/env node
'use strict';
// Capture only the one-time task-dispatch invitation shown in this prompt.
// This hook never reads conversation history, credentials, or task contents.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INVITATION_RE = /\[TASK-DISPATCH-INVITE:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\]/ig;
const SESSION_RE = /^[A-Za-z0-9._:-]{4,200}$/;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const configDir = option('--config-dir');
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const ids = [...prompt.matchAll(INVITATION_RE)].map(match => match[1].toLowerCase());
  const unique = [...new Set(ids)];
  const sessionId = input.session_id || input.sessionId;
  const workspace = input.cwd || input.workspace || input.directory;
  if (unique.length === 1 && typeof configDir === 'string' && path.isAbsolute(configDir) &&
      SESSION_RE.test(sessionId || '') && typeof workspace === 'string' && path.isAbsolute(workspace)) {
    const invitationId = unique[0];
    atomic(path.join(configDir, 'task-dispatch-invitations', invitationId + '.json'), {
      version: 1, invitationId, sessionId, workspace: path.resolve(workspace), createdAt: new Date().toISOString()
    });
  }
} catch {
  // Fail open: invitation capture must never block a Qoder prompt.
}
process.stdout.write('{}\n');
