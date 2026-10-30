# tutti-qa

Tutti 用例生成工具。用例库在 tutti.sh 用例管理平台上，通过 `tutti-ops test-management` 读写。

## 目录

- `baseline/commits.json`：各仓库的基准 commit（diff 起点），只通过 `case_tool.py baseline set` 修改
- `baseline/*.pos`、`baseline/archive/`：迁移到平台前的 ProcessOn 用例库，已冻结，仅作历史记录和 `regress/` 的用例来源
- `output/<日期>-<序号>/`：每批的变更清单、走查截图、平台快照、确认页、spec、写入日志、核对结果与说明
- `.claude/skills/tutti-diff-testcase/`：按代码 diff 维护平台用例库的 skill
  - `SKILL.md`：流程（QA 声明范围 → 直接阅读 diff、相关 PR 和 commit，必要时补读代码和测试 → 在浏览器里过一遍功能并截图 → 提问 QA 本批更新哪些模块及待确认项 → 生成用例改动 → HTML 用例确认 → 经 tutti-ops 写入平台 → 回读核对 → 前移基准）
  - `references/conventions.md`：用例编写约定，复杂度对标用例库里的完整用例
  - `references/module-map.json`：代码路径 → 用例模块映射（分析辅助，不作为变更筛选依据）
  - `scripts/`：`collect_changes.py`、`render_case_titles.py`（标题树形确认页，默认全选、一键复制）、`render_cases.py`（详细确认页）、`apply_case_confirm.py`、`case_tool.py`（基准、平台快照、校验、写入、回读核对）、`diff_digest.py`
- `.claude/skills/tutti-qa-setup/`：执行机初始化（工具链、regress 依赖、模型、ego lite、账号 profile 与 Space），入口 `scripts/setup.sh`，详见其 `SKILL.md`
- `regress/`：基于 Midscene 的回归工具、执行 Plan 与本地校验，详见 `regress/README.md`
- `regress/SERVICE.md`：本机账号池与通用浏览器测试 HTTP API（会话租约、确定性/AI 步骤、作业与产物）
- `cli/`：独立外部 CLI，提交目标，由执行机运行 Codex + ego lite 走查或 Midscene + ego lite 测试，详见 `cli/README.md`

## 用法

在本目录启动 Claude Code，例如：

> 同步最新代码到用例库。新增：无；删除：活动看板/任务看板（房间内）（草版）

依赖：`git`、`gh`（需有 tutti-lab/tutti、tsh-web、tutti-server 的读权限）、Python 3、`tutti-ops`（已登录，需 `test_management` 读写权限）。

工作流程图：[docs/testcase-generation-flow.svg](docs/testcase-generation-flow.svg)
