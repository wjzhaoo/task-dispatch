'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { id, read } = require('./storage.cjs');

function validateConfig(config) {
  if (config.version !== 1 || !Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 16) throw Error('Invalid config/version/maxConcurrent');
}

function initialize(root) {
  require('./data-root.cjs').assertServiceRoot(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'config.json');
  if (fs.existsSync(file)) { validateConfig(read(file)); return false; }
  const temporary = path.join(root, 'config-' + id() + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, maxConcurrent: 2 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; validateConfig(read(file)); return false; }
    return true;
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
module.exports = { initialize, validateConfig };
