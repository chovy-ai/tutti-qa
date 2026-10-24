// 报告：result.json 是机器可读的权威结果，report.html 是给人看的汇总；
// 逐步回放用 Midscene 自带的报告，按用例合并成一份 midscene-report.html。
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReportMergingTool } from "@midscene/core/report";
import { type CacheStats, hitRate } from "../ai/cache.ts";
import type { CaseResult, CaseStatus, RunResult } from "./runner.ts";

export const MIDSCENE_REPORT = "midscene-report";

type MidsceneStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

/** 五态判定映射到 Midscene 报告的测试状态；阻塞与待复核不是产品结论，记为 interrupted。 */
export function midsceneStatus(status: CaseStatus): MidsceneStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "blocked":
    case "uncertain":
      return "interrupted";
  }
}

/** 把每条用例各 actor 的 Midscene 报告合并为一份，用例标题、判定与耗时写进报告属性。没有可合并的报告时返回 null。 */
export function mergeRunReports(runDir: string, result: RunResult): string | null {
  const tool = new ReportMergingTool();
  let count = 0;
  for (const item of result.cases) {
    for (const report of item.reports) {
      const reportFilePath = join(runDir, report);
      if (!existsSync(reportFilePath)) continue;
      tool.append({
        reportFilePath,
        reportAttributes: {
          testId: `${item.id}:${report}`,
          testTitle: `${STATUS_LABEL[item.status]} · ${item.title}`,
          testDescription: item.path.join(" / "),
          testStatus: midsceneStatus(item.status),
          testDuration: item.durationMs
        }
      });
      count += 1;
    }
  }
  if (count === 0) return null;
  return tool.mergeReports(MIDSCENE_REPORT, { outputDir: runDir, overwrite: true });
}

/** 会话里每次单步命令各产出一份 Midscene 报告，按时间顺序合并成一份回放。 */
export async function mergeSessionReports(midsceneDir: string, outputDir: string): Promise<string | null> {
  const reportDir = join(midsceneDir, "report");
  const files = (await readdir(reportDir).catch(() => [] as string[])).filter((file) => file.endsWith(".html")).sort();
  if (files.length === 0) return null;
  const tool = new ReportMergingTool();
  for (const file of files) {
    tool.append({
      reportFilePath: join(reportDir, file),
      reportAttributes: { testId: file, testTitle: file.replace(/\.html$/u, ""), testDescription: "", testStatus: "passed", testDuration: 0 }
    });
  }
  return tool.mergeReports(MIDSCENE_REPORT, { outputDir, overwrite: true });
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  passed: "通过",
  failed: "失败",
  blocked: "阻塞",
  uncertain: "待复核",
  skipped: "跳过"
};

const EXPECT_LABEL = {
  passed: "✅",
  failed: "❌",
  uncertain: "❓",
  "not-run": "—",
  manual: "👤"
} as const;

/** 「有效命中率 62% · 规划 3/3 · 定位 4/8 · 回退 0」；没有任何查找时返回空串。 */
export function describeCache(stats: CacheStats | undefined): string {
  if (!stats) return "";
  const rate = hitRate(stats);
  if (rate === null) return "";
  const plan = `${stats.plan.hit}/${stats.plan.hit + stats.plan.miss}`;
  const locate = `${stats.locate.hit}/${stats.locate.hit + stats.locate.miss}`;
  return `有效命中率 ${Math.round(rate * 100)}% · 规划 ${plan} · 定位 ${locate} · 回退 ${stats.plan.fallback + stats.locate.fallback}`;
}

export function summarize(result: RunResult): Record<CaseStatus, number> {
  const counts: Record<CaseStatus, number> = { passed: 0, failed: 0, blocked: 0, uncertain: 0, skipped: 0 };
  for (const item of result.cases) counts[item.status] += 1;
  return counts;
}

export async function writeReport(runDir: string, result: RunResult): Promise<void> {
  let merged: string | null = null;
  try {
    merged = mergeRunReports(runDir, result);
  } catch (error) {
    // 合并失败不影响汇总报告，逐条回放链接仍然可用
    console.error(`Midscene 报告合并失败：${(error as Error).message}`);
  }
  await writeFile(join(runDir, "report.html"), renderHTML(result, merged ? `${MIDSCENE_REPORT}.html` : null), "utf8");
}

function renderHTML(result: RunResult, mergedReport: string | null): string {
  const counts = summarize(result);
  const manualExpects = result.cases.flatMap((item) => item.expects).filter((item) => item.status === "manual").length;
  const leftovers = result.cases.flatMap((item) => item.leftovers.map((left) => `${item.title}：${left}`));
  const groups = new Map<string, CaseResult[]>();
  for (const item of result.cases) {
    const key = item.path.slice(0, 2).join(" / ");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>回归报告 ${esc(result.runId)}</title>
<style>
body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;margin:32px;color:#1f2328;max-width:1200px}
h1{font-size:22px;margin:0 0 4px}.meta{color:#656d76;margin-bottom:20px}
.tiles{display:flex;gap:12px;margin:16px 0 24px}.tile{border:1px solid #d0d7de;border-radius:8px;padding:10px 16px;min-width:88px}
.tile b{display:block;font-size:22px}.passed{color:#1a7f37}.failed{color:#cf222e}.blocked{color:#9a6700}.uncertain{color:#8250df}.skipped{color:#656d76}
table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border-bottom:1px solid #eaeef2;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600}details summary{cursor:pointer}ul{margin:4px 0;padding-left:18px}.muted{color:#656d76}
.warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:8px;padding:10px 14px;margin-bottom:16px}
</style></head><body>
<h1>Tutti 功能回归报告</h1>
<div class="meta">Run ${esc(result.runId)} · 环境 ${esc(result.env)} · 用例集 ${esc(result.suite)} · 模型 ${esc(result.model || "未配置")}<br>
${esc(result.startedAt)} → ${esc(result.finishedAt)}${result.cache ? `<br>缓存 ${esc(result.cache.strategy)}${result.cache.strategy !== "off" ? `（共享 flow ${result.cache.flowWritable ? "可写" : "只读"}）` : ""}${describeCache(result.cache.stats) ? ` · ${esc(describeCache(result.cache.stats))}` : ""}` : ""}${mergedReport ? ` · <a href="${esc(mergedReport)}">Midscene 合并回放</a>` : ""}</div>
${result.status === "blocked" ? `<div class="warn">整体阻塞：${esc(result.blockedReason ?? "")}</div>` : ""}
${leftovers.length ? `<div class="warn">以下测试数据未能清理，需要人工处理：<ul>${leftovers.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
${result.cleanup.errors.length ? `<div class="warn">登录码回收失败：<ul>${result.cleanup.errors.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
<div class="tiles">${(Object.keys(STATUS_LABEL) as CaseStatus[])
    .map((key) => `<div class="tile ${key}"><b>${counts[key]}</b>${STATUS_LABEL[key]}</div>`)
    .join("")}<div class="tile"><b>${manualExpects}</b>人工预期</div></div>
${[...groups.entries()].map(([group, items]) => renderGroup(group, items)).join("\n")}
</body></html>
`;
}

function renderGroup(group: string, items: CaseResult[]): string {
  return `<h2>${esc(group)}</h2><table><thead><tr><th style="width:26%">用例</th><th style="width:8%">结果</th><th>预期与判定</th></tr></thead><tbody>
${items.map(renderCase).join("\n")}
</tbody></table>`;
}

function renderCase(item: CaseResult): string {
  const expects = item.expects
    .map((expect) => `<li>${EXPECT_LABEL[expect.status]} ${esc(expect.text)}${expect.detail ? `<div class="muted">${esc(expect.detail)}</div>` : ""}</li>`)
    .join("");
  const evidence = [
    ...item.reports.map((report) => `<a href="${esc(report)}">Midscene 回放 ${esc(report.split("/").pop() ?? "")}</a>`),
    ...(item.issues.length
      ? [`<details><summary>${item.issues.length} 条网络/页面异常</summary><ul>${item.issues
          .map((issue) => `<li>[${esc(issue.actor)}] ${esc(issue.kind)} ${esc(issue.detail)}</li>`)
          .join("")}</ul></details>`]
      : [])
  ];
  return `<tr><td>${esc(item.title)}<div class="muted">${esc(item.path.slice(2).join(" / "))}<br>${esc(item.id)} · ${Math.round(item.durationMs / 1000)}s${describeCache(item.cache) ? `<br>缓存：${esc(describeCache(item.cache))}` : ""}</div></td>
<td class="${item.status}">${STATUS_LABEL[item.status]}</td>
<td>${item.reason ? `<div class="${item.status}">${esc(item.reason)}</div>` : ""}<ul>${expects}</ul>${evidence.join(" · ")}</td></tr>`;
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
