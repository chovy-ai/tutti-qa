import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Account } from "../src/service/accounts.ts";
import { loadConfig } from "../src/service/config.ts";
import type { EgoPage } from "../src/service/ego.ts";
import { createHttpServer } from "../src/service/http.ts";
import { ServiceError, type Client } from "../src/service/protocol.ts";
import type { BrowserProvider } from "../src/service/provider.ts";
import { BrowserService } from "../src/service/service.ts";
import { parseGoal, parseTestPlan } from "../src/service/workflow-protocol.ts";
import { parseDecision, type TestAgent, type WalkthroughAgent } from "../src/service/workflow-agents.ts";
import { GoalWorkflows } from "../src/service/workflows.ts";

const alice: Client = { id: "alice" };
const bob: Client = { id: "bob" };
const input = (mode: "walkthrough" | "test" = "test") => parseGoal({ mode, goal: "Check an observable feature", expectations: ["Expected outcome"] });
const decision = (action = "done") => parseDecision({ action, selector: "#show", value: "", url: "", x: 0, y: 0, summary: "Observed the requested feature", uncovered: [] });

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, options: { test?: (page: EgoPage, ...args: unknown[]) => Promise<TestAgent>; walkthrough?: () => WalkthroughAgent; close?: () => Promise<void>; open?: (id: string, account?: Account) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "goal-workflow-test-"));
  await writeFile(join(dir, "config.json"), JSON.stringify({ stateDir: dir, accountsFile: join(dir, "accounts.json"), leaseDir: join(dir, "leases") }));
  const config = await loadConfig(join(dir, "config.json"));
  const accounts: Account[] = ["one", "two"].map((id) => ({ id, resourceKey: id, roles: ["owner"], env: "test", capabilities: [], tags: [], ego: { profile: id }, async loadState() { throw new Error("Workflow must reuse ego login, not create an identity"); } }));
  const actions: unknown[] = [];
  const pages = new Map<string, EgoPage>();
  let closed = 0;
  const provider: BrowserProvider = { async open(id, account) {
    await options.open?.(id, account);
    const page = {
      budget() {},
      async observe() { return { url: "https://example.org", title: "Fixture", snapshot: "@1 button Show details" }; },
      async action(action: unknown) { actions.push(action); },
      async screenshot(name: string) {
        await mkdir(join(dir, "artifacts"), { recursive: true });
        await writeFile(join(dir, "artifacts", name + ".png"), new Uint8Array([1, 2, 3]));
        return { id: name + ".png", contentType: "image/png" };
      }
    } as unknown as EgoPage;
    pages.set(id, page);
    return { async execute() { return { type: "snapshot", pass: true }; }, async close() { await options.close?.(); closed++; } };
  } };
  const browsers = new BrowserService(config, accounts, provider);
  const goals = new GoalWorkflows(config, {
    browsers, pages: { page(id) { return pages.get(id)!; } },
    walkthrough: options.walkthrough ?? (() => ({ async decide() { return decision(); }, async close() {} })),
    test: options.test ?? (async () => ({ async plan() { return { actions: [{ type: "act", instruction: "Open the feature" }], checks: ["Derived result"], blockedReason: "" }; }, async act(instruction) { actions.push(instruction); }, async assert() { return { pass: true, detail: "Observed" }; }, async artifacts() { return []; }, async close() {} }))
  });
  t.after(async () => { await goals.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, goals, browsers, accounts, actions, closed: () => closed };
}

async function finished(goals: GoalWorkflows, owner: string, id: string) {
  for (let n = 0; n < 400; n++) { const record = goals.get(owner, id); if (record.finishedAt) return record; await delay(10); }
  throw new Error("Workflow did not finish");
}

test("目标协议只接收目标/用途/约束，拒绝浏览器步骤和无界预算", () => {
  assert.throws(() => parseGoal({ mode: "test", goal: "x", steps: [] }));
  assert.throws(() => parseGoal({ mode: "other", goal: "x" }));
  assert.throws(() => parseGoal({ mode: "test", goal: "x", maxSteps: 999 }));
  assert.throws(() => parseGoal({ mode: "test", goal: "x", accountId: "a", selector: {} }));
  assert.deepEqual(parseGoal({ mode: "walkthrough", goal: "Inspect a feature" }).selector, {});
  assert.throws(() => parseTestPlan({ actions: ["1", "2"], checks: [], blockedReason: "" }, 1));
  assert.throws(() => parseDecision({ ...decision(), action: "shell" }));
});

test("走查使用 Codex 决策和 ego 页面，返回 completed 而非测试 passed", async (t) => {
  let calls = 0;
  const f = await fixture(t, { walkthrough: () => ({ async decide() { return ++calls === 1 ? decision("click") : decision(); }, async close() {} }), test: async () => { throw new Error("Wrong engine"); } });
  const run = f.goals.submit(alice, input("walkthrough"));
  const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.agent, "codex"); assert.equal(result.browser, "ego-lite"); assert.equal(result.status, "completed");
  assert.equal(result.artifacts.length, 2); assert.equal(result.observations.length, 2); assert.deepEqual(result.checks, []);
  assert.equal(f.closed(), 1); assert.equal(f.actions.length, 1); assert.equal(result.cleanup?.status, "closed");
});

test("测试执行和验证由 Midscene 完成，调用方给出的预期不会被模型改写", async (t) => {
  const checked: string[] = [];
  const f = await fixture(t, { test: async () => ({
    async plan() { return { actions: [{ type: "act", instruction: "Inspect controls" }], checks: ["An easier invented check"], blockedReason: "" }; },
    async act() {}, async assert(value) { checked.push(value); return { pass: true, detail: "Observed" }; }, async artifacts() { return []; }, async close() {}
  }) });
  const run = f.goals.submit(alice, input()); const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.status, "passed"); assert.equal(result.agent, "midscene");
  assert.deepEqual(checked, ["Expected outcome"]); assert.equal(result.checks[0]?.source, "requested");
  const stored = JSON.parse(await readFile(join(f.dir, "workflows", run.id + ".json"), "utf8")) as { status: string };
  assert.equal(stored.status, "passed");
});

test("断言失败不会报告通过，后续未检查项显式返回", async (t) => {
  let checks = 0;
  const f = await fixture(t, { test: async () => ({ async plan() { return { actions: [], checks: [], blockedReason: "" }; }, async act() {}, async assert() { checks++; return { pass: false, detail: "Missing" }; }, async artifacts() { return []; }, async close() {} }) });
  const run = f.goals.submit(alice, { ...input(), expectations: ["Expected outcome", "Second condition"] });
  const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.status, "failed"); assert.equal(checks, 1); assert.deepEqual(result.uncovered, ["Second condition"]);
});

test("观察和截图由 workflow 完成，不能作为不支持的页面动作交给 aiAct", async (t) => {
  const interactions: string[] = [];
  const f = await fixture(t, { test: async () => ({
    async plan() { return parseTestPlan({ actions: [
      { type: "screenshot", instruction: "Capture the initial state" },
      { type: "act", instruction: "Click Show details" },
      { type: "observe", instruction: "Observe the expanded panel" },
      { type: "screenshot", instruction: "Capture the expanded state" }
    ], checks: ["Panel is expanded"], blockedReason: "" }, 4); },
    async act(instruction) { interactions.push(instruction); },
    async assert() { return { pass: true, detail: "Expanded panel observed" }; }, async artifacts() { return []; }, async close() {}
  }) });
  const run = f.goals.submit(alice, { ...input(), maxSteps: 4 });
  const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.status, "passed"); assert.deepEqual(interactions, ["Click Show details"]);
  assert.equal(result.artifacts.length, 5); assert.equal(result.checks.length, 1);
  assert.throws(() => parseTestPlan({ actions: ["Capture screenshot"], checks: [], blockedReason: "" }, 4));
});

test("前置阻塞不执行动作；自动推导的检查标明来源", async (t) => {
  const blocked = await fixture(t, { test: async () => ({ async plan() { return { actions: [], checks: [], blockedReason: "Login is expired" }; }, async act() { throw new Error("Must not run"); }, async assert() { throw new Error("Must not assert"); }, async artifacts() { return []; }, async close() {} }) });
  const run = blocked.goals.submit(alice, input()); assert.equal((await finished(blocked.goals, alice.id, run.id)).status, "blocked");
  const f = await fixture(t);
  const inferred = f.goals.submit(alice, { ...input(), expectations: [] });
  assert.equal((await finished(f.goals, alice.id, inferred.id)).checks[0]?.source, "inferred");
});

test("从现有账号池选择匹配账号，profile 忙则尝试其他匹配账号，不新建用户", async (t) => {
  const f = await fixture(t, { async open(_id, account) { if (account?.id === "one") throw new ServiceError(409, "EGO_PROFILE_BUSY", "Busy"); } });
  const run = f.goals.submit(alice, input());
  assert.equal((await finished(f.goals, alice.id, run.id)).accountId, "two");
  const denied = f.goals.submit({ ...bob, accountIds: [] }, input());
  const blocked = await finished(f.goals, bob.id, denied.id);
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.error?.code, "ACCOUNT_NOT_FOUND");
});

test("运行中取消会回收账号，晚到的模型结果不改写最终结果", async (t) => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((ok) => { entered = ok; });
  const f = await fixture(t, { test: async () => ({
    async plan() { return { actions: [{ type: "act", instruction: "Do a thing" }], checks: ["Done"], blockedReason: "" }; },
    act: () => new Promise<void>((ok) => { release = ok; entered(); }), async assert() { return { pass: true, detail: "" }; }, async artifacts() { return []; }, async close() {}
  }) });
  const run = f.goals.submit(alice, input()); await started;
  await f.goals.cancel(alice.id, run.id);
  const before = await finished(f.goals, alice.id, run.id);
  assert.equal(before.status, "cancelled"); assert.equal(before.cleanup?.status, "closed");
  release(); await delay(20); assert.deepEqual(f.goals.get(alice.id, run.id), before);
});

test("取消先关闭浏览器 Space，再等待 Agent 结束，避免等待推理期间继续操作页面", async (t) => {
  let entered: () => void = () => {};
  const started = new Promise<void>((ok) => { entered = ok; });
  let checked = false;
  const f = await fixture(t, { test: async () => ({
    async plan() { return { actions: [{ type: "act", instruction: "Wait for a remote model" }], checks: [], blockedReason: "" }; },
    act: () => new Promise<void>(() => { entered(); }), async assert() { return { pass: true, detail: "" }; }, async artifacts() { return []; },
    async close() { assert.equal(f.closed(), 1); checked = true; }
  }) });
  const run = f.goals.submit(alice, input()); await started;
  await f.goals.cancel(alice.id, run.id);
  assert.equal((await finished(f.goals, alice.id, run.id)).status, "cancelled");
  assert.equal(checked, true);
});

test("取消先关闭浏览器 Space，再导出回放，避免文件导出延迟页面停止", async (t) => {
  let entered: () => void = () => {};
  const started = new Promise<void>((ok) => { entered = ok; });
  let closedAtExport = -1;
  const f = await fixture(t, { test: async () => ({
    async plan() { return { actions: [{ type: "act", instruction: "Wait for a remote model" }], checks: [], blockedReason: "" }; },
    act: () => new Promise<void>(() => { entered(); }), async assert() { return { pass: true, detail: "" }; },
    async artifacts() { closedAtExport = f.closed(); return []; }, async close() {}
  }) });
  const run = f.goals.submit(alice, input()); await started;
  await f.goals.cancel(alice.id, run.id);
  assert.equal((await finished(f.goals, alice.id, run.id)).status, "cancelled");
  assert.equal(closedAtExport, 1);
});

test("启动中取消必须等待启动回执并关闭页面，不遗留一个晚启动的账号租约", async (t) => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((ok) => { entered = ok; });
  const f = await fixture(t, { open: () => new Promise<void>((ok) => { release = ok; entered(); }) });
  const run = f.goals.submit(alice, input()); await started;
  await f.goals.cancel(alice.id, run.id);
  assert.equal(f.goals.get(alice.id, run.id).finishedAt, undefined);
  assert.equal(f.browsers.listAccounts(alice)[0]?.status, "busy");
  release();
  const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.status, "cancelled"); assert.equal(result.cleanup?.status, "closed"); assert.equal(f.closed(), 1);
  assert.equal(f.browsers.listAccounts(alice)[0]?.status, "available");
});

test("清理不确定时，测试通过也转为 blocked 并保持账号占用", async (t) => {
  const f = await fixture(t, { async close() { throw new Error("Unknown"); } });
  const run = f.goals.submit(alice, input()); const result = await finished(f.goals, alice.id, run.id);
  assert.equal(result.status, "blocked"); assert.equal(result.cleanup?.status, "unknown");
  assert.equal(f.browsers.listAccounts(alice)[0]?.status, "busy");
});

test("HTTP 目标入口无 token 可提交、查询和下载，保留幂等冲突检查", async (t) => {
  const f = await fixture(t);
  const server = createHttpServer(f.browsers, f.config, f.goals);
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  t.after(() => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json", "idempotency-key": "same-goal" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const [a, b] = await Promise.all([call("/v1/runs", "POST", input()), call("/v1/runs", "POST", input())]);
  assert.equal(a.status, 202); assert.equal(b.status, 202);
  const created = await a.json() as { data: { id: string } }; assert.deepEqual(await b.json(), created);
  const result = await finished(f.goals, "local", created.data.id);
  assert.equal((await call(`/v1/runs/${result.id}`)).status, 200);
  assert.equal((await call("/v1/runs")).status, 200);
  const artifact = await call(`/v1/artifacts/${result.artifacts[0]!.id}`); assert.equal(artifact.status, 200); assert.equal((await artifact.arrayBuffer()).byteLength, 3);
  const cli = new URL("../../cli/bin/tutti-qa.mjs", import.meta.url).pathname;
  const execute = promisify(execFile);
  const env = { ...process.env, BROWSER_TEST_TOKEN: "", TUTTI_QA_TOKEN_FILE: "" };
  const invoke = (...args: string[]) => execute(process.execPath, [cli, "--server", base, ...args], { env });
  const capabilities = JSON.parse((await invoke("capabilities")).stdout) as { data: { version: string } };
  assert.equal(capabilities.data.version, "1.1.0");
  const queried = JSON.parse((await invoke("run", "get", result.id)).stdout) as { data: { id: string } };
  assert.equal(queried.data.id, result.id);
  const output = join(f.dir, "download.png");
  await invoke("artifact", "get", result.artifacts[0]!.id, "--out", output);
  assert.equal((await readFile(output)).length, 3);
  assert.equal((await call("/v1/runs", "POST", { ...input(), goal: "Different" })).status, 409);
});
