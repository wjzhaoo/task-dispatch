// [AI-added] 2026-09-24 14:00: Workspace-local snapshot exclusions with frozen, portable rules.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILE = '.taskignore';
const MAX_BYTES = 64 * 1024;
const MAX_RULES = 1000;

function readRules(root) {
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('.taskignore must be a regular file');
  if (stat.size > MAX_BYTES) throw Error('.taskignore exceeds 64 KiB');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  const rules = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (rules.length > MAX_RULES) throw Error('.taskignore has too many rules');
  rules.forEach(compile);
  return rules;
}

function glob(pattern) {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { result += '(?:.*/)?'; i += 2; }
      else { result += '.*'; i++; }
    } else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return result;
}

function compile(line) {
  if (typeof line !== 'string' || !line || line.length > 1024) throw Error('Invalid .taskignore rule');
  let raw = line, include = false;
  if (raw.startsWith('\\#') || raw.startsWith('\\!')) raw = raw.slice(1);
  else if (raw.startsWith('!')) { include = true; raw = raw.slice(1); }
  // [AI-added] 2026-09-24 14:04: A trailing slash marks a directory but does not anchor it.
  const anchored = raw.startsWith('/') || raw.replace(/\/$/, '').includes('/');
  const directory = raw.endsWith('/');
  raw = raw.replace(/^\//, '').replace(/\/$/, '');
  if (!raw || raw.includes('\\') || raw.includes(':') || raw.split('/').some(part => part === '.' || part === '..')) throw Error('Invalid .taskignore rule: ' + line);
  const expression = (anchored ? '^' : '(?:^|/)') + glob(raw) + '$';
  return { include, directory, regex: new RegExp(expression) };
}

function matcher(lines = []) {
  const rules = lines.map(compile);
  function match(name, directory = false) {
    if (name === FILE || name.startsWith('.task-dispatch/') || name === '.task-dispatch' || name.startsWith('.dispatch-evidence/') || name === '.dispatch-evidence') return false;
    let excluded = false;
    const parts = name.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const candidate = parts.slice(0, n).join('/');
      const isDirectory = n < parts.length || directory;
      for (const rule of rules) if ((!rule.directory || isDirectory) && rule.regex.test(candidate)) excluded = !rule.include;
      if (excluded && n < parts.length) return true;
    }
    return excluded;
  }
  return match;
}

module.exports = { FILE, readRules, compile, matcher };
