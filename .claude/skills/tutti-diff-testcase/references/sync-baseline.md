# 模块同步基准与首次迁移

当平台尚未初始化 `syncBaseline`、新增仓库，或发布此功能时读取本文。日常生成用例按 SKILL.md。

## 存储与协议

基准从仓库整体的一份 `baseline/commits.json` 改为每个模块一份 `syncBaseline`。模块之间可以有不同进度。数据存在现有 `qa_modules.payload`，没有新表、列、独立基准接口或平台基准历史。

| 旧概念 | 当前概念 |
|---|---|
| `commits.json.repos` | 模块 `syncBaseline.repos`，每次提交完整映射 |
| 仓库整体基准 | 所选模块各自的基准；收集时每仓库取 first-parent 历史上最旧 SHA |
| `commits.json.history` | 批次说明 + `baseline-log.json` 中各模块 from / 请求 / 回读状态 |
| 整批有延期就不前移 | 延期或部分取消的模块保留，已完整处理且写入核对的模块单独前移 |

读沿用 `GET /api/v1/test-management/modules` 和 `/modules/{id}`；写沿用 `POST /modules`、`PUT /modules/{id}`。CLI 的管理代理前缀是 `/api/admin/api/v1/test-management`。`brandId` 继续是必需 query，服务端解析可信 App ID。

```json
{
  "id": "module-id", "name": "当前名称", "description": "当前说明", "revision": 10,
  "syncBaseline": {
    "repos": {"tutti-lab/tutti": {"sha": "073e06fc68c9ed1c0e6500bd3cdf9dc4f10fb3fe", "branch": "main"}},
    "batch": "20261030-1", "note": "已分析并核对"
  }
}
```

接口边界保持不变：1–20 个 owner/repo，40 位完整 SHA，branch 缺省 main；batch 最多 128 字、note 最多 500 字。审计字段 `updatedBy/updatedAt` 由服务端填写；省略或 null 保留旧基准，原样回传保留原审计信息。更新需当前 revision，过期返回 409。用例写入也提升模块 revision，因此在 verify 后重新 GET 并比较，再提交完整元信息；不用过期快照覆盖名称、说明。此 QA 流程仅处理 main。

## 发布与初始化

1. 合入并部署 tsh-admin-server 的模块基准字段；再发布支持 `syncBaseline` 的 tutti-ops-cli，然后部署 web 和切换本 skill。CLI schema 能接受字段不代表后端已经部署。
2. 使用 `tutti-ops schema test-management.modules.update` 确认本机 CLI 支持该字段。可设置 `TUTTI_OPS_BIN` 指向已构建的 CLI 启动文件进行本地验证；不需要改全局安装。
3. 从当前品牌完整模块列表生成初始化计划，默认只读元信息并做各写请求的离线 dry-run：

   ```bash
   S=.claude/skills/tutti-diff-testcase/scripts
   python3 $S/case_tool.py --brand 233749 baseline init \
     --file baseline/commits.json --out output/baseline-init/plan.json
   ```

4. 把计划中的真实模块 ID、名称、当前 revision、仓库 SHA 和写入效果交给 QA 确认。确认后同一命令加 `--yes`。这是生产平台写入；初始化并不生成或修改用例。
5. 初始化跳过已与本次迁移目标完全一致的模块；遇到已有不同基准则整批预检停止，避免覆盖。每次写入携带刚读到的 revision，并立即 GET 核对；失败或未知结果停止，保留日志，先回读再继续。服务端不支持写入 requestId，本工具依靠 revision 和目标内容核对，不虚构幂等保证。
6. 执行 `baseline get --out output/baseline-init/baselines.json` 回读全量模块，与计划逐一核对模块 ID 集合、repos 和原 SHA。全部成功后才删除 `baseline/commits.json`；未完成时保留文件供续跑，但日常收集绝不回退读取它。

新增仓库须经 QA 确认后，为所选模块补齐相同仓库集合，再收集 diff。模块缺基准、仓库集合不齐、基准分叉或 head 回退时停下处理，不能忽略缺项。

## 按模块前移

`spec.baseline` 使用收集时固定的 head，`baseline_modules` 只列已完整分析且有实际用例写入的模块。`apply_case_confirm.py --snapshot` 会排除任何取消了部分条目的模块，包括新增、更新和归档；没有实际写入的模块保持原值。verify 必须绑定品牌、当前 spec 指纹、写入日志和导出后模块 revision。确认后发生并发编辑时重新 pull、分析、确认，不只替换 revision。

基准写入默认 dry-run；`--yes` 后各模块回读成功才记为 verified。部分完成时 `baseline-log.json` 记录每个目标和状态；再次执行先 GET，内容已是同一目标的模块跳过，其他模块仍检查核对 revision。基准无历史 API；恢复用例版本不会自动恢复基准，撤回必须参考批次 from 记录，经 QA 确认后单独恢复。

`regress/` 仍使用冻结的 `.pos`，不属于本次迁移。
