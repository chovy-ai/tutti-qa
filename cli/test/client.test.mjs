import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { BrowserClient, ClientError } from "../src/client.mjs";
import { executeCommand, goalBody, loadGoal, runExit, waitForRun } from "../src/commands.mjs";

const invalidArgument = "private-input";
const json = (value, status = 200) => new Response(JSON.stringify({ data: value }), { status, headers: { "content-type": "application/json" } });
async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), "tutti-qa-cli-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test("offline help/version do not need browser dependencies, server or credentials", () => {
  for (const option of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [new URL("../bin/tutti-qa.mjs", import.meta.url).pathname, option], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
  }
  const bad = spawnSync(process.execPath, [new URL("../bin/tutti-qa.mjs", import.meta.url).pathname, "--unknown", invalidArgument], { encoding: "utf8" });
  assert.equal(bad.status, 2); assert.ok(!bad.stderr.includes(invalidArgument));
});

test("POST retries preserve the request ID and exact JSON body", async () => {
  const calls = [];
  const client = new BrowserClient({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) throw new TypeError("connection lost");
    return json({ id: "run-1", status: "queued" }, 202);
  } });
  const result = await client.request("POST", "/v1/runs", { body: { mode: "test", goal: "test a page" }, requestId: "same-request" });
  assert.equal(result.status, "queued"); assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["idempotency-key"], "same-request");
  assert.equal(calls[0].body, calls[1].body); assert.deepEqual(calls[0].headers, calls[1].headers);
  assert.equal(calls[0].redirect, "manual");
});

test("lost JSON response retries the same operation; exhaustion reports unknown", async () => {
  const client = new BrowserClient({ retries: 1, fetchImpl: async () => new Response("{", { status: 202 }) });
  await assert.rejects(client.request("POST", "/v1/runs", { body: { mode: "walkthrough", goal: "browse" }, requestId: "receipt-1" }), (e) => {
    assert.equal(e.code, "REQUEST_UNCONFIRMED"); assert.equal(e.details.requestId, "receipt-1");
    assert.equal(e.details.operationState, "unknown"); return true;
  });
});

test("401/403 are not retried and redirects are not followed", async () => {
  let calls = 0;
  const client = new BrowserClient({ fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Denied" } }), { status: 403 });
  } });
  await assert.rejects(client.request("GET", "/v1/accounts"), (e) => e.code === "FORBIDDEN" && e.message === "Denied");
  assert.equal(calls, 1);
  const redirected = new BrowserClient({ fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, "manual"); return new Response(null, { status: 302, headers: { location: "https://other.test" } });
  } });
  await assert.rejects(redirected.request("GET", "/v1/accounts"), (e) => e.code === "HTTP_302");
  assert.throws(() => new BrowserClient({ server: "http://user:password@example.org" }));
});

test("API requests need no token and send no Authorization header", async () => {
  const client = new BrowserClient({ fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, undefined);
    return json({ version: "1.1.0" });
  } });
  assert.equal((await client.request("GET", "/v1/capabilities")).version, "1.1.0");
});

test("CLI input is a goal plus account criteria, never browser steps", async () => {
  const body = await goalBody({ roles: "member", expect: ["No delete action"], constraints: ["No real data changes"] }, "test", "Verify member permissions");
  assert.equal(body.mode, "test"); assert.equal(body.goal, "Verify member permissions");
  assert.deepEqual(body.selector, { roles: ["member"] }); assert.ok(!Object.hasOwn(body, "steps"));
  await assert.rejects(goalBody({ account: "a", roles: "owner" }, "test", "goal"));
  await assert.rejects(goalBody({ mode: "test" }, "walkthrough", "goal"));
  await assert.rejects(loadGoal("-", Readable.from([JSON.stringify({ mode: "test", goal: "x", steps: [] })])), (e) => e.code === "INVALID_ARGUMENT" && /browser steps/u.test(e.message));
});

test("run submit only submits a high-level goal, returns accepted without opening client sessions", async () => {
  const calls = [];
  const client = new BrowserClient({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json({ id: "run-1", status: "queued" }, 202); } });
  const result = await executeCommand(client, ["run", "submit"], { mode: "test", goal: "Verify permissions", account: "existing-member", "request-id": "goal-1" });
  assert.equal(result.exitCode, 0); assert.equal(result.output.data.status, "queued");
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith("/v1/runs"));
  assert.deepEqual(JSON.parse(calls[0].body), { mode: "test", goal: "Verify permissions", accountId: "existing-member" });
});

test("waiting requires finishedAt, returns assertion failure as exit 1 and preserves evidence", async (t) => {
  const dir = await temp(t);
  let polls = 0;
  const terminal = { id: "run-1", status: "failed", finishedAt: "2026-10-27T00:00:00Z", cleanup: { status: "closed" }, artifacts: [{ id: "shot.png", contentType: "image/png" }], checks: [{ pass: false }] };
  const client = new BrowserClient({ fetchImpl: async (url, options) => {
    if (options.method === "POST") return json({ id: "run-1", status: "queued" }, 202);
    if (url.endsWith("/artifacts/shot.png")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    polls++; return json(polls === 1 ? { ...terminal, finishedAt: undefined } : terminal);
  } });
  const result = await executeCommand(client, ["test", "Verify a result"], { "poll-ms": "1", "out-dir": dir });
  assert.equal(result.exitCode, 1); assert.equal(polls, 2);
  assert.equal((await readFile(join(dir, "shot.png"))).length, 3);
  assert.equal(JSON.parse(await readFile(join(dir, "result.json"), "utf8")).status, "failed");
  assert.equal((await stat(join(dir, "shot.png"))).mode & 0o777, 0o600);
});

test("transport error while waiting includes run ID; it never resubmits a goal", async () => {
  const client = { timeoutMs: 1000, async request(method) { assert.equal(method, "GET"); throw new ClientError("REQUEST_FAILED", "lost"); } };
  await assert.rejects(waitForRun(client, "run-known"), (e) => e.details.runId === "run-known");
  assert.equal(runExit({ status: "completed", cleanup: { status: "closed" } }), 0);
  assert.equal(runExit({ status: "passed", cleanup: { status: "unknown" } }), 2);
  assert.equal(runExit({ status: "blocked" }), 2);
});

test("artifact download needs no credentials, rejects traversal/overwrite, removes incomplete files", async (t) => {
  const dir = await temp(t);
  const out = join(dir, "file.png");
  let calls = 0;
  const client = new BrowserClient({ fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.headers.authorization, undefined);
    return new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "image/png" } });
  } });
  await client.download("file.png", out);
  await assert.rejects(client.download("file.png", out)); assert.equal(calls, 1);
  await assert.rejects(client.download("../outside.png", join(dir, "bad.png")));
  const broken = new BrowserClient({ retries: 0, fetchImpl: async () => new Response("wrong", { headers: { "content-type": "text/plain" } }) });
  const partial = join(dir, "partial.png");
  await assert.rejects(broken.download("partial.png", partial));
  await assert.rejects(stat(partial), { code: "ENOENT" });
});
