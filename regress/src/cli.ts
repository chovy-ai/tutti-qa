#!/usr/bin/env node
// tutti-regress：.pos P0 用例 → Plan → Midscene 执行 → 报告。
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { stringify } from "yaml";
import { loadEnv, loadSuite, missingModelEnv, regressRoot, suitePlansDir } from "./config.ts";
import { cleanupRun } from "./cleanup.ts";
import { opsWhoami } from "./identity.ts";
import { loadPlans, validatePlan } from "./plan.ts";
import { summarize, writeReport } from "./report.ts";
import { runSuite, suiteCases, type RunResult } from "./runner.ts";

const USAGE = `用法：
  regress doctor  --env <env>                         检查模型配置、tutti-ops 与环境入口
  regress cases   --suite <suite> [--id <caseId>]     导出用例 JSON（编译 Plan 的输入）
  regress sync    --suite <suite> [--scaffold]        核对 .pos 与 Plan：缺失 / 过期 / 失效；--scaffold 为缺失用例生成待编译占位
  regress run     --env <env> --suite <suite> [--only id,id] [--timeout-min 10]
  regress report  --run <runId>                       由 result.json 重新生成 report.html
  regress cleanup --env <env> --run <runId>           按台账补清理房间并回收登录码`;

// 本地 .env 只补充未设置的变量，命令行环境变量优先
const dotenv = join(regressRoot, ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string" },
    suite: { type: "string" },
    id: { type: "string" },
    only: { type: "string" },
    run: { type: "string" },
    scaffold: { type: "boolean" },
    "timeout-min": { type: "string" }
  }
});

const command = positionals[0];

switch (command) {
  case "doctor": {
    const env = await loadEnv(need("env"));
    const checks: [string, string | null][] = [];
    const missing = missingModelEnv();
    checks.push(["模型配置", missing.length ? `缺少 ${missing.join(", ")}` : null]);
    checks.push(["tutti-ops", await opsWhoami(env).then(() => null, (error: Error) => error.message)]);
    checks.push([
      "环境入口",
      await fetch(env.webUrl, { redirect: "manual" }).then(
        (response) => (response.status >= 500 ? `HTTP ${response.status}` : null),
        (error: Error) => error.message
      )
    ]);
    for (const [name, problem] of checks) console.log(`${problem ? "✗" : "✓"} ${name}${problem ? `：${problem}` : ""}`);
    process.exitCode = checks.some(([, problem]) => problem) ? 2 : 0;
    break;
  }
  case "cases": {
    const cases = await suiteCases(await loadSuite(need("suite")));
    const selected = values.id ? cases.filter((item) => item.id === values.id) : cases;
    console.log(JSON.stringify(selected, null, 2));
    break;
  }
  case "sync": {
    const suite = await loadSuite(need("suite"));
    const cases = await suiteCases(suite);
    const plans = await loadPlans(suitePlansDir(suite));
    const byCase = new Map(plans.map((item) => [item.plan.case, item]));
    const missing = cases.filter((item) => !byCase.has(item.id));
    const orphans = plans.filter((item) => !cases.some((source) => source.id === item.plan.case));
    const invalid = plans.flatMap((item) => {
      const problems = validatePlan(item.plan, cases.find((source) => source.id === item.plan.case));
      return problems.length ? [{ file: item.file, problems }] : [];
    });
    const modes = { auto: 0, manual: 0 };
    for (const { plan } of plans) modes[plan.mode] += 1;
    console.log(`用例 ${cases.length} 条；Plan ${plans.length} 个（auto ${modes.auto} / manual ${modes.manual}）`);
    console.log(`缺失 Plan ${missing.length}，失效 Plan ${invalid.length}，孤儿 Plan ${orphans.length}`);
    for (const item of missing) console.log(`  缺失  ${item.id}  ${item.title}`);
    for (const item of invalid) console.log(`  失效  ${item.file}\n        ${item.problems.join("\n        ")}`);
    for (const item of orphans) console.log(`  孤儿  ${item.file}`);
    if (values.scaffold) {
      for (const item of missing) {
        const file = join(suitePlansDir(suite), `${item.id.slice(0, 8)}.yaml`);
        if (await access(file).then(() => true, () => false)) continue;
        const stub = { case: item.id, title: item.title, sourceHash: item.sourceHash, mode: "manual", reason: "待编译" };
        await writeFile(file, stringify(stub), "utf8");
        console.log(`  已生成占位 ${file}`);
      }
    }
    process.exitCode = missing.length || invalid.length || orphans.length ? 1 : 0;
    break;
  }
  case "run": {
    const timeoutMin = Number(values["timeout-min"] ?? "10");
    const { runDir, result } = await runSuite({
      envId: need("env"),
      suiteId: need("suite"),
      only: values.only?.split(",").map((item) => item.trim()).filter(Boolean),
      caseTimeoutMs: timeoutMin * 60_000
    });
    printSummary(runDir, result);
    process.exitCode = exitCode(result);
    break;
  }
  case "report": {
    const runDir = resolve(regressRoot, ".runs", need("run"));
    const result = JSON.parse(await readFile(join(runDir, "result.json"), "utf8")) as RunResult;
    await writeReport(runDir, result);
    printSummary(runDir, result);
    break;
  }
  case "cleanup": {
    const result = await cleanupRun(need("run"), need("env"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.users.some((user) => user.error || user.leftovers.length) ? 1 : 0;
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command ? 64 : 0;
}

function need(key: "env" | "suite" | "run"): string {
  const value = values[key];
  if (!value) {
    console.error(`缺少 --${key}\n\n${USAGE}`);
    process.exit(64);
  }
  return value;
}

function printSummary(runDir: string, result: RunResult): void {
  const counts = summarize(result);
  console.log(
    result.status === "blocked"
      ? `整体阻塞：${result.blockedReason}`
      : `通过 ${counts.passed} · 失败 ${counts.failed} · 阻塞 ${counts.blocked} · 待复核 ${counts.uncertain} · 跳过 ${counts.skipped}`
  );
  console.log(`报告：${join(runDir, "report.html")}`);
}

/** 0 = 全部通过；1 = 有失败；2 = 有阻塞/待复核/整体阻塞（需要人看，但不一定是产品缺陷）。 */
function exitCode(result: RunResult): number {
  if (result.status === "blocked") return 2;
  const counts = summarize(result);
  if (counts.failed) return 1;
  if (counts.blocked || counts.uncertain) return 2;
  return 0;
}
