# tutti-qa

Tutti 测试用例库与用例生成工具。

## 目录

- `baseline/`：当前用例库（ProcessOn `.pos`，只保留一份），根下「📌 基准 Commit」节点记录各仓库的 diff 起点；`baseline/archive/` 是历史版本
- `output/<日期>-<序号>/`：每批的变更清单、确认页、spec、产物 `.pos` 与说明
- `.claude/skills/tutti-diff-testcase/`：按代码 diff 维护用例库的 skill
  - `SKILL.md`：流程（QA 声明范围 → 直接阅读 diff、相关 PR 和 commit，必要时补读代码和测试 → 在浏览器里过一遍功能并截图 → 提问 QA 本批更新哪些模块及待确认项 → 生成用例改动 → HTML 用例确认 → 合并校验 → 回写基准）
  - `references/conventions.md`：用例编写约定，复杂度对标用户提供的 `.pos` 完整用例
  - `references/module-map.json`：代码路径 → 用例模块映射（分析辅助，不作为变更筛选依据）
  - `scripts/`：`collect_changes.py`、`render_case_titles.py`（标题树形确认页，默认全选、一键复制）、`render_cases.py`（详细确认页）、`apply_case_confirm.py`、`pos_tool.py`、`diff_digest.py`
- `regress/`：基于 Midscene 的回归工具、执行 Plan 与本地校验，详见 `regress/README.md`

## 用法

在本目录启动 Claude Code，例如：

> 同步最新代码到用例库。新增：无；删除：活动看板/任务看板（房间内）（草版）

依赖：`git`、`gh`（需有 tutti-lab/tutti、tsh-web、tutti-server 的读权限）、Python 3。
