import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServiceConfig } from "./config.ts";
import type { EgoPage } from "./ego.ts";
import { ServiceError, type Artifact, type Client } from "./protocol.ts";
import { BrowserService, type SessionRecord } from "./service.ts";
import { CodexWalkthroughAgent, createTestAgent, decisionAction, type TestAgent, type WalkthroughAgent } from "./workflow-agents.ts";
import type { GoalInput } from "./workflow-protocol.ts";

export interface GoalRun {
  id: string;
  mode: GoalInput["mode"];
  goal: string;
  agent: "codex" | "midscene";
  browser: "ego-lite";
  status: "queued" | "running" | "completed" | "passed" | "failed" | "blocked" | "cancelled" | "timed_out";
  phase: "queued" | "account" | "planning" | "executing" | "verifying" | "cleanup" | "finished";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  accountId?: string;
  summary: string;
  checks: { expectation: string; pass: boolean; detail: string; source: "requested" | "inferred" }[];
  observations: { step: number; summary: string; url: string; title: string }[];
  artifacts: Artifact[];
  uncovered: string[];
  cleanup?: { status: "closed" | "unknown" | "not_started" };
  error?: { code: string; message: string };
}
interface Run { record: GoalRun; client: Client; input: GoalInput; controller: AbortController }
interface Dependencies {
  browsers: BrowserService;
  pages: { page(id: string): EgoPage };
  walkthrough?: (dir: string, input: GoalInput, signal: AbortSignal) => WalkthroughAgent;
  test?: (page: EgoPage, config: ServiceConfig, runId: string, input: GoalInput) => Promise<TestAgent>;
}
const terminal = new Set(["completed", "passed", "failed", "blocked", "cancelled", "timed_out"]);

/** 对外收目标，内部编排账号 → 规划 → 执行 → 验证/证据 → 回收；模型输出不直接等于判定。 */
export class GoalWorkflows {
  readonly config: ServiceConfig;
  private deps: Dependencies;
  private runs = new Map<string, Run>();
  private queue: Run[] = [];
  private active: Promise<void> | undefined;
  private stopping = false;
  constructor(config: ServiceConfig, deps: Dependencies) { this.config = config; this.deps = deps; }

  submit(client: Client, input: GoalInput): GoalRun {
    if (this.stopping) throw new ServiceError(503, "STOPPING", "Workflow service is stopping");
    if (this.runs.size >= this.config.maxRecords || this.queue.length >= this.config.maxQueuedJobs) throw new ServiceError(429, "WORKFLOW_LIMIT", "Workflow queue or record capacity reached");
    const record: GoalRun = {
      id: randomUUID(), mode: input.mode, goal: input.goal, agent: input.mode === "walkthrough" ? "codex" : "midscene", browser: "ego-lite",
      status: "queued", phase: "queued", createdAt: new Date().toISOString(), summary: "", checks: [], observations: [], artifacts: [], uncovered: []
    };
    const run = { record, input, client, controller: new AbortController() };
    this.runs.set(record.id, run);
    this.queue.push(run);
    this.schedule();
    return structuredClone(record);
  }
  get(owner: string, id: string): GoalRun { return structuredClone(this.owned(owner, id).record); }
  list(owner: string): GoalRun[] { return [...this.runs.values()].filter((r) => r.client.id === owner).map((r) => structuredClone(r.record)); }
  artifact(owner: string, id: string): Artifact {
    for (const run of this.runs.values()) {
      if (run.client.id === owner) {
        const artifact = run.record.artifacts.find((a) => a.id === id);
        if (artifact) return artifact;
      }
    }
    throw new ServiceError(404, "NOT_FOUND", "Workflow artifact not found");
  }
  async cancel(owner: string, id: string): Promise<GoalRun> {
    const run = this.owned(owner, id);
    if (run.record.finishedAt) return this.get(owner, id);
    run.controller.abort(new ServiceError(409, "CANCELLED", "Workflow cancellation requested"));
    if (run.record.status === "queued") {
      this.queue = this.queue.filter((r) => r !== run);
      run.record.status = "cancelled"; run.record.phase = "finished";
      run.record.cleanup = { status: "not_started" }; run.record.finishedAt = new Date().toISOString();
      await this.persist(run.record);
    }
    return this.get(owner, id);
  }
  async shutdown(): Promise<boolean> {
    this.stopping = true;
    await Promise.all([...this.runs.values()].filter((r) => !r.record.finishedAt).map((r) => this.cancel(r.client.id, r.record.id)));
    await this.active;
    return this.deps.browsers.shutdown();
  }
  private owned(owner: string, id: string): Run {
    const run = this.runs.get(id);
    if (!run || run.client.id !== owner) throw new ServiceError(404, "NOT_FOUND", "Workflow not found");
    return run;
  }
  private schedule(): void {
    if (this.active || this.stopping) return;
    const run = this.queue.shift();
    if (!run) return;
    // ego lite 是交互式共享浏览器，第一版工作流串行，避免焦点和剪贴板竞争。
    this.active = this.execute(run).finally(() => { this.active = undefined; this.schedule(); });
  }
  private async acquire(run: Run): Promise<SessionRecord> {
    const selector = run.input.selector;
    const accounts = this.deps.browsers.listAccounts(run.client).filter((a) =>
      run.input.accountId ? a.id === run.input.accountId :
        (!selector?.env || a.env === selector.env) &&
        (selector?.roles ?? []).every((v) => a.roles.includes(v)) &&
        (selector?.capabilities ?? []).every((v) => a.capabilities.includes(v)) &&
        (selector?.tags ?? []).every((v) => a.tags.includes(v))
    );
    if (!accounts.length) throw new ServiceError(404, "ACCOUNT_NOT_FOUND", "No permitted existing account matches this goal");
    let last: unknown;
    for (const account of accounts) {
      run.controller.signal.throwIfAborted();
      if (account.status !== "available") continue;
      try {
        return await this.deps.browsers.create(run.client, {
          accountId: account.id, url: run.input.target,
          ttlSeconds: Math.min(this.config.maxTtlSeconds, run.input.timeoutSeconds + 60)
        });
      } catch (error) {
        last = error;
        if (!(error instanceof ServiceError) || !["ACCOUNT_BUSY", "EGO_PROFILE_BUSY", "EGO_ACCOUNT_REQUIRED"].includes(error.code)) throw error;
      }
    }
    if (last instanceof ServiceError) throw last;
    throw new ServiceError(409, "ACCOUNT_BUSY", "Matching accounts are reserved or their ego profiles are busy");
  }
  private async execute(run: Run): Promise<void> {
    const r = run.record;
    const signal = run.controller.signal;
    r.status = "running"; r.phase = "account"; r.startedAt = new Date().toISOString();
    let session: SessionRecord | undefined;
    let agent: TestAgent | WalkthroughAgent | undefined;
    let leaseTimer: NodeJS.Timeout | undefined;
    const ensure = () => signal.throwIfAborted();
    const deadline = setTimeout(() => run.controller.abort(new ServiceError(408, "WORKFLOW_TIMEOUT", "Workflow deadline exceeded")), run.input.timeoutSeconds * 1000).unref();
    const interrupted = new Promise<never>((_ok, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }));
    // 启动浏览器时也可能取消；先等启动回执，再清理，不能把租约提前归还。
    void interrupted.catch(() => {});
    const work = async () => {
      ensure();
      r.accountId = session!.accountId;
      const ttl = Math.max(1, Math.floor((Date.parse(session!.expiresAt) - Date.parse(session!.createdAt)) / 1000));
      leaseTimer = setInterval(() => {
        try { if (!signal.aborted) this.deps.browsers.renew(run.client.id, session!.id, ttl); }
        catch { run.controller.abort(new ServiceError(409, "LEASE_LOST", "Workflow account lease could not be renewed")); }
      }, Math.max(200, ttl * 1000 / 3)).unref();
      const page = this.deps.pages.page(session!.id);
      page.budget(run.input.maxSteps * 8);
      const shot = async () => { ensure(); const artifact = await page.screenshot(`${r.id}-${r.artifacts.length + 1}`); ensure(); r.artifacts.push(artifact); return resolve(this.config.stateDir, "artifacts", artifact.id); };
      let observation = await page.observe(); ensure();
      r.observations.push({ step: 0, summary: "Initial page", url: observation.url, title: observation.title });
      let screenshotPath = await shot();
      r.phase = "planning";
      if (run.input.mode === "walkthrough") {
        const walker = this.deps.walkthrough?.(resolve(this.config.stateDir, "workflows", r.id), run.input, signal) ?? new CodexWalkthroughAgent(resolve(this.config.stateDir, "workflows", r.id), run.input, signal);
        agent = walker;
        const history: string[] = [];
        for (let n = 0; n <= run.input.maxSteps; n++) {
          ensure();
          const decision = await walker.decide(observation, screenshotPath, history); ensure();
          if (decision.action === "blocked" || decision.action === "done") {
            r.uncovered = decision.uncovered;
            r.status = decision.action === "done" && !decision.uncovered.length ? "completed" : "blocked";
            r.summary = decision.summary;
            return;
          }
          if (n === run.input.maxSteps) break;
          r.phase = "executing";
          await page.action(decisionAction(decision)); ensure();
          observation = await page.observe(); ensure();
          screenshotPath = await shot();
          history.push(decision.summary);
          r.observations.push({ step: n + 1, summary: decision.summary, url: observation.url, title: observation.title });
        }
        throw new ServiceError(409, "ACTION_BUDGET", "Walkthrough did not finish within its step budget");
      }
      const tester = await (this.deps.test ?? createTestAgent)(page, this.config, r.id, run.input);
      if (signal.aborted) { await tester.close(); ensure(); }
      agent = tester;
      const plan = await tester.plan(); ensure();
      if (plan.blockedReason) { r.status = "blocked"; r.summary = plan.blockedReason; r.uncovered = run.input.expectations; return; }
      const checks = run.input.expectations.length ? run.input.expectations : plan.checks;
      if (!checks.length) throw new ServiceError(409, "CRITERIA_REQUIRED", "No observable acceptance criteria could be derived; provide expectations");
      r.phase = "executing";
      for (const [i, step] of plan.actions.entries()) {
        ensure();
        if (step.type === "act") await tester.act(step.instruction);
        ensure();
        observation = await page.observe(); ensure();
        await shot();
        r.observations.push({ step: i + 1, summary: step.instruction, url: observation.url, title: observation.title });
      }
      r.phase = "verifying";
      for (const [i, expectation] of checks.entries()) {
        ensure(); const verdict = await tester.assert(expectation); ensure();
        r.checks.push({ expectation, ...verdict, source: run.input.expectations.length ? "requested" : "inferred" });
        if (!verdict.pass) {
          await shot(); r.status = "failed"; r.summary = "An observable acceptance criterion failed"; r.uncovered = checks.slice(i + 1); return;
        }
      }
      r.status = "passed";
      r.summary = run.input.expectations.length ? "All caller-supplied acceptance criteria passed" : "All workflow-derived acceptance criteria passed";
    };
    try { session = await this.acquire(run); ensure(); await Promise.race([work(), interrupted]); }
    catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError(503, "WORKFLOW_BLOCKED", "Workflow could not establish the requested result");
      if (!session && failure.sessionId) session = this.deps.browsers.getSession(run.client.id, failure.sessionId);
      r.status = failure.code === "CANCELLED" ? "cancelled" : failure.code === "WORKFLOW_TIMEOUT" ? "timed_out" : "blocked";
      r.error = { code: failure.code, message: failure.message }; r.summary = failure.message;
    } finally {
      clearTimeout(deadline); clearInterval(leaseTimer);
      r.phase = "cleanup";
      // 停止尚未完成的 Codex/模型分支；晚到结果在 ensure() 处终止，不再改写记录。
      if (!signal.aborted) run.controller.abort(new ServiceError(409, "FINISHED", "Workflow finished"));
      try {
        if (session) { await this.deps.browsers.close(run.client.id, session.id); r.cleanup = { status: "closed" }; }
        else r.cleanup = { status: "not_started" };
      } catch {
        r.cleanup = { status: "unknown" };
        if (["passed", "completed"].includes(r.status)) r.status = "blocked";
        r.error = { code: "CLEANUP_FAILED", message: "Ego cleanup is uncertain; the account remains reserved" };
      }
      if (agent && "artifacts" in agent) {
        try { r.artifacts.push(...await agent.artifacts()); } catch { r.uncovered.push("AI replay could not be exported"); }
      }
      // 先关闭本次 Space，阻止等待中的模型响应继续产生 UI 副作用，再等待 SDK 退出。
      let stopTimer: NodeJS.Timeout | undefined;
      try {
        const stopped = await Promise.race([
          Promise.resolve(agent?.close()).then(() => true, () => false),
          new Promise<boolean>((ok) => { stopTimer = setTimeout(() => ok(false), 10_000).unref(); })
        ]);
        if (!stopped) r.uncovered.push("Agent shutdown could not be confirmed; late browser actions are rejected");
      } finally { clearTimeout(stopTimer); }
      if (!terminal.has(r.status)) r.status = "blocked";
      r.phase = "finished"; r.finishedAt = new Date().toISOString();
      await this.persist(r);
    }
  }
  private async persist(record: GoalRun): Promise<void> {
    try {
      const dir = resolve(this.config.stateDir, "workflows");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(resolve(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    } catch {
      record.error = { code: "RESULT_WRITE_FAILED", message: "Workflow result could not be saved on the host" };
      if (record.status === "passed" || record.status === "completed") record.status = "blocked";
    }
  }
}
