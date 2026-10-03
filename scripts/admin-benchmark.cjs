// [AI-added] 2026-09-16: Isolated observation capacity check, no model calls.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Monitor } = require('../runtime/core/monitor.cjs');
async function main() {
  const base = path.resolve('tmp/admin-console/benchmark'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  const store = { root, state: { revision: 1, events: [], projects: {} } };
  for (let i = 0; i < 20; i++) {
    const p = store.state.projects['p'+i] = { id:'p'+i, workspace:path.join(root,'workspace'+i), tasks:{}, bindings:{} };
    for (let j=0;j<5;j++) p.bindings['worker:w'+j]={clientId:`p${i}-worker-${j}`,continuation:{mode:'wait',provider:'fixture'}};
  }
  const monitor = new Monitor(store, {}, {});
  const start = performance.now();
  for(let i=0;i<100000;i++) monitor.record('benchmark_event',{projectId:'p'+(i%20),summary:'隔离容量验证',status:'observed'});
  const appendMs = performance.now()-start, readStart=performance.now();
  const result=await monitor.history(new URLSearchParams({projectId:'p7',limit:'100'}));
  const pageMs=performance.now()-readStart, snapshotStart=performance.now();
  const snapshot=monitor.snapshot(), snapshotMs=performance.now()-snapshotStart;
  assert.equal(result.events.length,100);assert.equal(snapshot.projects.length,20);assert.equal(snapshot.projects.flatMap(p=>p.connections).length,100);assert.equal(monitor.recent.length,1000);assert.ok(monitor.segments().length<=8);
  console.log(JSON.stringify({root,events:100000,projects:20,bindings:100,appendMs:Math.round(appendMs),pageMs:Math.round(pageMs),snapshotMs:Math.round(snapshotMs),segments:monitor.segments().length,cacheEvents:monitor.recent.length,error:monitor.error||null}));
  monitor.close();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
