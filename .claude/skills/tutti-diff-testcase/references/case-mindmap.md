# HTML 用例勾选思维导图

用户要求思维导图、全量用例导图或复用 HTML 模板时，使用 `scripts/render_case_mindmap.py` 和 `assets/case-mindmap/`。模板源自已确认的紧凑版；输入业务数据，复用样式、布局和交互。普通标题树形确认页继续用 `render_case_titles.py`。

## 生成

`$S` 是本 skill 的 `scripts` 目录。把本次范围内的完整用例准备为 `cases.json`；要求全量时，包含本批未修改但仍有效的已有用例。不要把 `spec.json` 的修改列表当成完整用例库。

```bash
python3 "$S/render_case_mindmap.py" "$B/cases.json" \
  --title "游客模式完整用例" -o "$B/cases-mindmap.html"
```

输入为用例数组，或 `{"cases": [...]}`。每条：

```json
{
  "id": "原用例稳定ID",
  "title": "开启游客模式并完成首次加入",
  "category": "游客配置与邀请",
  "group": "房间 / 游客访问 / 游客模式与讨论权限",
  "scene": "正常场景",
  "priority": "P0",
  "kind": "功能回归",
  "pre": "完整前置条件",
  "steps": ["完整操作步骤"],
  "expect": ["完整预期结果"],
  "note": ""
}
```

`id/title/group/scene/priority` 必填；也可以直接用 `case_tool.py pull` 导出的平台模块 JSON（`precondition` / `expectations` 等价于 `pre` / `expect`）；`scene` 是正常场景、异常场景或边界场景；`kind` 默认为功能回归，也支持专项验证。`category` 可选，缺省使用 `module` 或 `group` 的第一段；它只控制导图分组，不改宿主库路径。前置、步骤、预期和备注来自最终用例，详情面板展示全文。数量与模块从输入生成，不固定游客模式、118 条或本轮批次。

## 勾选与导出

- 每个节点前有独立复选框；默认全部使用。取消父节点时本节点和所有后代一起取消，勾选父节点时全部选中，部分子节点选中时父节点半选。
- 父节点操作按全部后代计算，包含折叠或被筛选隐藏的用例。标题用于展开或查看详情，复选框点击不触发展开；搜索、展开、收起不会改勾选。
- localStorage 可用时保存选择；受限时本页仍可使用，提示导出或保存勾选版 HTML。保存版嵌入选择快照；无存储时也能恢复。自动复制失败时显示可手动复制的全文，下载只提示已发起。
- 没有确认映射时导出 `TUTTI-QA-SELECTION` 清单，仅记录是否使用。该清单不直接交给 `apply_case_confirm.py`，也不表示可以合并。

需要导出本 skill 的确认协议时，同时传入原 spec 与映射：

```bash
python3 "$S/render_case_mindmap.py" "$B/cases.json" \
  --title "游客模式完整用例" \
  --confirmation "$B/confirmation-meta.json" --spec "$B/spec.json" \
  -o "$B/cases-mindmap.html"
```

`confirmation-meta.json` 结构：

```json
{
  "batch": "本次批次",
  "hash": "原始spec文件字节的SHA256前16位",
  "cases": [{"id": "原用例稳定ID", "keys": ["U0"]}, {"id": "新用例ID", "keys": ["C0"]}],
  "extraKeys": {},
  "allKeys": ["U0", "C0"]
}
```

每条用例的更新是一个 key，无改动用例可用空 `keys`。需要多条用例共同决定的 key 放 `extraKeys`，只要有一个所属用例保留就保留。每个 key 只映射一次，`allKeys` 完整覆盖 spec 中的新增 `C<n>`、更新 `U<n>`、归档 `R<n>`，保留原顺序。生成器检查指纹、ID 与 key 覆盖；映射由本批真实 spec 与快照推导，不手写猜测。

有映射时复制结果携带 `TUTTI-QA-CASES`、batch/hash 和全部 key/keep，包括未选项。QA 真实粘回后仍按主流程检查并解析；仅生成页面、默认全选、复制或保存均不等于确认，不写入平台、不改 baseline。

## 紧凑布局与检查

保留模板的 16px 复选框、紧凑内边距和按实际高度计算的分支间距。计数先填入再测量。隐藏预览面板读到零高度时暂缓布局；重新显示、文字换行或字体尺寸变化后由 ResizeObserver 重排。保留待布局标记，即使恢复后的高度与隐藏前相同，也要给新建节点计算坐标。

生成后检查 JavaScript 语法，并在实际浏览器验证：正常总览、全部展开、面板初始隐藏后显示、隐藏期间重新渲染、窄面板、长标题换行。检查每个可见节点的坐标有效、卡片互不重叠，父子勾选和导出一致。模拟选择用独立 suiteId 或测试文件，避免改掉 QA 已保存的选择。

渲染器与选择模型的可重复测试：

```bash
python3 -m unittest discover -s "$S/../tests" -p 'test_*.py'
node "$S/../tests/test_case_selection.cjs"
```

生成单文件 HTML，内联数据、CSS、JS；无需 CDN、网络或安装前端依赖。交付已验证的绝对文件链接。Multica 已打开的页签可能仍显示旧内容，修订时可另存新文件名供重新打开。
