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
function matches(project, task) {
  const key=bindingKey({role:'worker',workerId:task.currentWorkerId||task.workerId});
  const binding = project.bindings?.[key];
  return !!binding && (!project.handovers?.[key] || !!task.scopeRecovery) && (!task.scopeRecovery?.clientId || binding.clientId===task.scopeRecovery.clientId) && (!task.requiredCapability || binding.capabilities?.includes(task.requiredCapability));
}
module.exports = {workerId,bindingKey,capabilities,matches};
