'use strict';
// [AI-added] 2026-09-20: Wake repairs may restart the host GUI app when its bridge is down.
// Enumerating real processes doubles as executable discovery, so a restart relaunches the
// exact install the user runs instead of guessing a fixed path.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

function run(file, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) return reject(error);
      resolve({ code: error ? error.code : 0, stdout: String(stdout || '') });
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', () => clearTimeout(timer));
  });
}

function parseProcesses(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return (Array.isArray(value) ? value : [value])
    .filter(entry => Number.isInteger(entry?.Id))
    .map(entry => ({ id: entry.Id, name: String(entry.ProcessName || ''), path: typeof entry.Path === 'string' ? entry.Path : '' }));
}

// names: PowerShell -Name wildcard prefixes, e.g. ['Qoder'] matches 'Qoder CN' case-insensitively.
function listProcesses(names, timeoutMs = 8000) {
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  if (!list.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Process listing timed out')), timeoutMs);
    const done = (error, procs) => { clearTimeout(timer); error ? reject(error) : resolve(procs); };
    if (process.platform === 'win32') {
      const filter = list.map(name => `'${name.replace(/'/g, "''")}*'`).join(',');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Process -Name ${filter} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout) return done(null, []);
        try { done(null, parseProcesses(stdout)); } catch (e) { done(e); }
      });
    } else {
      execFile('ps', ['-eo', 'pid=,comm='], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return done(null, []);
        const prefixes = list.map(name => name.toLowerCase());
        const procs = String(stdout || '').split('\n').map(line => {
          const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (!match) return null;
          const name = match[2].split('/').pop();
          return prefixes.some(prefix => name.toLowerCase().startsWith(prefix))
            ? { id: Number(match[1]), name, path: match[2] } : null;
        }).filter(Boolean);
        done(null, procs);
      });
    }
  });
}

// Kills every matching process tree, then relaunches the discovered executable detached.
// kill:false turns the call into a plain launch when the app is not running at all.
// fallback resolves extra paths (e.g. a registry lookup) tried after fixed candidates miss.
async function restartApp({ names, launcherFrom, candidates = [], fallback, kill = true, killGraceMs = 1500, timeoutMs, spawnImpl }) {
  const procs = await listProcesses(names, timeoutMs).catch(() => []);
  let exe = null;
  for (const raw of procs.map(proc => proc.path).filter(Boolean)) {
    const target = launcherFrom ? launcherFrom(raw) : raw;
    if (target && fs.existsSync(target)) { exe = target; break; }
  }
  if (!exe) {
    for (const candidate of candidates) if (fs.existsSync(candidate)) { exe = candidate; break; }
  }
  if (!exe && fallback) {
    const extra = await Promise.resolve().then(() => fallback()).catch(() => []);
    for (const candidate of extra || []) if (candidate && fs.existsSync(candidate)) { exe = candidate; break; }
  }
  const killed = [];
  if (kill && procs.length) {
    for (const proc of procs) {
      try {
        if (process.platform === 'win32') await run('taskkill', ['/F', '/T', '/PID', String(proc.id)], 5000);
        else process.kill(proc.id, 'SIGKILL');
        killed.push(proc.id);
      } catch { /* Already gone; the next probe decides the launch shape. */ }
    }
    await new Promise(resolve => setTimeout(resolve, killGraceMs));
  }
  if (!exe) return { attempted: false, reason: 'executable-not-found', procs: procs.length, killed: killed.length };
  try {
    const child = (spawnImpl || spawn)(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    return { attempted: false, reason: 'launch-failed', error: error.message, killed: killed.length };
  }
  return { attempted: true, action: killed.length ? 'restart' : 'launch', exe, killed: killed.length, procs: procs.length };
}

function installCandidates(env, relatives) {
  const bases = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  return [...new Set(bases.flatMap(base => relatives.map(parts => path.join(base, ...parts))))];
}

// Non-standard installs (D:\softs\...) are found through the uninstall registry: Electron
// installers record DisplayName and InstallLocation. Failures return [] so callers fall back.
function registryLookup(exeMatch, timeoutMs = 8000) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `$names = @(${exeMatch.map(name => `'${name.replace(/'/g, "''")}'`).join(',')}); ` +
    'Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, ' +
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, ' +
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.InstallLocation } | ForEach-Object { $loc = $_.InstallLocation; ' +
    'foreach ($n in $names) { Get-ChildItem -Path $loc -Filter $n -Recurse -Depth 3 -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.PSIsContainer -eq $false } | Select-Object -First 1 -ExpandProperty FullName } } | Select-Object -Unique';
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
        if (error && !stdout) return resolve([]);
        resolve(String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(line => line.toLowerCase().endsWith('.exe')));
      });
  });
}

module.exports = { listProcesses, restartApp, installCandidates, registryLookup };
