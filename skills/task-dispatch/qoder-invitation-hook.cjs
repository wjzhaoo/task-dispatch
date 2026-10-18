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
function atomic(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',encoding:'utf8',mode:0o600});
    if (exclusive) {
      try {fs.linkSync(temporary,file);return true;}
      catch(error) {if(error.code!=='EEXIST')throw error;return false;}
    }
    fs.renameSync(temporary,file);return true;
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const configDir = option('--config-dir');
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const ids = [...prompt.matchAll(INVITATION_RE)].map(match => match[1].toLowerCase());
  const unique = [...new Set(ids)];
  const sessionId = input.session_id;
  const workspace = input.cwd;
  if (unique.length === 1 && typeof configDir === 'string' && path.isAbsolute(configDir) &&
      SESSION_RE.test(sessionId || '') && typeof workspace === 'string' && path.isAbsolute(workspace)) {
    const invitationId = unique[0];
    const file=path.join(configDir,'task-dispatch-invitations',invitationId+'.json');
    const record={version:1,invitationId,sessionId,workspace:path.resolve(workspace),createdAt:new Date().toISOString()};
    if(fs.existsSync(file)||!atomic(file,record,true)) {
      const existing=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!existing.ambiguous&&(existing.sessionId!==record.sessionId||existing.workspace!==record.workspace))atomic(file,{...existing,ambiguous:true});
    }
  }
} catch {
  // Fail open: invitation capture must never block a Qoder prompt.
}
process.stdout.write('{}\n');
