// 执行一个 Suite：预检 → 逐条用例（身份 → 前置 → 操作 → 断言 → 清理）→ 回收登录码 → 报告。
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type EnvProfile,
  loadEnv,
  loadSuite,
  missingModelEnv,
  regressRoot,
  type Suite,
  suitePlansDir,
  suitePosPath
} from "./config.ts";
import { type Actor, actorFactory, launchBrowser, loadMidscene, type NetworkIssue } from "./browser.ts";
import { clearRooms, enterApp, type FlowContext, runFlow } from "./flows.ts";
import { deleteLoginCode, opsWhoami } from "./identity.ts";
import { type Ledger, openLedger, readLedger } from "./ledger.ts";
import { type CheckOp, loadPlans, type Plan, type PlanStep, stepKind, validatePlan } from "./plan.ts";
import { extractCases, loadPos, type PosCase } from "./pos.ts";
import { writeReport } from "./report.ts";

export type CaseStatus = "passed" | "failed" | "blocked" | "uncertain" | "skipped";

export interface ExpectResult {
  readonly n: number;
  readonly text: string;
  readonly status: "passed" | "failed" | "uncertain" | "not-run" | "manual";
  readonly detail: string;
}

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly path: readonly string[];
  readonly status: CaseStatus;
  readonly reason: string;
  readonly expects: readonly ExpectResult[];
  readonly issues: readonly NetworkIssue[];
  readonly reports: readonly string[];
  readonly leftovers: readonly string[];
  readonly durationMs: number;
}

export interface RunResult {
  readonly runId: string;
  readonly env: string;
  readonly suite: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "completed" | "blocked";
  readonly blockedReason?: string;
  readonly model: string;
  readonly cases: readonly CaseResult[];
  readonly cleanup: { readonly loginCodesDeleted: number; readonly errors: readonly string[] };
}

export interface RunOptions {
  readonly envId: string;
  readonly suiteId: string;
  readonly only?: readonly string[];
  readonly caseTimeoutMs?: number;
}

export async function runSuite(options: RunOptions): Promise<{ runDir: string; result: RunResult }> {
  const env = await loadEnv(options.envId);
  const suite = await loadSuite(options.suiteId);
  const runId = `${new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+/u, "")}-${env.id}-${suite.id}`;
  const runDir = resolve(regressRoot, ".runs", runId);
  await mkdir(runDir, { recursive: true });
  const ledger = openLedger(runDir);
  const startedAt = new Date().toISOString();
  const base = { runId, env: env.id, suite: suite.id, startedAt, model: process.env.MIDSCENE_MODEL_NAME ?? "" };

  const blocked = await preflight(env);
  const sources = await suiteCases(suite);
  const selected = options.only?.length ? sources.filter((item) => options.only!.includes(item.id)) : sources;
  if (blocked) {
    const result: RunResult = {
      ...base,
      finishedAt: new Date().toISOString(),
      status: "blocked",
      blockedReason: blocked,
      cases: [],
      cleanup: { loginCodesDeleted: 0, errors: [] }
    };
    return finish(runDir, result);
  }

  const plans = new Map((await loadPlans(suitePlansDir(suite))).map(({ plan }) => [plan.case, plan]));
  await loadMidscene(join(runDir, "midscene"));
  const browser = await launchBrowser();
  const cases: CaseResult[] = [];
  try {
    for (const source of selected) {
      const result = await runCase({
        source,
        plan: plans.get(source.id),
        env,
        runId,
        runDir,
        ledger,
        factory: actorFactory(browser, env, runId, ledger),
        timeoutMs: options.caseTimeoutMs ?? 10 * 60_000
      });
      cases.push(result);
      process.stdout.write(`${JSON.stringify({ event: "case.result", id: result.id, status: result.status, title: result.title })}\n`);
    }
  } finally {
    await browser.close();
  }
  const cleanup = await revokeLoginCodes(env, ledger);
  return finish(runDir, { ...base, finishedAt: new Date().toISOString(), status: "completed", cases, cleanup });
}

export async function suiteCases(suite: Suite): Promise<PosCase[]> {
  const root = await loadPos(suitePosPath(suite));
  return extractCases(root, suite.roots).filter((item) => item.priority && suite.priorities.includes(item.priority));
}

async function preflight(env: EnvProfile): Promise<string | null> {
  const missing = missingModelEnv();
  if (missing.length) return `缺少模型配置：${missing.join(", ")}`;
  try {
    await opsWhoami(env);
  } catch (error) {
    return `tutti-ops 不可用：${(error as Error).message}`;
  }
  try {
    const response = await fetch(env.webUrl, { redirect: "manual" });
    if (response.status >= 500) return `环境入口不可用：HTTP ${response.status}`;
  } catch (error) {
    return `环境入口不可达：${(error as Error).message}`;
  }
  return null;
}

interface CaseInput {
  readonly source: PosCase;
  readonly plan: Plan | undefined;
  readonly env: EnvProfile;
  readonly runId: string;
  readonly runDir: string;
  readonly ledger: Ledger;
  readonly factory: ReturnType<typeof actorFactory>;
  readonly timeoutMs: number;
}

async function runCase(input: CaseInput): Promise<CaseResult> {
  const { source, plan, env } = input;
  const started = Date.now();
  const skeleton = (status: CaseStatus, reason: string, expectStatus: ExpectResult["status"] = "not-run"): CaseResult => ({
    id: source.id,
    title: source.title,
    path: source.path,
    status,
    reason,
    expects: source.expect.map((text, index) => ({ n: index + 1, text, status: expectStatus, detail: "" })),
    issues: [],
    reports: [],
    leftovers: [],
    durationMs: Date.now() - started
  });

  if (!plan) return skeleton("skipped", "尚未编译 Plan");
  const problems = validatePlan(plan, source);
  if (problems.length) return skeleton("skipped", `Plan 不可用：${problems.join("；")}`);
  if (plan.mode === "manual") return skeleton("skipped", `人工用例：${plan.reason}`, "manual");
  const lacking = (plan.requires ?? []).filter((capability) => !env.capabilities.includes(capability));
  if (lacking.length) return skeleton("skipped", `环境缺少能力：${lacking.join(", ")}`);

  const actors = new Map<string, Actor>();
  const ctx: FlowContext = { env, runId: input.runId, runTag: runTag(input.runId), caseId: source.id, ledger: input.ledger };
  const vars: Vars = {
    runId: runTag(input.runId),
    rand: { pin: String(Math.floor(100_000 + Math.random() * 900_000)) },
    today: { date: new Intl.DateTimeFormat("sv-SE", { timeZone: env.timezoneId }).format(new Date()) }
  };
  const recorder = expectRecorder(source);
  for (const item of plan.uncovered ?? []) recorder.record(item.n, "manual", item.reason);
  let status: CaseStatus = "passed";
  let reason = "";
  const reportName = source.id.slice(0, 8);

  const body = async (): Promise<void> => {
    let phase: "setup" | "steps" = "setup";
    try {
      for (const name of plan.actors ?? []) {
        const [baseName] = name.split("#");
        const actor = name.includes("#")
          ? await input.factory.tab(actors.get(baseName!)!, name, source.id, reportName)
          : await input.factory.create(name, source.id, reportName);
        actors.set(name, actor);
        if (!name.includes("#")) vars[name] = { displayName: actor.displayName };
        await enterApp(ctx, actor);
      }
      for (const step of plan.setup ?? []) await runStep(ctx, actors, step, vars, recorder);
      phase = "steps";
      for (const step of plan.steps ?? []) await runStep(ctx, actors, step, vars, recorder);
    } catch (error) {
      status = phase === "setup" ? "blocked" : "failed";
      reason = `${phase === "setup" ? "前置条件无法达成" : "操作步骤执行失败"}：${(error as Error).message}`;
    }
  };

  const running = body();
  const timedOut = await withTimeout(running, input.timeoutMs);
  if (timedOut) {
    status = "blocked";
    reason = `用例超时（${Math.round(input.timeoutMs / 1000)}s）`;
    // 关掉页面中断进行中的 AI 操作，换新页面做清理
    for (const actor of actors.values()) await actor.restart();
    await running.catch(() => undefined);
  }

  const leftovers: string[] = [];
  // 每个独立用户清理一次；标签页共享同一用户的数据
  for (const actor of [...actors.values()].filter((item) => !item.name.includes("#"))) {
    try {
      leftovers.push(...(await withDeadline(clearRooms(actor, env), 5 * 60_000)).map((room) => `${actor.name}:${room}`));
    } catch (error) {
      leftovers.push(`${actor.name}:清理失败 ${(error as Error).message}`);
    }
  }
  const reports: string[] = [];
  for (const actor of actors.values()) {
    const file = actor.agent.reportFile;
    if (file) reports.push(relative(input.runDir, file));
    await actor.context.close().catch(() => undefined);
  }

  const expectResults = recorder.results();
  if (status === "passed") {
    if (expectResults.some((item) => item.status === "failed")) status = "failed";
    else if (expectResults.some((item) => item.status === "uncertain")) status = "uncertain";
  }
  const names = new Set(actors.keys());
  return {
    id: source.id,
    title: source.title,
    path: source.path,
    status,
    reason,
    expects: expectResults,
    issues: input.factory.issues.filter((issue) => names.has(issue.actor)),
    reports,
    leftovers,
    durationMs: Date.now() - started
  };
}

/** runId 形如 20261023T092452-prod-room-p0，取时分秒作为数据名前缀 */
export function runTag(runId: string): string {
  return runId.slice(9, 15);
}

type Vars = Record<string, Record<string, string> | string>;

async function runStep(
  ctx: FlowContext,
  actors: Map<string, Actor>,
  step: PlanStep,
  vars: Vars,
  recorder: ExpectRecorder
): Promise<void> {
  const kind = stepKind(step);
  if (kind === "check") {
    const { op, left, right } = step.check!;
    const passed = evaluateCheck(op, interpolate(left, vars), right === undefined ? undefined : interpolate(right, vars));
    recorder.record(step.n!, passed ? "passed" : "failed", `代码断言 ${op}：${left}${right === undefined ? "" : ` / ${right}`}`);
    return;
  }
  const actor = actors.get(step.actor!)!;
  switch (kind) {
    case "act":
      await actor.agent.aiAct(interpolate(step.act!, vars));
      return;
    case "reload":
      await actor.page.reload({ waitUntil: "load" });
      return;
    case "flow": {
      const args = Object.fromEntries(Object.entries(step.with ?? {}).map(([key, value]) => [key, interpolate(value, vars)]));
      const output = await runFlow(ctx, actor, step.flow!, args);
      if (step.save && output) vars[step.save] = output;
      return;
    }
    case "assert": {
      const assertion = interpolate(step.assert!, vars);
      if (step.waitMs) {
        await actor.agent.aiWaitFor(assertion, { timeoutMs: step.waitMs, checkIntervalMs: 3_000 }).catch(() => undefined);
      }
      try {
        const verdict = await actor.agent.aiAssert(assertion, undefined, { keepRawResponse: true });
        recorder.record(step.n!, verdict?.pass ? "passed" : "failed", `[${actor.name}] ${verdict?.thought ?? verdict?.message ?? ""}`);
      } catch (error) {
        recorder.record(step.n!, "uncertain", `[${actor.name}] ${(error as Error).message}`);
      }
      return;
    }
    default:
      throw new Error(`无效步骤 ${JSON.stringify(step)}`);
  }
}

export function evaluateCheck(op: CheckOp, left: string, right: string | undefined): boolean {
  switch (op) {
    case "empty":
      return left.trim() === "";
    case "nonEmpty":
      return left.trim() !== "";
    case "equals":
      return left === right;
    case "notEquals":
      return left !== right;
    case "contains":
      return left.includes(right ?? "");
    case "notContains":
      return !left.includes(right ?? "");
    case "matches":
      return new RegExp(right ?? "", "u").test(left);
  }
}

type ExpectStatus = ExpectResult["status"];
interface ExpectRecorder {
  record(n: number, status: ExpectStatus, detail: string): void;
  results(): ExpectResult[];
}

/** 同一条预期可能由多个断言共同覆盖，取最差结果。 */
function expectRecorder(source: PosCase): ExpectRecorder {
  const severity: Record<ExpectStatus, number> = { passed: 0, manual: 1, "not-run": 2, uncertain: 3, failed: 4 };
  const records = new Map<number, { status: ExpectStatus; details: string[] }>();
  return {
    record(n, status, detail) {
      const current = records.get(n);
      if (!current) {
        records.set(n, { status, details: [detail] });
        return;
      }
      if (severity[status] > severity[current.status]) current.status = status;
      current.details.push(detail);
    },
    results() {
      return source.expect.map((text, index) => {
        const record = records.get(index + 1);
        return { n: index + 1, text, status: record?.status ?? "not-run", detail: record?.details.filter(Boolean).join("\n") ?? "" };
      });
    }
  };
}

/** {{runId}}、{{room.name}}、{{invite.password}} 形式的变量替换；变量不存在时报错，避免把占位符发给页面。 */
export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_match, key: string) => {
    const [head, field] = key.split(".");
    const value = vars[head!];
    const resolved = field === undefined ? value : typeof value === "object" ? value[field] : undefined;
    if (typeof resolved !== "string") throw new Error(`变量 ${key} 未定义`);
    return resolved;
  });
}

async function revokeLoginCodes(env: EnvProfile, ledger: Ledger): Promise<RunResult["cleanup"]> {
  const errors: string[] = [];
  let deleted = 0;
  for (const entry of await readLedger(ledger.file)) {
    if (entry.kind !== "login-code") continue;
    try {
      await deleteLoginCode(env, entry.id);
      deleted += 1;
    } catch (error) {
      errors.push(`登录码 ${entry.id}：${(error as Error).message}`);
    }
  }
  return { loginCodesDeleted: deleted, errors };
}

async function finish(runDir: string, result: RunResult): Promise<{ runDir: string; result: RunResult }> {
  await writeFile(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeReport(runDir, result);
  return { runDir, result };
}

async function withTimeout(task: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(true), ms);
  });
  try {
    return await Promise.race([task.then(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function withDeadline<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
