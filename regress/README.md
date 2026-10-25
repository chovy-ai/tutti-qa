# tutti-regress

基于 Midscene 的功能回归：把 `baseline/*.pos` 里的 P0 用例编译成 Plan，在指定环境上用全新测试用户执行，产出报告。

```
.pos 用例库 ──sync──▶ Plan（suites/<suite>/plans/*.yaml，人工审核后入库）
                         │
环境配置 envs/*.json ────┤
                         ▼
run：预检 → 申请登录码（新用户）→ 前置 flow → 操作/断言 → 清理房间 → 回收登录码 → report.html + result.json
```

## 目录

```
regress/
├─ envs/<env>.json                 环境：入口、账号服务、时区、能力
├─ suites/<suite>/
│   ├─ suite.json                  从 .pos 的哪个子树取哪些优先级的用例
│   ├─ plans/<id 前 8 位>.yaml      可执行 Plan（人工审核后入库）
│   └─ cache/<env>/                该 suite 的用例缓存（入库）
├─ flows-cache/<env>/              共享 flow 缓存（入库）
├─ fixtures/                       上传用的测试文件
├─ src/
│   ├─ cli.ts                      命令入口
│   ├─ core/                       环境与 suite、.pos 用例抽取、Plan 模型与校验、资源台账
│   ├─ identity/                   原子能力：测试身份（登录码 → session）
│   ├─ browser/                    原子能力：独立浏览器会话；run 内的 actor
│   ├─ ai/                         原子能力：Midscene agent、单步操作、缓存与命中统计
│   ├─ flows/                      公共前置流程与清理
│   └─ run/                        编排与判定、事后清理、报告
├─ test/                           单元测试
└─ 本机（不入库）：.env  .runs/  .identities/  .sessions/  .local-cache/
```

## 分工：哪些是代码，哪些是 AI

| 环节 | 实现 | 位置 |
|---|---|---|
| 用例抽取、内容指纹、Plan 校验 | 代码 | `src/core/pos.ts`、`src/core/plan.ts` |
| 测试身份（tutti-ops 登录码 → session Cookie） | 代码 | `src/identity/` |
| 独立浏览器会话（单独进程、CDP 接入） | 代码 | `src/browser/session.ts` |
| Midscene agent（上下文提示、缓存、报告）与单步操作 | Midscene | `src/ai/midscene.ts`、`src/ai/cache.ts` |
| 前置条件与清理（建房、开面板、复制邀请、加入…） | 代码维护的固定流程，内部用 Midscene 操作页面 | `src/flows/flows.ts` |
| 用例里的具体操作与视觉断言 | Midscene `aiAct` / `aiAssert` | Plan 的 `act` / `assert` |
| 剪贴板内容、链接/密码等确定性断言 | 代码 | Plan 的 `check` |
| 判定、资源台账 | 代码 | `src/run/runner.ts`、`src/core/ledger.ts` |
| 报告（汇总 + Midscene 合并回放） | 代码 + Midscene `ReportMergingTool` | `src/run/report.ts` |
| .pos 用例 → Plan 编译 | Agent 按 [COMPILE.md](COMPILE.md) 编译，人工审核 | `suites/<suite>/plans/` |

**页面改版时先改 `src/flows/flows.ts`**，Plan 和 .pos 用例通常不用动。

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
`report.html`、`result.json`、`ledger.jsonl`（创建过的登录码与房间）、`midscene/report/*.html`（每个 actor 的逐步回放）、`midscene-report.html`（全部回放按用例合并，用例判定写在报告标题里）。

## 原子能力

不写 Plan 也能按步骤直接调用，适合调试 flow、复现缺陷或给外部 Agent 使用。四块能力相互独立：

| 能力 | 命令 | 产物 |
|---|---|---|
| 测试身份 | `identity create` / `identity release` | `.identities/<batch>/identities.json`（含 session Cookie，0600，已 gitignore）与 `ledger.jsonl` |
| 浏览器会话 | `session start` / `list` / `stop` | 每个会话一个独立 Chromium 进程，常驻后台，`cdpUrl` 可供 Playwright `connectOverCDP` 或其他工具接入 |
| 视觉操作与断言 | `act` / `assert` / `wait` / `query` | 每次调用一份 Midscene 报告，写在 `.sessions/<id>/midscene/report/` |
| 截图 | `screenshot` | 会话当前页面的 jpg / png，写到 `--out` 指定的位置 |
| 报告 | `session report`、`report --run` | Midscene 合并回放 `midscene-report.html` |

```bash
node src/cli.ts identity create --env prod --names owner,member --batch demo   # 并发申请，输出 demo:owner、demo:member
node src/cli.ts session start --batch demo                                      # 为批次内全部身份并发启动浏览器
node src/cli.ts act    --session <id> "新建一个房间，名称为 demo"
node src/cli.ts assert --session <id> "左侧房间列表中出现房间 demo"               # 断言不通过时退出码为 1
node src/cli.ts query  --session <id> "左侧房间列表中所有房间的名称，字符串数组"
node src/cli.ts screenshot --session <id> --out shots/01-room-list.jpg            # 加 --full-page 截整页
node src/cli.ts session report --session <id>
node src/cli.ts session stop --all && node src/cli.ts identity release --batch demo
```

- 会话进程独立于 CLI，`act` 等命令每次通过 CDP 接入、执行完断开，页面状态保留。`--headed` 打开有头浏览器便于观察。
- 新建的用户无法删除，会留在线上；`identity release` 只回收登录码。会话里创建的房间不会自动清理，需要在会话中自行删除。
- 单步命令的 Midscene 缓存在 `.local-cache/sessions/<env>/`（只在本机），cacheId 默认为会话 id，可用 `--cache-id` 指定。

## 缓存

设置 `REGRESS_CACHE=read-write`（或 `read-only` / `write-only`）开启，默认关闭。缓存只覆盖「怎么操作」（aiAct 的规划与元素定位），断言、等待、查询每次都走模型。

```
suites/<suite>/cache/<env>/<用例id>-<actor>.cache.yaml   用例自己的 steps，入库；用例通过后清掉本次没用到的条目
flows-cache/<env>/flow-<flow>.cache.yaml                公共前置流程，跨用例共享，入库；只在 --concurrency 1 时写入，并发时只读
.local-cache/sessions/<env>/<cacheId>.cache.yaml        单步命令，只在本机
```

命中规则（Midscene 1.16）：同类型、提示词逐字相等（含 AI 上下文）才命中，同一提示词按出现顺序各用一条；本次新写入的条目下次 Run 才可用。xpath 在当前页面找不到元素、或缓存的规划回放失败时自动回退到 AI 并更新记录。

为了让提示词每次一致：

- 数据名按用例固定：`{{tag}}` 为用例 id 前 6 位，`createRoom` 默认房间名为 `<tag>-<序号>`，昵称为 `QA <actor> <tag>`，`{{rand.pin}}` 由用例 id 派生。actor 都是新用户，不会与其他 Run 撞名。
- 带「如果…」分支的操作不进缓存：flow 里用 `{ cacheable: false }`，Plan 的 act 步骤写 `cache: false`。
- `enterApp` 先用代码判断引导页与房间列表，失败时才交给 AI。
- 改动 `src/ai/midscene.ts` 里的 AI 上下文会让全部缓存失效。
- 用例与 flow 缓存随仓库提交，换机器或在 CI 上也能命中。多人同时更新同一缓存文件发生冲突时，任选一方的版本即可，下次 Run 会补齐。缓存里只有提示词、规划步骤与 xpath；每次都会变的房间密码等数据所在的步骤标了 `cache: false`，不会写进缓存。

新用例或改过的用例建议先 `--concurrency 1` 跑两遍预热：第一遍写入规划，第二遍回放时定位用的是带上下文的提示词，会再写一轮定位缓存，第三遍起完全命中。每次 Run 的命中情况写在 `result.json` 的 `cache` 字段与报告中（有效命中率 = 真正省掉模型调用的查找占比，回退不计入）。

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
