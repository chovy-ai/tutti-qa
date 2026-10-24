# 把 .pos 用例编译成 Plan

`sync` 报出「缺失」或「内容已变化」的用例需要（重新）编译。编译由 Agent 完成，产物是 `plans/<suite>/<id 前 8 位>.yaml`，提交前需人工审核。

## 流程

1. `node src/cli.ts sync --suite <suite>`，拿到缺失 / 失效清单。
2. `node src/cli.ts cases --suite <suite> --id <caseId>` 导出用例 JSON（含 `sourceHash`）。
3. 按下面的规则写 Plan，文件头用注释贴上用例路径、前置、操作与预期原文，方便审核对照。
4. `node src/cli.ts sync --suite <suite>` 必须显示「缺失 0，失效 0」；`pnpm test` 通过。
5. 用 `run --only <caseId>` 实跑一次，确认失败是产品或口径问题而不是 Plan 写错。

## 规则

- **前置条件优先用 flow**（`src/flows.ts`）。flow 不够用时先在 flow 库里补，再在 Plan 里引用；不要在多个 Plan 里重复写同一段前置操作。
- **每条预期都要有归属**：至少一个 `assert` 或 `check` 的 `n` 指向它，或在 `uncovered` 里写明为什么不能自动断言。
- **断言只写业务结果**，不写 selector、像素位置或与判定无关的样式细节；文案断言照抄用例里写死的口径（如 `Delete this room`），不要替产品改口径。
- **确定性的东西用 `check`**：剪贴板里的链接、密码、房间名比对，不交给视觉模型。
- **实时同步类断言加 `waitMs`**，并在断言里写明「（未刷新页面）」，执行时也不要插入 `reload`。
- **数据名用 `{{tag}}`** 或由 `createRoom` 生成。它们按用例固定（每个 actor 都是新用户，不会撞名），提示词每次一致才能命中缓存；不要在 act 里拼时间戳或随机值。
- **带「如果…」分支的 act 写 `cache: false`**，否则缓存会把第一次走的分支固化下来。
- **每个 actor 都是一个新用户**；`owner#2` 表示同一用户的第二个标签页。只为用例确实需要的角色建 actor（每个 actor 都会在线上新建一个用户）。
- 无法在当前环境自动化的用例写成 `mode: manual` 并给出 `reason`：故障注入、绕过前端调接口、席位占满、依赖 Computer 或 Agent 运行时等。

## Plan 结构

```yaml
case: <pos 节点 id>
title: <用例标题>
sourceHash: <cases 命令输出的 sourceHash>
mode: auto            # auto | manual
reason: ""            # manual 必填
requires: []          # 需要的环境能力，环境不具备时跳过
actors: [owner, member]
setup:                # 前置；失败记为阻塞。不允许出现 assert / check
  - { actor: owner, flow: createRoom, save: room }
steps:                # 操作与断言；操作失败记为失败
  - { actor: owner, act: "点击菜单中的删除" }
  - { actor: owner, act: "如果出现确认弹窗就点确认", cache: false }
  - { actor: owner, n: 1, assert: "弹出确认弹窗，标题为 Delete this room" }
  - { n: 2, check: { op: contains, left: "{{invite.invite}}", right: "{{room.name}}" } }
  - { actor: member, reload: true }
uncovered:
  - { n: 3, reason: "需要跨天执行" }
```

可用变量：`{{tag}}`（用例 id 前 6 位，每次 Run 一致）、`{{rand.pin}}`（由用例 id 派生的固定 6 位数字）、`{{today.date}}`（环境时区的 YYYY-MM-DD）、`{{<actor>.displayName}}`，以及 flow 通过 `save` 写入的结果（如 `{{room.name}}`、`{{invite.link}}`、`{{invite.password}}`）。

`check.op`：`empty`、`nonEmpty`、`equals`、`notEquals`、`contains`、`notContains`、`matches`（正则）。
