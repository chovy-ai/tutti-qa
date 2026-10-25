---
name: tutti-qa-setup
description: 初始化或检查 tutti-qa 执行机（Mac）：工具链、regress 依赖、模型网关、ego lite 浏览器与 ego-browser skill、账号池、每个账号的 ego lite profile 与 Space 登录态。用户提到「初始化执行机」「装环境」「setup」「检查环境是否就绪」「新增测试账号」「账号登录失效」时使用。
---

# tutti-qa 执行机初始化

所有安装与检查都由 `scripts/` 下的脚本完成，本文件只规定顺序、人工步骤和红线。脚本可以重复执行：已就绪的项跳过，缺什么补什么。

```bash
S=.claude/skills/tutti-qa-setup/scripts
$S/setup.sh --check          # 只检查，不改动
$S/setup.sh                  # 检查并补装
$S/setup.sh --only 50-ego    # 只跑某一步，可重复传
$S/setup.sh --with-regress   # 额外安装 regress 回归用的 Playwright Chromium
$S/setup.sh --json           # 结构化结果（人看的输出改到 stderr）
```

`--check` 不安装、不生成文件，但 `70-spaces` 仍会打开各 Space 的页面检查登录态。

退出码：`0` 全部就绪；`1` 有需要人工处理的项；`2` 有失败项。日志在 `~/.tutti-qa/setup.log`（可用 `TUTTI_QA_HOME` 改目录）。

## 步骤

| 脚本 | 自动做的 | 只检查、由人处理的 |
|---|---|---|
| `00-preflight` | — | macOS、芯片、磁盘空间，能否访问 github.com / tutti.sh / cdn.ego.app |
| `10-system` | — | 开机自动登录、FileVault（只提示，不阻塞；不改休眠设置） |
| `20-toolchain` | pnpm 缺失时用 corepack 启用 | git、curl、gh、python3、node（≥ `NODE_MIN`）。不使用 Homebrew，缺少时按提示安装 |
| `30-repo` | `regress` 的 `pnpm install`；`--with-regress` 时装 Playwright Chromium | — |
| `40-model` | 没有 `regress/.env` 时从模板生成（0600） | 填写模型 key；检查网关可用、模型支持图片输入 |
| `50-ego` | 用 `versions.env` 锁定 tag 的上游 `install.sh` 安装并打开 ego lite；给 Claude Code / Codex 全局安装 `ego-browser` skill | 首次引导（onboarding），它会把 `ego-browser` 注册到 `~/.local/bin` |
| `60-accounts` | 没有 `~/.tutti-qa/accounts.json` 时从模板生成（0600），校验字段 | 填写 QA 提供的账号 |
| `70-spaces` | 为每个账号在其 profile 下创建或认领同名 Space，打开目标环境检查登录态 | 在 ego lite 里为每个账号新建 profile；在对应 Space 里手动登录一次 |
| `80-auth` | — | `gh` 能读 tutti-lab，`tutti-ops` 已登录 |

## 流程

1. 执行 `setup.sh --check`，向用户汇报现状。
2. 执行 `setup.sh`。退出码 `1` 时，把输出末尾「需要人工处理」逐条告诉用户，用提问工具等用户确认处理完，再重跑对应步骤（`--only`）。退出码 `2` 时查日志定位，修不了的报告给用户。
3. 全部就绪后再执行一次 `setup.sh --check`，退出码为 `0` 才算完成。

## 账号、profile 与 Space

ego lite 的 Cookie 按 **profile** 隔离，同一 profile 下的 Space 共用登录态。所以每个账号要有自己的 profile，Space 在该 profile 下创建：

```json
{"name": "owner-pro", "profile": "owner-pro", "space": "owner-pro", "env": "prod",
 "roles": ["owner"], "capabilities": ["computer", "paid"], "note": "房主，绑定了本机 Computer"}
```

- `profile`：ego lite 里的 profile 名称或 id。profile 只能在 ego lite 应用里手动创建。
- `space`：Space 名称，唯一。ego lite 没有删除 Space 的接口，不要随意改名，否则旧 Space 会残留。`70-spaces` 检查后把 Space 交还给用户，未登录时人直接在这个 Space 的页面里登录。
- `env`：对应 `regress/envs/<env>.json`，决定打开哪个入口检查登录态。
- 账号文件只存非敏感字段；密码、登录码不写进任何文件，由人在浏览器里登录。

## 升级

改 `config/versions.env`（如 `EGO_LITE_TAG`），再执行 `setup.sh --only <对应步骤>`。`ego-browser` 提示版本过旧时，经用户确认后执行 `ego-browser upgrade`。

## 红线

- 不替人输入系统密码、账号密码，不代过人机验证。
- 不把 key、密码、Cookie、登录码写进仓库、日志或回复。
- 不改系统休眠、电源等设置。
- 不升级 `versions.env` 以外的版本，不安装脚本列表以外的软件。
- 不删除 ego lite 的 profile 或 Space，不清 Cookie；需要时先读 ego-browser 的 `references/clearing-state.md` 并征得用户同意。
