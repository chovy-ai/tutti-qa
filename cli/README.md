# tutti-qa CLI

外部只提交“目标、用途、账号条件、预期和约束”，执行机内部通过 workflow + Agent 完成规划、执行、验证、证据整理和回收。

| 用途 | 命令 | 执行机内部实现 | 结果 |
|---|---|---|---|
| 过一遍功能、截图 | `tutti-qa walkthrough` | Codex 持续会话 + Ego 原生工具 | `completed`、过程记录、截图、未覆盖项 |
| 做测试 | `tutti-qa test` | Midscene 规划/执行/断言 + ego lite | `passed/failed/blocked`、逐项判定、截图、回放 |

两条工作流都使用主机原有账号池及其 ego lite profile。CLI 不接收浏览器点击步骤，不携带账号 Cookie，不在外部设备启动浏览器或调用模型。

## 安装与分发

客户端只需 Node.js ≥22，没有第三方运行依赖，也不需要安装本仓库的 `regress` 依赖。

执行机或构建机打包：

```bash
cd cli
mkdir -p dist
npm pack --pack-destination dist
```

把生成的 `tutti-qa-cli-0.1.0.tgz` 交给调用方，外部设备安装：

```bash
npm install -g ./tutti-qa-cli-0.1.0.tgz
tutti-qa --help
```

仓库内也可直接运行 `node cli/bin/tutti-qa.mjs --help`。当前提供本地 tarball 分发，包标记为 private，未发布到 npm 公共注册表；不能把 `npx tutti-qa-cli` 当作已发布命令。

## 接入执行机

CLI 使用现有 HTTP 服务，不自动开启 SSH、公网端口或登录账号。先建立可达的网络入口，例如在外部设备运行：

```bash
ssh -N -L 14318:127.0.0.1:4318 user@execution-host
export BROWSER_TEST_SERVER=http://127.0.0.1:14318
```

服务无需 token，所有请求使用同一个服务身份。可直接检查连接：

```bash
tutti-qa capabilities
tutti-qa accounts list
```

`--server` 优先于 `BROWSER_TEST_SERVER`，默认 `http://127.0.0.1:4318`。调用方共享账号池、任务和产物；重试沿用原 request-id，独立操作使用不同 request-id。目标 URL 从执行机访问，外部设备自己的 `localhost` 不是执行机的 `localhost`。

## 按目标执行

功能走查：

```bash
tutti-qa walkthrough "过一遍房间邀请功能，截图记录主要状态" \
  --target https://tutti.sh/platform/ \
  --roles owner \
  --constraints "不向真实用户发送邀请" \
  --request-id invite-walkthrough-001 \
  --out-dir ./results/invite-walkthrough-001
```

测试验证：

```bash
tutti-qa test "验证普通成员不能删除房间" \
  --target https://tutti.sh/platform/ \
  --roles member \
  --expect "普通成员无法访问房间删除操作" \
  --constraints "不要修改真实用户的房间；没有测试房间则返回阻塞" \
  --request-id member-delete-001 \
  --out-dir ./results/member-delete-001
```

`--expect`、`--constraints` 可以重复。账号可使用 `--account auto-test-account-1` 精确指定，或通过 `--roles`、`--env`、`--capabilities`、`--tags` 筛选；省略时服务从原有允许使用的账号中选择，不新建用户。

默认任务限时 600 秒，操作预算为 1000 步；可用 `--timeout-seconds`（最大 3600）和 `--max-steps`（1–1000）设置预算。预算是上限，达到目标即可结束，无需用满。走查的 `maxSteps` 是交给 Codex 的操作预算，不是主机逐动作强制计数；Codex 在同一会话中使用 Ego 原生工具完成走查。测试步骤仍是 Midscene 生成的 action，底层键鼠动作也有有限预算。两种计数不等于模型调用次数；服务端超时限制始终强制执行。

允许执行目标所需的真实业务数据变更，例如发送消息或修改公告；调用方给出的 `--constraints` 仍须遵守。CLI 和服务不自动附加只读约束，业务操作不会因任务失败而自动回滚。

原生走查会校验初始目标、报告 URL 和最终页面的站点范围，并把范围传给 Codex；中途原生操作的强制隔离需浏览器或网络层支持。服务遵守 profile 的真实控制权。账号占用、登录失效、前置数据不足或人工接管会返回阻塞/待确认，不能当作测试通过。

## 文件输入和异步任务

目标文件支持这些字段：

```json
{
  "mode": "test",
  "goal": "验证普通成员不能删除房间",
  "target": "https://tutti.sh/platform/",
  "selector": { "roles": ["member"] },
  "expectations": ["普通成员无法访问房间删除操作"],
  "constraints": ["没有适合的测试房间就返回阻塞"],
  "maxSteps": 1000,
  "timeoutSeconds": 600
}
```

`accountId` 和 `selector` 互斥。文件不接受 `steps`、shell、JavaScript 或本机文件系统操作。命令行显式目标/筛选条件覆盖文件中的对应值；没有指定的值继续使用文件内容。

```bash
tutti-qa run --file test.json --request-id test-001 --out-dir ./results/test-001
cat test.json | tutti-qa run --file - --request-id test-001

tutti-qa run submit --file test.json --request-id test-002
tutti-qa run list
tutti-qa run get <runId>
tutti-qa run wait <runId> --out-dir ./results/test-002
tutti-qa run cancel <runId> --request-id cancel-test-002
tutti-qa artifact get <artifactId> --out ./evidence.png
```

`run submit` 的退出码 0 只表示接单，结果可能仍是 queued/running。取消接口同样只表示请求已被处理，必须轮询到 `finishedAt` 确认最终状态和回收结果。

## 结果、重试和退出码

stdout 只输出 JSON；命令错误在 stderr 输出 JSON。执行结果包含 `data.id/mode/agent/browser/status/phase/summary/accountId/checks/observations/artifacts/uncovered/cleanup`。`--out-dir` 下载截图/HTML 并写入 `result.json`，文件使用 0600，拒绝覆盖已有文件。再次下载时选择新目录，或由调用方明确整理旧文件。

| 退出码 | 含义 |
|---|---|
| `0` | 走查完成 / 测试通过 / 查询成功 / 异步提交被接受 |
| `1` | 真实断言失败 |
| `2` | 阻塞、超时、取消、网络或参数错误、清理未确认 |
| `130` | 调用方中断了 CLI |

走查的 completed 不等于测试 passed。测试只在断言执行后通过；未提供 expectations 时由 Midscene 推导检查点，结果标明 `source: inferred`，不能把它当作用户已确认的完整业务规范。

CLI 自动重试短暂网络错误时复用同一个 POST `Idempotency-Key` 和原请求体。最终响应未确认会返回 `REQUEST_UNCONFIRMED`、`operationState: unknown` 及 requestId；自动化建议显式提供 `--request-id`，重试同一意图时沿用 ID 和原输入。改变目标或主动重跑必须使用新 ID。幂等缓存以服务器当前进程生命周期为界，重启后不能依靠旧 ID 自动重放。

`--wait-seconds` 仅控制客户端等待（默认 900 秒），`--http-timeout-seconds` 仅控制单次 HTTP 请求（默认 30 秒）。停止等待、断网或 Ctrl+C 不会自动创建新任务，也不会隐式取消服务器任务；从错误中的 runId 继续查询或显式取消。若提交响应丢失，没有 runId，使用原 requestId 重试提交获取回执。

服务端负责续租和回收账号，CLI 不直接管理浏览器会话。当前工作流在服务端串行运行；重启后任务句柄不恢复，不自动重放模型动作。完整服务边界见 [SERVICE.md](../regress/SERVICE.md)。

## 开发验证

```bash
cd cli
npm run check
npm test
```

执行机真实链路验证（使用原账号的独立 ego Space，只操作临时站点）：

```bash
cd regress
node scripts/workflow-smoke.ts --mode both --account auto-test-account-1 --env-file /path/to/model.env
```
