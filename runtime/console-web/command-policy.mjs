// Shared command behavior keeps routine clicks and dialog submissions on the same guarded API.
export const commandLabels = {
  'start-work': '开始项目', 'start-goal': '开始目标 / 加入队列', 'cancel-goal': '取消目标',
  pause: '暂停项目', resume: '继续项目', retry: '重试任务', 'task-budget': '追加尝试额度',
  assign: '改派执行员', 'rebind-invite': '生成改绑提示词', 'rebind-cancel': '取消改绑邀请',
  detach: '解绑成员', 'wake-retry': '重试唤醒', 'wake-remind': '再次提醒',
  'finish-project': '结束项目', 'reopen-project': '重新开启项目', 'archive-project': '归档项目',
  'restore-project': '恢复归档项目', 'delete-project': '永久删除项目', 'reset-task': '重置任务',
  'cleanup-preview': '清理存储', 'cleanup-apply': '清理存储', stop: '停止服务'
};
export const lifecycleActions = ['archive-project', 'restore-project', 'delete-project', 'reset-task'];
const directActions = ['start-work', 'start-goal', 'pause', 'resume', 'reopen-project', 'wake-retry', 'wake-remind', 'rebind-cancel'];
export const retryChoice = task => task?.resumePhase === 'brain' && !!task.artifactId;
export function needsDialog(action, task) {
  if (action === 'retry') return task?.state === 'uncertain' || retryChoice(task);
  return !directActions.includes(action);
}
export function submitLabel(action, { task, preview, recovery = false } = {}) {
  if (action === 'retry' && task?.state === 'uncertain') return '旧执行已停止，重试';
  if (action === 'rebind-invite' && recovery) return '旧会话已停止，生成提示词';
  if (preview?.requiresStopped) return action === 'reset-task' ? '相关执行已停止，重置任务' : '相关执行已停止，删除项目';
  return ({ assign: '确认改派', 'task-budget': '追加额度', 'rebind-invite': '生成改绑提示词',
    'cleanup-preview': '清理以上目录', 'cleanup-apply': '清理以上目录' })[action] || '确认' + commandLabels[action];
}
export function buildCommand(snapshot, target, action, values = {}) {
  const project = snapshot.projects.find(project => project.id === target.projectId);
  const task = project?.tasks.find(task => task.id === target.taskId);
  const command = {
    commandId: crypto.randomUUID(), instanceId: snapshot.instanceId, revision: snapshot.revision,
    action, ...target, confirmed: true, reason: 'Web 控制台：' + commandLabels[action]
  };
  if (action === 'assign') command.workerId = values.workerId;
  if (action === 'task-budget') command.additionalAttempts = Number(values.additionalAttempts);
  if (action === 'retry') {
    command.restartWorker = values.restartWorker === true;
    command.confirmedStopped = task?.state === 'uncertain';
  }
  if (action === 'rebind-invite') command.confirmedStopped = values.recovery === true;
  if (action === 'delete-project') command.confirmText = target.projectId;
  if (action === 'reset-task') { command.confirmText = target.taskId; command.resetDependents = true; }
  if (['delete-project', 'reset-task'].includes(action)) command.confirmedStopped = values.preview?.requiresStopped === true;
  if (action === 'cleanup-apply') command.previewId = values.preview?.previewId;
  return command;
}
