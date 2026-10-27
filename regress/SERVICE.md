# 通用浏览器测试服务

HTTP JSON API 是稳定入口，OpenAPI 3.1 契约可从 `GET /v1/openapi.json` 获取。调用方可以是其他设备上的 Agent、脚本、CI 或应用，不依赖 `.pos`、Plan、Tutti 房间或特定模型名称。

数据流：调用方 Bearer token → HTTP 校验与幂等 → 账号独占租约/会话 → 会话串行队列 → `BrowserProvider` → 独立 Chromium → Playwright 操作或 Midscene AI → 作业结果/产物。

第一版 provider 是 Playwright。已有 ego lite 的账号会读取主机保存的凭据，注入新的独立浏览器，不接管原有 profile/Space。`BrowserProvider` 是后续接入其他浏览器运行时的边界，当前没有通过接口控制 ego lite 的实现。

## 启动

Node ≥24，使用仓库锁定的依赖，不新增 Web 框架。

```bash
cd regress
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm service --config service.example.json --env-file /absolute/path/to/model.env
```

`--env-file` 是可选的主机模型配置文件，变量名沿用 `.env.example` 的 `MIDSCENE_*`。已存在的进程环境变量优先；不传该参数时只读取进程环境。没有配置模型时仍可使用确定性操作和截图，AI 步骤返回 `MODEL_UNAVAILABLE`。

默认监听 `127.0.0.1:4318`；默认账号目录为 `~/.tutti-qa/accounts.json`，session 目录为 `~/.tutti-qa/secrets`。启动只读取账号，不创建线上用户。状态和产物写入 `regress/.service/`，该目录不入库。

首次启动自动生成 `.service/access.json`（0600），其中的 `token` 是默认调用方凭据。启动输出只给文件路径，不打印 token。给不同调用方配置独立身份：

```json
{
  "clients": [
    { "id": "ci", "tokenEnv": "CI_BROWSER_TOKEN", "accountIds": ["app-staging-owner"] },
    { "id": "developer", "tokenEnv": "DEV_BROWSER_TOKEN" }
  ]
}
```

每个 token 至少 32 字符，由主机环境提供。`accountIds` 未设置表示可用全部账号，空数组表示无账号权限。会话、作业、产物按调用方隔离。此接口授权浏览器测试操作，不应向不可信用户分发 token。

其他设备可以经 SSH 隧道访问：

```bash
ssh -N -L 4318:127.0.0.1:4318 user@execution-host
```

也可配置 `host` 绑定内网地址。跨不可信网络时在前面配置 HTTPS 反向代理；服务自身提供 HTTP，不负责 TLS、OAuth 或公网部署。

## 账号与站点

标准账号目录见 `accounts.example.json`。通过 `accountsFile` 指定其绝对路径或相对于服务配置文件的路径，凭据文件相对于账号目录文件解析。使用标准 Playwright storage state（含 `cookies`、`origins`，可承载 localStorage/IndexedDB），文件留在执行机并设为 0600，不写进仓库。

旧目录的 `name/env/profile/roles/capabilities` 由 `accounts.ts` 兼容适配器归一化。旧格式的 session Cookie 转换仍使用现有实现。目录里的 `loginCode`、`login`、`note`、`userId` 不会返回给调用方。

`resourceKey` 标识需要互斥的真实账号资源；同一用户的多个账号别名应设置为相同值。旧格式默认使用 `profile`。会话就是租约：创建时占用，确认浏览器关闭后归还。默认租约目录在账号目录旁的 `.browser-leases/`，通过原子目录锁防止不同服务实例重复分配；多个实例必须使用同一账号目录/`leaseDir`。它不追踪用户手工操作的 ego lite Space；执行测试前应把测试账号交给服务专用，避免人工和自动化同时修改同一服务端用户。

`available` 仅表示没有服务租约，**不保证登录态有效**。服务不自动登录、刷新 session、创建付费权限或清理业务数据；调用方应先用断言确认登录，再执行测试。需要更新登录态时，在主机更换 storage state/session 文件，对新会话生效。

默认 `allowedOrigins: ["*"]` 允许匿名会话测试任意 HTTP(S) 站点，不绑定产品。需要限制站点时配置精确 origin，例如 `https://example.org`、`http://localhost:3000`；示例配置演示了这种限制。账号也可配置更窄的 `allowedOrigins`，两者取交集；账号省略时默认限制为其初始 URL 的 origin。协议拒绝 `file:` 和 URL 内嵌用户名/密码。策略约束顶层导航（含重定向与弹窗），不把子资源请求作为网络沙箱；测试不可信页面需额外的主机/网络隔离。

省略 `accountId` 和 `selector` 创建匿名独立会话（可通过 `allowAnonymous: false` 禁用），适用于任意应用的登录页、公共页面或临时场景。

## 调用协议

除 `/health` 外均需 `Authorization: Bearer <token>`。JSON 成功响应是 `{ "data": ... }`；错误响应是 `{ "error": { "code", "message" }, "requestId" }`。所有 POST 都需 `Content-Type: application/json` 和 `Idempotency-Key`（1–128 个非空 ASCII 可打印字符）。重试同一操作必须沿用同一个 key 和请求体；请求体变化返回 409。幂等范围为调用方 + 路由 + 当前服务生命周期，包括仍在执行中的请求；DELETE 关闭会话本身可重复调用。

| 方法/路径 | 能力 |
|---|---|
| `GET /v1/capabilities` | 当前运行能力、配置限制、模型是否配置 |
| `GET /v1/accounts` | 调用方可用账号的非敏感元数据和占用状态 |
| `POST /v1/sessions` | 创建会话并获取账号租约 |
| `GET /v1/sessions`、`GET /v1/sessions/{id}` | 读取自己的会话 |
| `POST /v1/sessions/{id}/renew` | 延长租约，体为 `{"ttlSeconds":900}` |
| `DELETE /v1/sessions/{id}` | 取消排队操作、关闭浏览器、归还账号 |
| `POST /v1/sessions/{id}/jobs` | 提交步骤，202 返回作业句柄 |
| `GET /v1/jobs/{id}` | 查询执行状态和结果 |
| `POST /v1/jobs/{id}/cancel` | 请求体 `{}`；运行中取消会销毁整个会话 |
| `GET /v1/artifacts/{id}` | 下载自己作业的 PNG 截图或 HTML 回放 |

创建会话：

```json
{ "selector": { "env": "staging", "roles": ["owner"], "tags": ["example-app"] }, "ttlSeconds": 900 }
```

也可使用 `{"accountId":"auto-test-account-1"}`，或匿名会话 `{"url":"https://example.org/"}`。`accountId` 与 `selector` 互斥，所有 selector 条件按 AND 匹配；没有空闲账号返回 `409 ACCOUNT_BUSY`，不抢占已有租约。

提交测试：

```json
{
  "timeoutSeconds": 300,
  "steps": [
    { "type": "navigate", "url": "https://example.org/" },
    { "type": "fill", "selector": "input[name=search]", "value": "test" },
    { "type": "press", "selector": "input[name=search]", "key": "Enter" },
    { "type": "assert", "prompt": "搜索结果列表显示了与 test 相关的条目" },
    { "type": "query", "prompt": "提取前 3 条结果的标题，返回字符串数组" },
    { "type": "screenshot", "fullPage": true }
  ]
}
```

支持步骤：`navigate(url)`、`click(selector)`、`fill(selector,value)`、`press(selector,key)`、`select(selector,value)`、`snapshot`、`screenshot(fullPage?)`，以及 AI `act/assert/wait/query(prompt)`。selector 使用 Playwright 字符串选择器；snapshot 返回 URL、标题、可访问性树。初版每个会话操作一个主页面，不提供任意脚本、CDP、文件系统路径、文件上传下载或标签页切换接口。

同会话按提交顺序串行；不同会话受 `maxConcurrentJobs` 限流。轮询到终态且 `finishedAt` 已存在时读取最终结果。断言不成立返回 `failed` 并保留 `pass:false`，停止剩余步骤。操作异常/超时/运行中取消会关闭会话，阻止后续任务使用不确定页面状态；已经发生的业务操作不能回滚。`timed_out` 表示未能在期限内确认完成，不表示操作从未发生，不能自动用新 key 重放。

模型由主机统一配置，通用 AI 上下文通过 `aiContext` 定义，既有 Tutti 回归流程的默认上下文保持兼容。AI 回放使用既有 Midscene 机制，执行成功的 AI 步骤可返回报告产物。`modelConfigured` 只说明配置字段齐备，不代表网关或模型推理健康。

## 生命周期与恢复边界

- 租约默认 900 秒，上限 3600 秒；未续约会自动关闭浏览器。作业默认 300 秒，上限 600 秒，执行时限从出队开始计算，租约到期仍会中断作业。
- 默认最多 6 个会话、2 个并发作业和 100 个排队作业，可通过配置调整；有头模式应设置 `maxConcurrentJobs: 1`，避免系统剪贴板竞争。
- `maxRecords` 默认 10000，限制当前进程保存的会话、作业和幂等记录数量。达到上限后拒绝新建，需要在任务结束后正常重启。当前不自动删除历史记录和产物；磁盘留存由执行机维护。
- 作业结果落在 `.service/jobs/`，产物在 `.service/artifacts/`。原始请求中的 fill 值/提示词不写进结果文件，但截图、AI 查询结果和报告仍可能包含测试数据，应按敏感测试产物管理。
- 会话、作业 API 句柄和幂等缓存目前在内存中；重启后不恢复句柄或自动重放任务。需要重启后通过 API 检索历史/分布式调度时，在 service 层增加持久化存储，而不修改浏览器或业务测试逻辑。
- `SIGINT/SIGTERM` 会停止接单、取消作业、关闭浏览器。清理失败会隔离账号并保留锁，防止再次分配；可重试 DELETE 会话关闭。
- 崩溃遗留的 `server.lock` 和账号租约不会被自动抢占。主机运维必须确认对应 `owner.json` 中的进程和遗留测试浏览器均已停止，核对未知业务操作结果，再删除对应锁目录。不要在浏览器仍运行时删锁。它们的存在是“状态待确认”，不能当作任务成功。
- 账号目录在启动时读取；添加账号或更改权限配置需要正常重启。凭据在新建会话时读取。

## 验证

```bash
pnpm typecheck
pnpm test
node scripts/service-smoke.ts
node scripts/service-smoke.ts --ai --env-file /absolute/path/to/model.env
```

smoke 使用临时 HTTP 站点、临时账号 storage state 和真实 Chromium，经完整 HTTP 接口验证输入、点击、快照、截图、下载、关闭和账号归还；`--ai` 额外验证视觉断言与结构化查询。测试结束删除临时数据，不操作线上业务。
