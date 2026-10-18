'use strict';
const {bindingKey}=require('./bindings.cjs');

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createInterface } = require('node:readline');
const { normalize } = require('./usage.cjs');
function locate(root, threadId, options = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) return { reason: 'invalid_thread_id' };
  if (!fs.existsSync(root)) return { reason: 'log_root_missing' };
  const found = [];
  // [AI-added] 2026-09-24 14:25: Compile once while scanning the session tree.
  const resumedName = options.current ? new RegExp(threadId + '_[a-f0-9-]{36}\\.jsonl$', 'i') : null;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const file = path.join(dir,e.name);
      if (e.isDirectory()) walk(file);
      // [AI-added] 2026-09-24 14:23: Resumed Codex rollouts append another UUID after the thread ID.
      else if (e.name.endsWith(threadId + '.jsonl') || resumedName?.test(e.name)) found.push(file);
    }
  }
  walk(root);
  if (!found.length) return { reason: 'log_not_found' };
  // [AI-added] 2026-09-24 14:23: Wake needs the newest rollout; usage keeps its strict ambiguity rule.
  if (options.current) {
    // [AI-added] 2026-09-24 14:27: Choose the newest rollout start, then the active file on ties.
    const started = file => path.basename(file).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)?.[0] || '';
    return { file: found.sort((a,b) => started(b).localeCompare(started(a)) || fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a))[0] };
  }
  if (found.length !== 1) return { reason: 'log_ambiguous' }; // Ambiguous logs must never double count.
  return { file: found[0] };
}
function discover(root, threadId) { return locate(root, threadId).file || null; }
// [AI-added] 2026-09-24 14:23: Current wake resolution includes suffixed session files.
function discoverCurrent(root, threadId) { return locate(root, threadId, { current: true }).file || null; }
async function parseDetails(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  const points = [],seen=new Set(); let previous = null, model = null, tokenEvents = 0;
  try {
    for await (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'turn_context') model = row.payload?.model || null;
      if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
      tokenEvents++;
      const u = row.payload.info?.total_token_usage;
      if (!u || !Number.isSafeInteger(u.input_tokens) || !Number.isSafeInteger(u.output_tokens)) continue;
      const keys = { inputTokens:'input_tokens', cachedInputTokens:'cached_input_tokens', outputTokens:'output_tokens', reasoningOutputTokens:'reasoning_output_tokens' };
      const delta = {};
      let reset = false;
      for (const [k, native] of Object.entries(keys)) {
        delta[k] = previous && Number.isSafeInteger(u[native]) && Number.isSafeInteger(previous[native]) ? u[native] - previous[native] : null;
        if (delta[k] != null && delta[k] < 0) reset = true;
      }
      // [AI-added] 2026-09-22 09:55: Stable source-event identity excludes repeated zero deltas.
      if(previous&&!reset&&Number.isFinite(Date.parse(row.timestamp))&&delta.inputTokens!=null&&delta.outputTokens!=null&&(delta.inputTokens||delta.outputTokens)){const key=require('./storage.cjs').sha(JSON.stringify([row.timestamp,previous,u]));if(!seen.has(key)){seen.add(key);points.push({id:key,at:Date.parse(row.timestamp),model,...delta});}}
      previous = u;
    }
  } finally { lines.close(); stream.destroy(); }
  return { points, tokenEvents };
}
async function parse(file) { return (await parseDetails(file)).points; }
// [AI-added] 2026-09-22 09:55: Assign each source delta once; overlapping windows remain explicitly unresolved.
async function collect(dispatcher,{root=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),now=Date.now()}={}){
 const refs=[],cache=new Map(),updates=[],ledgers=new Map();
 for(const p of Object.values(dispatcher.store.state.projects))for(const item of require('./brain-activities.cjs').records(p)){
  const r=item.record,b=r.usageBinding||(!(p.bindingHistory||[]).length?p.bindings?.[bindingKey(r)]?.wake:null);
  if(!b||b.provider!=='codex')continue;
  let end=r.settledAt?Date.parse(r.settledAt):now;
  if(r.settled&&!r.settledAt){const receipt=dispatcher.receiptPath(r.id);if(!fs.existsSync(receipt))continue;end=fs.statSync(receipt).mtimeMs;}
  const start=Date.parse(r.claimedAt||r.startedAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)continue;
  refs.push({...item,projectId:p.id,owner:p.id+'/'+item.key,thread:b.threadId,start,end});
 }
 for(const ref of refs)if(!cache.has(ref.thread)){
  const found=locate(root,ref.thread);cache.set(ref.thread,found.file?{...found,...await parseDetails(found.file)}:found);
 }
 for(const [thread,data]of cache){
  if(!data.points)continue;const windows=refs.filter(r=>r.thread===thread),lo=Math.min(...windows.map(r=>r.start)),hi=Math.max(...windows.map(r=>r.end));
  const events=data.points.filter(e=>e.at>=lo&&e.at<=hi).map(e=>({...e,id:thread+':'+e.id,thread,owners:windows.filter(r=>e.at>=r.start&&e.at<=r.end).map(r=>r.owner).sort()}));
  for(const projectId of new Set(windows.map(r=>r.projectId))){const local=windows.filter(r=>r.projectId===projectId),start=Math.min(...local.map(r=>r.start)),end=Math.max(...local.map(r=>r.end));if(!ledgers.has(projectId))ledgers.set(projectId,[]);ledgers.get(projectId).push(...events.filter(e=>e.at>=start&&e.at<=end));}
 }
 for(const ref of refs){
  const data=cache.get(ref.thread),r=ref.record;
  if(r.usage)continue;
  const ledger=ledgers.get(ref.projectId)||[],events=ledger.filter(e=>e.thread===ref.thread&&e.owners.length===1&&e.owners[0]===ref.owner),conflicts=ledger.filter(e=>e.thread===ref.thread&&e.owners.length>1&&e.owners.includes(ref.owner));
  let reason=data.reason||(!data.points.length?'no_usable_token_deltas':conflicts.length?'conflicting_windows':!events.length?'no_events_in_attempt_window':'collected');
  let usage=null;
  if(events.length){const models=[...new Set(events.map(e=>e.model||'unknown'))],tokens={};for(const k of ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'])tokens[k]=events.some(e=>e[k]==null)?null:events.reduce((n,e)=>n+e[k],0);usage=normalize({provider:'codex',model:models.length===1?models[0]:'mixed',source:'local-codex-token-count-delta',scope:'attempt-window',...tokens});}
  const observation={status:usage?'partial':r.settled?'unavailable':'pending',reason,message:require('./usage.cjs').messages[reason]||'重叠时间窗存在未归属计量，未重复累计'};
  const window={start:new Date(ref.start).toISOString(),end:new Date(ref.end).toISOString(),file:data.file||null,events:events.length,conflicts:conflicts.length,eventIds:events.map(e=>e.id)};
  if(JSON.stringify(r.observedUsage||null)!==JSON.stringify(usage)||JSON.stringify(r.usageObservation)!==JSON.stringify(observation)||JSON.stringify(r.usageWindow)!==JSON.stringify(window))updates.push({ref,usage,observation,window});
 }
 const changedLedgers=[...ledgers].filter(([id,rows])=>JSON.stringify(dispatcher.store.state.projects[id].usageLedger||[])!==JSON.stringify(rows));
 if(updates.length||changedLedgers.length)dispatcher.store.change(s=>{
  for(const u of updates){const r=require('./brain-activities.cjs').records(s.projects[u.ref.projectId]).find(x=>x.key===u.ref.key)?.record;if(!r||r.usage)continue;if(u.usage)r.observedUsage=u.usage;else delete r.observedUsage;r.usageObservation=u.observation;r.usageWindow=u.window;}
  for(const [id,rows]of changedLedgers)s.projects[id].usageLedger=rows;
 });
 const reasons={};for(const u of updates.filter(u=>!u.usage))reasons[u.observation.reason]=(reasons[u.observation.reason]||0)+1;
 return {updatedAttempts:updates.length,unavailableReasons:reasons,note:'Unique source-event deltas. Conflicting windows are unallocated; unrecorded conversation is not covered.'};
}
module.exports = { discover, discoverCurrent, locate, parse, parseDetails, collect };
