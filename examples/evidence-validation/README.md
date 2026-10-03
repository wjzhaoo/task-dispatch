# 离线证据校验示例

在仓库根运行 `node examples/evidence-validation/check.cjs`，结果写入 `tmp/evidence-result.json`。不使用真实数据、配置或模型调用。

事实来源：调用次数和索引来自全局 ledger，运行状态和已有产物来自 raw；report 是派生数据，不能反过来覆盖 raw。`generate(data)` 用相同来源生成汇总，`validate(data)` 检查报告和匿名材料。失败场景已有的草稿也必须保留。

这是虚构格式的最小示例，不是 novel2comic 适配器。实际项目需要实现自己的字段映射、权威来源、匿名化及验证逻辑，禁止直接套用此格式声称业务已验证。示例中的 scenario 仅用于核对映射；给盲评者的材料还需单独隔离映射和引擎标签。

受支持的 npm 项目可以把命令登记为候选 package.json 的 `check:evidence` 脚本，再由管理员配置：

```json
{
  "dependencies": "copy-node-modules",
  "checks": [["run", "check:evidence"]],
  "outputs": ["tmp/"],
  "evidenceResult": "tmp/evidence-result.json"
}
```

结果协议为 `{ "version": 1, "checks": [{ "id": "唯一检查ID", "passed": true, "errors": [] }] }`。失败项必须有 `{ "path": "定位", "message": "原因" }`。服务保存候选身份；脚本提供的身份字段不作为权威数据。配置结果但缺失、格式错误或检查不通过时，验证不能通过。
