// 真实浏览器/HTTP 链路，使用临时站点和临时凭据，不创建或修改线上用户。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadAccounts } from "../src/service/accounts.ts";
import { loadConfig } from "../src/service/config.ts";
import { createHttpServer } from "../src/service/http.ts";
import { PlaywrightProvider } from "../src/service/provider.ts";
import { BrowserService, type JobRecord } from "../src/service/service.ts";

const { values } = parseArgs({ options: { ai: { type: "boolean" }, "env-file": { type: "string" } } });
const root = await mkdtemp(join(tmpdir(), "browser-service-smoke-"));
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>Generic browser test</title></head><body>
    <h1>Browser service fixture</h1>
    <p>${req.headers.cookie?.includes("fixture_session=ready") ? "Authenticated fixture" : "Anonymous fixture"}</p>
    <label>Display name <input id="name" /></label><button id="save" onclick="document.getElementById('result').textContent='Saved: '+document.getElementById('name').value">Save</button>
    <p id="result" role="status">Waiting for input</p></body></html>`);
});
await new Promise<void>((ok, fail) => { fixture.once("error", fail); fixture.listen(0, "127.0.0.1", ok); });
const address = fixture.address(); assert.ok(address && typeof address !== "string");
const fixtureUrl = `http://127.0.0.1:${address.port}`;
let service: BrowserService | undefined;
let http: ReturnType<typeof createHttpServer> | undefined;
try {
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets/state.json"), JSON.stringify({ cookies: [{ name: "fixture_session", value: "ready", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }), { mode: 0o600 });
  await writeFile(join(root, "secrets/legacy.session"), "temporary-fixture-session", { mode: 0o600 });
  await writeFile(join(root, "accounts.json"), JSON.stringify({ accounts: [
    { id: "fixture-owner", resourceKey: "fixture-user", storageStateFile: "secrets/state.json", url: fixtureUrl },
    { name: "legacy", env: "prod", profile: "legacy-fixture", url: fixtureUrl }
  ] }));
  await writeFile(join(root, "config.json"), JSON.stringify({ stateDir: root, accountsFile: join(root, "accounts.json"), legacySecretsDir: join(root, "secrets"), leaseDir: join(root, "leases"), allowedOrigins: [fixtureUrl] }));
  const config = await loadConfig(join(root, "config.json"), values["env-file"]);
  service = new BrowserService(config, await loadAccounts(config.accountsFile, config.legacySecretsDir), new PlaywrightProvider(config));
  http = createHttpServer(service, config);
  await new Promise<void>((ok, fail) => { http!.once("error", fail); http!.listen(0, "127.0.0.1", ok); });
  const endpoint = http.address(); assert.ok(endpoint && typeof endpoint !== "string");
  const base = `http://127.0.0.1:${endpoint.port}`;
  const call = async (path: string, method = "GET", body?: unknown, key?: string) => {
    const response = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${config.clients[0]!.token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  const session = (await (await call("/v1/sessions", "POST", { accountId: "fixture-owner" }, "smoke-session")).json() as { data: { id: string } }).data;
  const steps: unknown[] = [
    { type: "fill", selector: "#name", value: "Universal API" },
    { type: "click", selector: "#save" }, { type: "snapshot" }, { type: "screenshot" }
  ];
  if (values.ai) {
    steps.push({ type: "assert", prompt: "The page shows both Authenticated fixture and Saved: Universal API." });
    steps.push({ type: "query", prompt: "Return the exact text of the status message that starts with Saved: as a string." });
  }
  const submitted = (await (await call(`/v1/sessions/${session.id}/jobs`, "POST", { steps, timeoutSeconds: 180 }, "smoke-job")).json() as { data: JobRecord }).data;
  let job = submitted;
  const deadline = Date.now() + 190_000;
  while (["queued", "running"].includes(job.status) && Date.now() < deadline) {
    await delay(200);
    job = (await (await call(`/v1/jobs/${job.id}`)).json() as { data: JobRecord }).data;
  }
  assert.equal(job.status, "passed", JSON.stringify(job));
  assert.match(JSON.stringify(job.results[2]?.data), /Authenticated fixture/u);
  assert.match(JSON.stringify(job.results[2]?.data), /Saved: Universal API/u);
  const screenshot = job.results[3]?.artifacts?.[0]; assert.ok(screenshot);
  const image = await call(`/v1/artifacts/${screenshot.id}`);
  assert.equal(image.headers.get("content-type"), "image/png");
  const bytes = (await image.arrayBuffer()).byteLength;
  assert.ok(bytes > 100);
  if (values.ai) assert.match(JSON.stringify(job.results.at(-1)?.data), /Saved: Universal API/u);
  await call(`/v1/sessions/${session.id}`, "DELETE");
  const accounts = await (await call("/v1/accounts")).json() as { data: { status: string }[] };
  assert.equal(accounts.data[0]?.status, "available");
  // 旧账号格式也经过真实 Chromium 的 storageState 验证，不使用真实线上 session。
  const legacy = (await (await call("/v1/sessions", "POST", { accountId: "legacy" }, "legacy-session")).json() as { data: { id: string } }).data;
  await call(`/v1/sessions/${legacy.id}`, "DELETE");
  console.log(JSON.stringify({ status: "passed", realBrowser: true, http: true, accountStorageState: true, legacyCookies: true, screenshotBytes: bytes, ai: values.ai === true, steps: job.results.length, artifacts: job.results.flatMap((r) => r.artifacts ?? []).map((a) => a.contentType) }));
} finally {
  http?.close(); http?.closeAllConnections();
  await service?.shutdown();
  await new Promise<void>((ok) => fixture.close(() => ok()));
  await rm(root, { recursive: true, force: true });
}
