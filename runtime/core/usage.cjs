'use strict';
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const messages = {
  not_collected: '尚未完成本地消耗采集',
  invalid_thread_id: 'Codex 会话 ID 无效，无法匹配本地日志',
  log_root_missing: 'Codex 本地会话日志目录不存在',
  log_not_found: '未找到与 Codex 会话唯一匹配的本地日志',
  log_ambiguous: '找到多个同名 Codex 会话日志，已拒绝猜测',
  no_usable_token_deltas: 'Codex 会话日志没有可用的 token_count 增量',
  no_events_in_attempt_window: 'Codex 日志在本次尝试时间窗内没有计量增量',
  platform_not_reported: '平台未随回执上报计量，当前也没有自动采集来源'
};
function normalize(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Usage must be an object');
  for (const k of ['provider', 'model', 'source']) if (typeof value[k] !== 'string' || !value[k].trim() || value[k].length > 200) throw Error('Usage requires ' + k);
  if (!['attempt', 'attempt-window'].includes(value.scope)) throw Error('Usage must cover this attempt only, not a lifetime session total');
  const result = { provider: value.provider, model: value.model, source: value.source, scope: value.scope };
  for (const k of fields) {
    const v = value[k];
    if (v != null && (!Number.isSafeInteger(v) || v < 0)) throw Error('Invalid usage ' + k);
    result[k] = v ?? null;
  }
  if (result.inputTokens != null && result.cachedInputTokens > result.inputTokens) throw Error('Cached input exceeds input');
  if (result.outputTokens != null && result.reasoningOutputTokens > result.outputTokens) throw Error('Reasoning output exceeds output');
  return result;
}
function record(store, projectId, taskId, attemptId, value) {
  const usage = normalize(value);
  if (!usage) throw Error('Usage required');
  store.change(s => {
    const run = s.projects[projectId]?.tasks[taskId]?.attempts.find(r => r.id === attemptId);
    if (!run) throw Error('Unknown attempt');
    if (run.usage && JSON.stringify(run.usage) !== JSON.stringify(usage)) throw Error('Conflicting usage already recorded');
    run.usage = usage;
  });
  return { ok: true };
}
function observation(run) {
  const value = run.usage || run.observedUsage;
  if(!run.usage&&run.usageObservation?.reason==='conflicting_windows')return run.usageObservation;
  if (value) return { status: value.scope === 'attempt' ? 'measured' : 'partial', reason: run.usage ? 'reported' : 'collected', message: run.usage ? '平台上报的本次尝试计量' : '从本地日志按尝试时间窗统计' };
  if (run.usageObservation) return run.usageObservation;
  const provider = run.usageBinding?.provider || run.provider || 'unknown';
  const reason = provider === 'codex' ? 'not_collected' : 'platform_not_reported';
  return { status: provider === 'codex' ? 'pending' : 'unavailable', reason, message: messages[reason] };
}
function summary(state, projectId) {
  const groups = new Map();
  for (const p of Object.values(state.projects)) {
    if (projectId && p.id !== projectId) continue;
    for (const item of require('./brain-activities.cjs').records(p).filter(x=>x.kind!=='activity')) { const r=item.record;
      const u = r.usage || r.observedUsage, provider = u?.provider || r.provider || 'unknown', model = u?.model || r.model || 'unknown';
      const key = JSON.stringify([p.id, r.role, provider, model]);
      if (!groups.has(key)) groups.set(key, { projectId: p.id, role: r.role, provider, model, attempts: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0, unknownReasons: {}, knownTokens: Object.fromEntries(fields.map(f => [f, 0])), missingFields: Object.fromEntries(fields.map(f => [f, 0])) });
      const g = groups.get(key); g.attempts++;
      if (u && u.inputTokens != null && u.outputTokens != null) { if(u.scope === 'attempt') g.measuredAttempts++; else g.partialAttempts++; }
      else { g.unknownAttempts++; const reason = observation(r).reason; g.unknownReasons[reason] = (g.unknownReasons[reason] || 0) + 1; }
      for (const f of fields) { if (u?.[f] == null) g.missingFields[f]++; else g.knownTokens[f] += u[f]; }
    }
  }
  const projects=Object.values(state.projects).filter(p=>!projectId||p.id===projectId).map(p=>({projectId:p.id,projectAttempts:p.turns,projectBudgetEnabled:p.projectBudgetEnabled,maxTurns:p.maxTurns,tasks:Object.values(p.tasks).map(t=>({taskId:t.id,...require('./attempts.cjs').counts(t),maxAttempts:t.maxAttempts}))}));
  // [AI-added] 2026-09-22 09:55: Separate trustworthy event totals from overlapping per-window sums.
  const activityGroups=[],totals=[];
  for(const p of Object.values(state.projects).filter(p=>!projectId||p.id===projectId)){
    const records=require('./brain-activities.cjs').records(p);
    for(const {record:r} of records.filter(x=>x.kind==='activity'))activityGroups.push({projectId:p.id,activityId:r.id,kind:r.kind,source:r.source,startedAt:r.startedAt,endedAt:r.settledAt||null,usage:r.usage||r.observedUsage||null,observation:observation(r)});
    const measured=records.filter(x=>x.record.usage),untracked=records.filter(x=>!x.record.usage&&!x.record.observedUsage);
    const ledger=[...new Map((p.usageLedger||[]).map(e=>[e.id,e])).values()],observed=Object.fromEntries(fields.map(f=>[f,!ledger.length||ledger.some(e=>e[f]==null)?null:ledger.reduce((n,e)=>n+e[f],0)]));
    totals.push({projectId:p.id,observedUniqueTokens:observed,reportedRecords:measured.length,reportedTotals:measured.length===1?measured[0].record.usage:null,combinedTokens:null,complete:false,coverage:{records:records.length,unknown:untracked.length,observedEvents:ledger.length,conflictingEvents:ledger.filter(e=>e.owners.length>1).length,unallocatedEvents:ledger.filter(e=>!e.owners.length).length},note:'Reported and observed amounts are not added; cross-record billing overlap is unverified. Unrecorded conversation remains uncovered.'});
  }
  const events=[...new Map(Object.values(state.projects).filter(p=>!projectId||p.id===projectId).flatMap(p=>p.usageLedger||[]).map(e=>[e.id,e])).values()];
  const observedUniqueTokens=Object.fromEntries(fields.map(f=>[f,!events.length||events.some(e=>e[f]==null)?null:events.reduce((n,e)=>n+e[f],0)]));
  return { projects, groups: [...groups.values()],activityGroups,totals,observedUniqueTokens,observedEventCount:events.length,workflow:require('./workflow-metrics.cjs').summary(state,projectId), savings: null, note: 'Known tokens only; unknown is not zero. Per-project ledgers can reference the same session events: use observedUniqueTokens for the deduplicated selection, never add project/window totals. Cached input is included in input, reasoning output in output. Role does not prove model strength. No single-model baseline: savings cannot be calculated.' };
}
module.exports = { normalize, record, observation, summary, messages };
