'use strict';
const {dataRoot,request}=require('./wizard.cjs');
async function main(args=process.argv.slice(2)) {
  const root=dataRoot(args);
  console.log('服务缓存目录：'+root);
  const preview=await request(root,{action:'cleanup-preview'});
  console.log(`当前缓存 ${(preview.totalBytes/1024**3).toFixed(2)} GiB，上限 ${(preview.policy.maxBytes/1024**3).toFixed(2)} GiB。`);
  console.log(`按当前保留策略可清理 ${preview.entries.length} 个目录，共 ${(preview.reclaimableBytes/1024**2).toFixed(2)} MiB。`);
  if(args.includes('--preview'))return preview;
  // Use the service's checked preview; never enumerate or delete arbitrary paths in BAT.
  const result=await request(root,{action:'cleanup-apply',previewId:preview.previewId});
  console.log(`已释放 ${(result.reclaimedBytes/1024**2).toFixed(2)} MiB；连接、任务及源工程保留。`);
  if(preview.totalBytes-result.reclaimedBytes>preview.policy.maxBytes){
    console.log('仍超过缓存上限：其余数据受保留策略或任务引用保护，调度仍阻塞。请在管理台核对保留策略或空间上限。');
    process.exitCode=2;
  }else console.log('缓存已在上限以内，服务将自动继续调度，无需重新连接。');
  return result;
}
if(require.main===module)main().catch(e=>{console.error('清理未完成：'+e.message+'；请确认服务已启动。');process.exitCode=1;});
module.exports={main};
