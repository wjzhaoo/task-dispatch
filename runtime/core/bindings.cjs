'use strict';
function workerId(value = 'default') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw Error('Invalid workerId');
  return value;
}
function bindingKey(identity) {
  return ['brain','reviewer'].includes(identity.role) ? identity.role : workerId(identity.workerId) === 'default' ? 'worker' : 'worker:' + identity.workerId;
}
function capabilities(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw Error('Invalid capabilities');
  return [...new Set(value.map(v=>workerId(v)))];
}
function staffing(value) {
  if (!value || typeof value.rationale !== 'string' || !value.rationale.trim() || !Array.isArray(value.workers) || value.workers.length > 20) throw Error('Staffing requires rationale and up to 20 workers');
  const seen = new Set();
  const workers = value.workers.map(w => {
    if (!w || typeof w.workerId !== 'string' || typeof w.capability !== 'string') throw Error('Worker id and capability required');
    const id = workerId(w.workerId), capability = workerId(w.capability);
    if (seen.has(id) || typeof w.responsibilities !== 'string' || !w.responsibilities.trim()) throw Error('Unique worker ids and responsibilities required');
    seen.add(id);
    return { workerId: id, capability, responsibilities: w.responsibilities.trim() };
  });
  return { rationale: value.rationale.trim(), workers, concurrencyRequested: value.concurrencyRequested === true, executionMode: 'serial-shared-workspace' };
}
function matches(project, task) {
  const key=bindingKey({role:'worker',workerId:task.currentWorkerId||task.workerId});
  const binding = project.bindings?.[key];
  return !!binding && (!project.handovers?.[key] || !!task.scopeRecovery) && (!task.scopeRecovery?.clientId || binding.clientId===task.scopeRecovery.clientId) && supports(binding, task.requiredCapability);
}
function supports(binding, capability) { return !capability || capability === 'general' || !!binding?.capabilities?.includes(capability); }
module.exports = {workerId,bindingKey,capabilities,matches,staffing,supports};
