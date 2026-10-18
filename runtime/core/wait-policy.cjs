'use strict';

// Shared by invitations, role receipts and the bounded local wait client.
const instruction = '本端是 wait 平台，没有自动唤醒，不能结束回合后等通知。接入后、提交后及 idle:true 时，立即实际执行 resume --seconds 60，沿用本端 credential 和 data；不需要用户再次说 resume。等待开始、空队列和项目暂停期间也保持等待，不自行开始或重试任务。宿主工具超时至少 90 秒；工具返回进程会话 ID 时，续等同一进程直到退出，不并行启动第二个等待。每次有界等待到期都继续 resume，不能以“已接入/正在等待”作为最终回复。收到 job 就处理并提交，再继续 resume；completed:true、用户明确停止或真实权限/连接错误需要处理时才退出等待并说明原因。';

function step() {
  return { mode: 'wait', continuationMode: 'wait', parked: false, completed: false, nextAction: 'wait', nextInstruction: instruction };
}
function idle() {
  return { ...step(), job: null, idle: true, nextAction: 'resume', message: '本次等待期限已到，项目尚未结束；立即继续 resume。' };
}
function command(client, credential, root) {
  const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
  return `node ${quote(client)} resume --credential ${quote(credential)} --data ${quote(root)} --seconds 60`;
}
function executable(client, credential, root) {
  const nextCommand = command(client, credential, root);
  return { nextCommand, nextInstruction: instruction + '\n下一步直接执行：' + nextCommand };
}
module.exports = { instruction, step, idle, executable };
