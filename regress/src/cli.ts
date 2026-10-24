#!/usr/bin/env node
// tutti-regress：.pos P0 用例 → Plan → Midscene 执行 → 报告。
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { stringify } from "yaml";
import { loadEnv, loadSuite, missingModelEnv, regressRoot, suitePlansDir } from "./config.ts";
import { cleanupRun } from "./cleanup.ts";
import { issueIdentities, loadIdentityBatch, releaseIdentities } from "./identities.ts";
import { opsWhoami } from "./identity.ts";
import { aiStep, createAgent, loadMidscene } from "./midscene.ts";
import { loadPlans, validatePlan } from "./plan.ts";
import { describeCache, mergeSessionReports, summarize, writeReport } from "./report.ts";
import { runSuite, suiteCases, type RunResult } from "./runner.ts";
import {
  connectSession,
  listSessions,
  sessionMidsceneDir,
  sessionsRoot,
  startSessions,
  stopSession
} from "./session.ts";

const USAGE = `用法：
  regress doctor  --env <env>                         检查模型配置、tutti-ops 与环境入口
  regress cases   --suite <suite> [--id <caseId>]     导出用例 JSON（编译 Plan 的输入）
  regress sync    --suite <suite> [--scaffold]        核对 .pos 与 Plan：缺失 / 过期 / 失效；--scaffold 为缺失用例生成待编译占位
  regress run     --env <env> --suite <suite> [--only id,id] [--timeout-min 10] [--concurrency 10]
  regress report  --run <runId>                       由 result.json 重新生成 report.html
  regress cleanup --env <env> --run <runId>           按台账补清理房间并回收登录码

原子能力（不写 Plan，按步骤直接调用）：
  regress identity create  --env <env> (--names a,b | --count N) [--batch <name>]   一键申请测试身份
  regress identity release --batch <name>                                          回收该批次的登录码
  regress session start  (--identity <batch>:<name> | --batch <name> [--names a,b]) [--headed] [--id <id>] [--concurrency N]
                                                      启动独立浏览器进程并登录，常驻后台，输出 CDP 地址
  regress session list                                列出会话及进程是否存活
  regress session stop   (--session <id> | --all)     结束浏览器进程
  regress session report --session <id>               合并该会话的 Midscene 回放
  regress act    --session <id> "<操作>"              Midscene aiAct
  regress assert --session <id> "<断言>"              Midscene aiAssert，退出码 1 表示断言不通过
  regress wait   --session <id> "<条件>" [--timeout-sec 60]
  regress query  --session <id> "<要提取的数据>"`;

// 本地 .env：MIDSCENE_* 以本项目配置为准（覆盖 shell 全局导出的模型配置），其他变量只补充未设置的
const dotenv = join(regressRoot, ".env");
if (existsSync(dotenv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(dotenv, "utf8")))) {
    if (key.startsWith("MIDSCENE_") || process.env[key] === undefined) process.env[key] = value;
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string" },
    suite: { type: "string" },
    id: { type: "string" },
    only: { type: "string" },
    run: { type: "string" },
    scaffold: { type: "boolean" },
    "timeout-min": { type: "string" },
    concurrency: { type: "string" },
    names: { type: "string" },
    count: { type: "string" },
    batch: { type: "string" },
    identity: { type: "string" },
    session: { type: "string" },
    headed: { type: "boolean" },
    all: { type: "boolean" },
    "cache-id": { type: "string" },
    "timeout-sec": { type: "string" }
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
      caseTimeoutMs: timeoutMin * 60_000,
      concurrency: readConcurrency()
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
  case "identity": {
    if (positionals[1] === "create") {
      const batch = await issueIdentities(need("env"), identityNames(), values.batch);
      // 只输出非敏感字段；session Cookie 留在批次文件里
      console.log(
        JSON.stringify(
          {
            batch: batch.batch,
            env: batch.env,
            expiresAt: batch.expiresAt,
            file: join(".identities", batch.batch, "identities.json"),
            identities: batch.identities.map(({ name, displayName, userId }) => ({ name, displayName, userId, ref: `${batch.batch}:${name}` }))
          },
          null,
          2
        )
      );
    } else if (positionals[1] === "release") {
      const result = await releaseIdentities(need("batch"));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.errors.length ? 1 : 0;
    } else usage();
    break;
  }
  case "session": {
    const sub = positionals[1];
    if (sub === "start") {
      const refs = values.identity
        ? [values.identity]
        : await loadIdentityBatch(need("batch")).then((batch) =>
            batch.identities
              .filter((item) => !values.names || values.names.split(",").includes(item.name))
              .map((item) => `${batch.batch}:${item.name}`)
          );
      if (refs.length === 0) throw new Error("没有可启动的身份");
      if (values.id && refs.length > 1) throw new Error("--id 只能在启动单个会话时使用");
      const results = await startSessions(
        refs.map((identity) => ({ identity, id: values.id, headed: values.headed })),
        positiveInt(values.concurrency, refs.length, "--concurrency")
      );
      console.log(JSON.stringify(results, null, 2));
      process.exitCode = results.some((item) => !item.ok) ? 1 : 0;
    } else if (sub === "list") {
      console.log(JSON.stringify(await listSessions(), null, 2));
    } else if (sub === "stop") {
      const ids = values.all ? (await listSessions()).filter((item) => item.alive).map((item) => item.id) : [need("session")];
      for (const id of ids) await stopSession(id);
      console.log(JSON.stringify({ stopped: ids }, null, 2));
    } else if (sub === "report") {
      const id = need("session");
      const file = await mergeSessionReports(sessionMidsceneDir(id), join(sessionsRoot, id));
      console.log(file ?? "该会话还没有 Midscene 报告");
    } else usage();
    break;
  }
  case "act":
  case "assert":
  case "wait":
  case "query": {
    const prompt = positionals.slice(1).join(" ").trim();
    if (!prompt) usage();
    const missing = missingModelEnv();
    if (missing.length) throw new Error(`缺少模型配置：${missing.join(", ")}`);
    const id = need("session");
    await loadMidscene(sessionMidsceneDir(id));
    const connected = await connectSession(id);
    try {
      const agent = createAgent(connected.page, {
        id: values["cache-id"] ?? id,
        groupName: id,
        // 时间戳前缀保证 session report 按执行顺序合并
        reportFileName: `${new Date().toISOString().replace(/[-:.]/gu, "")}-${command}`,
        cache: { kind: "sessions", env: connected.record.env }
      });
      const timeoutMs = values["timeout-sec"] ? positiveInt(values["timeout-sec"], 60, "--timeout-sec") * 1000 : undefined;
      const result = await aiStep(agent, command, prompt, { timeoutMs });
      console.log(JSON.stringify({ ...result, report: agent.reportFile ?? null }, null, 2));
      process.exitCode = result.pass ? 0 : 1;
    } finally {
      await connected.disconnect();
    }
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = command ? 64 : 0;
}

/** 默认 10：实际吞吐受模型网关能同时服务的请求数限制，超出部分在网关排队。有头模式共用系统剪贴板，只能串行。 */
function readConcurrency(): number {
  const value = Number(values.concurrency ?? process.env.REGRESS_CONCURRENCY ?? "10");
  if (!Number.isInteger(value) || value < 1) {
    console.error("--concurrency 必须是正整数");
    process.exit(64);
  }
  if (process.env.REGRESS_HEADED === "1" && value > 1) {
    console.error("有头模式共用系统剪贴板，已改为串行执行");
    return 1;
  }
  return value;
}

function identityNames(): string[] {
  if (values.names) return values.names.split(",").map((item) => item.trim()).filter(Boolean);
  const count = positiveInt(values.count, 0, "--count");
  if (count === 0) usage();
  return Array.from({ length: count }, (_item, index) => `user${index + 1}`);
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${flag} 必须是正整数`);
    process.exit(64);
  }
  return parsed;
}

function usage(): never {
  console.error(USAGE);
  process.exit(64);
}

function need(key: "env" | "suite" | "run" | "batch" | "session"): string {
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
  const cache = describeCache(result.cache?.stats);
  if (cache) console.log(`缓存：${cache}`);
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
