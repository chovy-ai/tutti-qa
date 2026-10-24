# tutti-regress

基于 Midscene 的功能回归：把 `baseline/*.pos` 里的 P0 用例编译成 Plan，在指定环境上用全新测试用户执行，产出报告。

```
.pos 用例库 ──sync──▶ Plan（plans/<suite>/*.yaml，人工审核后入库）
                         │
环境配置 envs/*.json ────┤
                         ▼
run：预检 → 申请登录码（新用户）→ 前置 flow → 操作/断言 → 清理房间 → 回收登录码 → report.html + result.json
```

## 分工：哪些是代码，哪些是 AI

| 环节 | 实现 | 位置 |
|---|---|---|
| 用例抽取、内容指纹、Plan 校验 | 代码 | `src/pos.ts`、`src/plan.ts` |
| 测试身份（tutti-ops 登录码 → session Cookie） | 代码 | `src/identity.ts` |
| 前置条件与清理（建房、开面板、复制邀请、加入…） | 代码维护的固定流程，内部用 Midscene 操作页面 | `src/flows.ts` |
| 用例里的具体操作与视觉断言 | Midscene `aiAct` / `aiAssert` | Plan 的 `act` / `assert` |
| 剪贴板内容、链接/密码等确定性断言 | 代码 | Plan 的 `check` |
| 判定、资源台账、报告 | 代码 | `src/runner.ts`、`src/ledger.ts`、`src/report.ts` |
| .pos 用例 → Plan 编译 | Agent 按 [COMPILE.md](COMPILE.md) 编译，人工审核 | `plans/` |

**页面改版时先改 `src/flows.ts`**，Plan 和 .pos 用例通常不用动。

## 准备

```bash
pnpm install
pnpm exec playwright install chromium
tutti-ops auth status        # 需要 access 模块写权限（申请/删除登录码）
```

模型通过 `regress/.env` 配置（模板见 `.env.example`），其中的 `MIDSCENE_*` 会覆盖 shell 里的同名变量。推荐复用本机 sub2api（`http://127.0.0.1:8080/v1`，分组 codex，`gpt-6.1-sol`），并设置 `MIDSCENE_MODEL_REASONING_ENABLED=false`；本机已登录 Codex CLI 时也可以用 `codex://app-server`。

## 命令

```bash
node src/cli.ts doctor  --env prod                     # 检查模型、tutti-ops、环境入口
node src/cli.ts sync    --suite room-p0 [--scaffold]   # .pos 与 Plan 对账：缺失 / 内容变化 / 孤儿
node src/cli.ts cases   --suite room-p0 [--id <id>]    # 导出用例 JSON，给编译用
node src/cli.ts run     --env prod --suite room-p0 [--only id前缀,...] [--timeout-min 10] [--concurrency 10]
node src/cli.ts report  --run <runId>                  # 由 result.json 重新生成 report.html
node src/cli.ts cleanup --env prod --run <runId>       # 补清理：为台账里的测试用户补发登录码并清空房间
```

并行：每个 worker 独占一个浏览器进程（隔离剪贴板），用例之间本来就是不同的测试用户。并发数默认取 `REGRESS_CONCURRENCY`（10），上限取决于模型网关能同时服务的请求数，超过只会在网关排队。

`run` 的退出码：`0` 全部通过，`1` 有失败，`2` 有阻塞 / 待复核 / 整体阻塞。产物在 `.runs/<runId>/`：
`report.html`、`result.json`、`ledger.jsonl`（创建过的登录码与房间）、`midscene/report/*.html`（每个 actor 的逐步回放）。

## 判定口径

| 状态 | 含义 |
|---|---|
| 通过 | 所有可自动断言的预期都通过 |
| 失败 | 操作步骤执行失败，或任一断言不通过 —— 需要研判是产品缺陷还是用例口径过期 |
| 阻塞 | 前置条件无法达成、超时 —— 环境或 flow 的问题，不代表产品缺陷 |
| 待复核 | 模型调用失败等无法给出判定的情况 |
| 跳过 | 人工用例、Plan 缺失或已过期、环境缺少能力 |

预期条目上 👤 表示该条在 Plan 里标为 `uncovered`（例如跨天、跨截图比对），需要人工补测。

## 环境与数据

- 每个 actor 是一个通过 `tutti-ops access login-codes create` 新建的用户，昵称形如 `QA owner 092921`。
- Run 结束后会删除登录码；房间由 `clearRooms` 清空（房主删除、成员离开）。清理失败的数据会出现在报告顶部，用 `cleanup` 命令补救。
- 新建的用户本身无法删除，会留在线上。
- 线上房间默认建为 **My cloud rooms**；Local rooms 需要绑定 Computer，新用户没有。
- 环境能力（`envs/*.json` 的 `capabilities`）决定带 `requires` 的 Plan 是否执行。
