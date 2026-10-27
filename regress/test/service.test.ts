import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadAccounts, type Account } from "../src/service/accounts.ts";
import { checkUrl, loadConfig } from "../src/service/config.ts";
import { createHttpServer } from "../src/service/http.ts";
import { ServiceError, parseJob, parseSession, type Client, type StepResult } from "../src/service/protocol.ts";
import type { BrowserProvider } from "../src/service/provider.ts";
import { BrowserService } from "../src/service/service.ts";

const alice: Client = { id: "alice", token: "a".repeat(40) };
const bob: Client = { id: "bob", token: "b".repeat(40) };
const sessionInput = { ttlSeconds: 30 };
const snapshotJob = { steps: [{ type: "snapshot" as const }], timeoutSeconds: 5 };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, provider?: BrowserProvider, accounts: Account[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "browser-service-test-"));
  const configFile = join(dir, "config.json");
  await writeFile(configFile, JSON.stringify({ stateDir: dir, accountsFile: join(dir, "accounts.json"), leaseDir: join(dir, "leases") }));
  const config = await loadConfig(configFile);
  config.clients = [alice, bob];
  const service = new BrowserService(config, accounts, provider ?? {
    async open() { return { async execute(step) { return { type: step.type, pass: true, data: "observed" }; }, async close() {} }; }
  });
  t.after(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, service };
}

function account(id: string, resourceKey = id): Account {
  return { id, resourceKey, env: "test", roles: ["owner"], capabilities: [], tags: [], async loadState() { return { cookies: [], origins: [] }; } };
}

async function finished(service: BrowserService, owner: string, id: string) {
  for (let n = 0; n < 300; n++) {
    const job = service.getJob(owner, id);
    if (!["queued", "running"].includes(job.status) && job.finishedAt) return job;
    await delay(10);
  }
  throw new Error("Job did not finish");
}

test("通用和旧账号目录：凭据延迟读取，敏感字段不进入归一化目录", async (t) => {
  const { dir } = await fixture(t);
  const path = join(dir, "accounts.json");
  await mkdir(join(dir, "secrets"));
  await writeFile(join(dir, "secrets", "legacy.session"), "private-cookie");
  await writeFile(join(dir, "state.json"), JSON.stringify({ cookies: [], origins: [] }));
  await writeFile(path, JSON.stringify({ accounts: [
    { name: "legacy", env: "prod", profile: "profile-a", roles: ["owner"], loginCode: "must-not-leak", note: "private-note" },
    { id: "any-app", storageStateFile: "state.json", url: "https://example.org", tags: ["staging"] }
  ] }));
  const accounts = await loadAccounts(path, join(dir, "secrets"));
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.resourceKey, "profile-a");
  assert.ok(!JSON.stringify(accounts).includes("must-not-leak"));
  assert.ok(!JSON.stringify(accounts).includes("private-note"));
  const legacyState = await accounts[0]!.loadState();
  assert.equal(legacyState.cookies[0]?.value, "private-cookie");
  assert.equal(legacyState.cookies[0]?.expires, -1);
  assert.equal(legacyState.cookies[1]?.domain, "tutti.sh");
  assert.ok(!Object.hasOwn(legacyState.cookies[1]!, "url"));
  assert.deepEqual(await accounts[1]!.loadState(), { cookies: [], origins: [] });
  await rm(join(dir, "secrets", "legacy.session"));
  await assert.rejects(accounts[0]!.loadState(), (e: ServiceError) => e.code === "ACCOUNT_AUTH_UNAVAILABLE" && !e.message.includes("private-cookie"));
});

test("协议拒绝路径/脚本能力、未知字段和非法数量；来源策略精确匹配", () => {
  assert.throws(() => parseJob({ steps: [{ type: "evaluate", script: "anything" }] }, 600));
  assert.throws(() => parseJob({ steps: [{ type: "snapshot", path: "/etc/passwd" }] }, 600));
  assert.throws(() => parseJob({ steps: [], timeoutSeconds: 0 }, 600));
  assert.throws(() => parseSession({ accountId: "a", selector: {} }, 30, 60));
  assert.throws(() => checkUrl("file:///etc/passwd", ["*"]));
  assert.throws(() => checkUrl("https://example.org.evil.test", ["https://example.org"]));
  assert.throws(() => checkUrl("https://user:secret@example.org", ["*"]));
  assert.throws(() => checkUrl("https://example.org", ["*"], ["https://other.org"]));
  assert.equal(checkUrl("http://localhost:8888", ["*"]), "http://localhost:8888/");
  assert.deepEqual(parseJob({ steps: [{ type: "fill", selector: "input", value: "" }] }, 600).steps[0], { type: "fill", selector: "input", value: "" });
});

test("同账号/同资源互斥，调用方隔离，确认关闭后归还账号", async (t) => {
  const { service } = await fixture(t, undefined, [account("one", "shared"), account("alias", "shared")]);
  const session = await service.create(alice, { ...sessionInput, accountId: "one" });
  await assert.rejects(service.create(bob, { ...sessionInput, accountId: "alias" }), (e: ServiceError) => e.code === "ACCOUNT_BUSY");
  assert.throws(() => service.getSession(bob.id, session.id), (e: ServiceError) => e.status === 404);
  assert.deepEqual(service.listSessions(bob.id), []);
  await service.close(alice.id, session.id);
  const next = await service.create(bob, { ...sessionInput, accountId: "alias" });
  assert.equal(next.status, "ready");
  await assert.rejects(service.create({ ...alice, accountIds: [] }, { ...sessionInput, accountId: "one" }), (e: ServiceError) => e.code === "ACCOUNT_NOT_FOUND");
});

test("不同服务实例共用账号目录时也不能重复分配", async (t) => {
  const a = await fixture(t, undefined, [account("one")]);
  const b = await fixture(t, undefined, [account("one")]);
  b.config.leaseDir = a.config.leaseDir;
  const first = await a.service.create(alice, { ...sessionInput, accountId: "one" });
  await assert.rejects(b.service.create(bob, { ...sessionInput, accountId: "one" }), (e: ServiceError) => e.code === "ACCOUNT_BUSY");
  await a.service.close(alice.id, first.id);
  assert.equal((await b.service.create(bob, { ...sessionInput, accountId: "one" })).status, "ready");
});

test("浏览器启动失败会回收已获取的账号锁", async (t) => {
  let fail = true;
  const { service } = await fixture(t, { async open() {
    if (fail) throw new Error("launch failed");
    return { async execute() { return { type: "snapshot", pass: true }; }, async close() {} };
  } }, [account("one")]);
  await assert.rejects(service.create(alice, { ...sessionInput, accountId: "one" }));
  fail = false;
  assert.equal((await service.create(alice, { ...sessionInput, accountId: "one" })).status, "ready");
});

test("清理结果不确定时隔离账号，重试清理成功后才解锁", async (t) => {
  let fail = true;
  const { service } = await fixture(t, { async open() { return {
    async execute() { return { type: "snapshot", pass: true }; },
    async close() { if (fail) throw new Error("unknown cleanup"); }
  }; } }, [account("one")]);
  const session = await service.create(alice, { ...sessionInput, accountId: "one" });
  await assert.rejects(service.close(alice.id, session.id), (e: ServiceError) => e.code === "CLEANUP_FAILED");
  assert.equal(service.getSession(alice.id, session.id).status, "quarantined");
  await assert.rejects(service.create(bob, { ...sessionInput, accountId: "one" }), (e: ServiceError) => e.code === "ACCOUNT_BUSY");
  fail = false;
  await service.close(alice.id, session.id);
  assert.equal(service.listAccounts(alice)[0]?.status, "available");
});

test("同会话串行，不同会话可并发；断言失败停止剩余步骤", async (t) => {
  let inFlight = 0;
  let max = 0;
  const perSession = new Map<string, number>();
  let perSessionMax = 0;
  let calls = 0;
  const { service } = await fixture(t, { async open(id) { return {
    async execute(step): Promise<StepResult> {
      calls++;
      inFlight++; max = Math.max(max, inFlight);
      perSession.set(id, (perSession.get(id) ?? 0) + 1);
      perSessionMax = Math.max(perSessionMax, perSession.get(id)!);
      await delay(30);
      inFlight--; perSession.set(id, perSession.get(id)! - 1);
      return { type: step.type, pass: step.type !== "assert" };
    }, async close() {}
  }; } });
  const a = await service.create(alice, sessionInput);
  const b = await service.create(bob, sessionInput);
  const jobs = [service.submit(alice.id, a.id, snapshotJob), service.submit(alice.id, a.id, snapshotJob), service.submit(bob.id, b.id, snapshotJob)];
  await Promise.all(jobs.map((j, i) => finished(service, i === 2 ? bob.id : alice.id, j.id)));
  assert.equal(max, 2); assert.equal(perSessionMax, 1);
  const before = calls;
  const assertion = service.submit(alice.id, a.id, { timeoutSeconds: 5, steps: [{ type: "assert", prompt: "false" }, { type: "snapshot" }] });
  assert.equal((await finished(service, alice.id, assertion.id)).status, "failed");
  assert.equal(calls - before, 1);
});

test("超时先关闭浏览器；晚到结果不改写作业，账号随后可重用", async (t) => {
  let finishStep: (value: StepResult) => void = () => {};
  let closed = false;
  const { service } = await fixture(t, { async open() { return {
    execute: () => new Promise<StepResult>((ok) => { finishStep = ok; }),
    async close() { closed = true; }
  }; } }, [account("one")]);
  const session = await service.create(alice, { ...sessionInput, accountId: "one" });
  const job = service.submit(alice.id, session.id, { ...snapshotJob, timeoutSeconds: 1 });
  const result = await finished(service, alice.id, job.id);
  assert.equal(result.status, "timed_out"); assert.equal(closed, true);
  finishStep({ type: "snapshot", pass: true });
  await delay(10);
  assert.equal(service.getJob(alice.id, job.id).status, "timed_out");
  assert.deepEqual(service.getJob(alice.id, job.id).results, []);
  assert.equal(service.listAccounts(alice)[0]?.status, "available");
});

test("HTTP 鉴权、并发幂等、不同请求体冲突、跨调用方隔离与产物权限", async (t) => {
  let opens = 0;
  const { config, service } = await fixture(t, { async open() { opens++; await delay(10); return {
    async execute(step) { return { type: step.type, pass: true, artifacts: [{ id: "test.png", contentType: "image/png" }] }; }, async close() {}
  }; } });
  const server = createHttpServer(service, config);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>((ok, fail) => { server.close((e) => e ? fail(e) : ok()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const call = (path: string, client = alice, method = "GET", body?: unknown, key?: string) => fetch(url + path, {
    method, headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.equal((await fetch(url + "/health")).status, 200);
  assert.equal((await fetch(url + "/v1/accounts")).status, 401);
  assert.equal((await call("/v1/sessions", alice, "POST", {})).status, 400);
  const [a, b] = await Promise.all([call("/v1/sessions", alice, "POST", {}, "create-1"), call("/v1/sessions", alice, "POST", {}, "create-1")]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const created = await a.json() as { data: { id: string } };
  assert.deepEqual(await b.json(), created); assert.equal(opens, 1);
  assert.equal((await call("/v1/sessions", alice, "POST", { url: "https://example.org" }, "create-1")).status, 409);
  assert.equal((await call(`/v1/sessions/${created.data.id}`, bob)).status, 404);
  assert.equal((await call(`/v1/sessions/${created.data.id}`, bob, "DELETE")).status, 404);
  const submission = await call(`/v1/sessions/${created.data.id}/jobs`, alice, "POST", snapshotJob, "job-1");
  assert.equal(submission.status, 202);
  const job = (await submission.json() as { data: { id: string } }).data;
  await finished(service, alice.id, job.id);
  assert.equal((await call(`/v1/jobs/${job.id}`, bob)).status, 404);
  assert.equal((await call("/v1/artifacts/test.png", bob)).status, 404);
  assert.throws(() => service.artifact(bob.id, "test.png"));
  assert.equal(service.artifact(alice.id, "test.png").contentType, "image/png");
  assert.equal((await call("/v1/openapi.json")).status, 200);
  assert.equal((await call(`/v1/sessions/${created.data.id}`, alice, "DELETE")).status, 200);
});

test("排队取消不执行；运行中取消销毁会话并取消其余作业", async (t) => {
  let calls = 0;
  let closed = 0;
  const { service, dir } = await fixture(t, { async open() { return {
    execute() { calls++; return new Promise<StepResult>(() => {}); },
    async close() { closed++; }
  }; } });
  const session = await service.create(alice, sessionInput);
  const running = service.submit(alice.id, session.id, snapshotJob);
  const queued = service.submit(alice.id, session.id, snapshotJob);
  const another = service.submit(alice.id, session.id, snapshotJob);
  assert.equal((await service.cancelJob(alice.id, queued.id)).status, "cancelled");
  const resultFile = JSON.parse(await readFile(join(dir, "jobs", `${queued.id}.json`), "utf8")) as { status: string };
  assert.equal(resultFile.status, "cancelled");
  await service.cancelJob(alice.id, running.id);
  assert.equal((await finished(service, alice.id, running.id)).status, "cancelled");
  assert.equal(service.getJob(alice.id, another.id).status, "cancelled");
  assert.equal(closed, 1); assert.equal(calls, 1);
  assert.equal(service.getSession(alice.id, session.id).status, "closed");
});

test("租约到期自动关闭；续约可延长有效时间", async (t) => {
  const { service } = await fixture(t, undefined, [account("one")]);
  const session = await service.create(alice, { ttlSeconds: 1, accountId: "one" });
  const renewed = service.renew(alice.id, session.id, 2);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(session.expiresAt));
  await delay(1100);
  assert.equal(service.getSession(alice.id, session.id).status, "ready");
  for (let i = 0; i < 25 && service.getSession(alice.id, session.id).status !== "closed"; i++) await delay(100);
  assert.equal(service.getSession(alice.id, session.id).status, "closed");
  assert.equal(service.listAccounts(alice)[0]?.status, "available");
});

test("启动中遇到关闭且清理不确定时，保留账号锁并拒绝自动释放", async (t) => {
  let rejectOpen: (error: unknown) => void = () => {};
  let started: () => void = () => {};
  const openingStarted = new Promise<void>((ok) => { started = ok; });
  const { service } = await fixture(t, { open: () => new Promise((_ok, fail) => { rejectOpen = fail; started(); }) }, [account("one")]);
  const opening = service.create(alice, { ...sessionInput, accountId: "one" });
  const failed = assert.rejects(opening);
  await openingStarted;
  const id = service.listSessions(alice.id)[0]!.id;
  const closing = service.close(alice.id, id);
  rejectOpen(new ServiceError(503, "CLEANUP_FAILED", "Unknown browser state"));
  await failed;
  await assert.rejects(closing, (e: ServiceError) => e.code === "CLEANUP_FAILED");
  assert.equal(service.getSession(alice.id, id).status, "quarantined");
  await assert.rejects(service.close(alice.id, id));
  assert.equal(service.listAccounts(alice)[0]?.status, "busy");
});

test("超时后的晚到异常也不能追加结果或覆盖最终状态", async (t) => {
  let rejectStep: (error: unknown) => void = () => {};
  const { service } = await fixture(t, { async open() { return {
    execute: () => new Promise<StepResult>((_ok, fail) => { rejectStep = fail; }), async close() {}
  }; } });
  const session = await service.create(alice, sessionInput);
  const submitted = service.submit(alice.id, session.id, { ...snapshotJob, timeoutSeconds: 1 });
  const before = await finished(service, alice.id, submitted.id);
  rejectStep(new Error("late browser rejection"));
  await delay(10);
  assert.deepEqual(service.getJob(alice.id, submitted.id), before);
});
