// 使用原账号的 ego profile，只操作临时站点；不注入新 Cookie，不创建线上账号或房间。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAccounts } from "../src/service/accounts.ts";
import { loadConfig } from "../src/service/config.ts";
import { EgoBrowserProvider } from "../src/service/ego.ts";
import { createHttpServer } from "../src/service/http.ts";
import { BrowserService } from "../src/service/service.ts";
import { GoalWorkflows, type GoalRun } from "../src/service/workflows.ts";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { mode: { type: "string", default: "both" }, account: { type: "string", default: "auto-test-account-1" }, "env-file": { type: "string" }, keep: { type: "boolean" } } });
assert.ok(["walkthrough", "test", "both"].includes(values.mode!));
const root = await mkdtemp(join(tmpdir(), "goal-workflow-native-"));
const fixture = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>Goal workflow fixture</title><style>body{font:20px system-ui;padding:50px}button{font:inherit;padding:14px}</style></head><body>
    <h1>Workflow fixture</h1><button id="show" onclick="document.getElementById('details').hidden=false">Show details</button>
    <section id="details" hidden><h2>Details expanded</h2><p>The details panel is now visible.</p></section></body></html>`);
});
await new Promise<void>((ok, fail) => { fixture.once("error", fail); fixture.listen(0, "127.0.0.1", ok); });
const address = fixture.address(); assert.ok(address && typeof address !== "string");
const target = `http://127.0.0.1:${address.port}`;
let workflows: GoalWorkflows | undefined;
let browsers: BrowserService | undefined;
let api: ReturnType<typeof createHttpServer> | undefined;
let passed = false;
try {
  await writeFile(join(root, "config.json"), JSON.stringify({ stateDir: root, allowedOrigins: [target] }));
  const config = await loadConfig(join(root, "config.json"), values["env-file"]);
  const original = (await loadAccounts(config.accountsFile, config.legacySecretsDir)).find((a) => a.id === values.account);
  assert.ok(original?.ego, "An existing account with an ego profile is required");
  const account = { ...original, url: target, allowedOrigins: [target] };
  const ego = new EgoBrowserProvider(config);
  browsers = new BrowserService(config, [account], ego);
  workflows = new GoalWorkflows(config, { browsers, pages: ego });
  api = createHttpServer(browsers, config, workflows);
  await new Promise<void>((ok, fail) => { api!.once("error", fail); api!.listen(0, "127.0.0.1", ok); });
  const endpoint = api.address(); assert.ok(endpoint && typeof endpoint !== "string");
  const modes = values.mode === "both" ? ["walkthrough", "test"] : [values.mode!];
  for (const mode of modes) {
    const cli = resolve("../cli/bin/tutti-qa.mjs");
    const args = [cli, "--server", `http://127.0.0.1:${endpoint.port}`, mode,
      "Click Show details, observe the expanded details panel, and capture screenshots of the initial and expanded states.",
      "--target", target, "--account", account.id, "--max-steps", "3", "--timeout-seconds", "480", "--wait-seconds", "550", "--poll-ms", "100", "--out-dir", join(root, "downloads", mode)];
    if (mode === "test") args.push("--expect", "The Details expanded heading and details panel are visible after clicking Show details.");
    let stdout;
    try { ({ stdout } = await execute(process.execPath, args, { timeout: 570_000, maxBuffer: 4 * 1024 * 1024 })); }
    catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      console.error(JSON.stringify({ mode, cliStdout: failure.stdout, cliStderr: failure.stderr, diagnostics: root }));
      throw new Error("Native goal workflow smoke failed");
    }
    const result = JSON.parse(stdout) as { data: GoalRun; downloads: { path: string }[] };
    assert.equal(result.data.status, mode === "walkthrough" ? "completed" : "passed");
    assert.equal(result.data.browser, "ego-lite");
    assert.equal(result.data.agent, mode === "walkthrough" ? "codex" : "midscene");
    assert.equal(result.data.accountId, account.id); assert.equal(result.data.cleanup?.status, "closed");
    assert.ok(result.data.artifacts.length >= 2);
    for (const file of result.downloads) assert.ok((await readFile(file.path)).length > 0);
    console.log(JSON.stringify({ mode, status: result.data.status, browser: result.data.browser, agent: result.data.agent, account: account.id, observations: result.data.observations.length, checks: result.data.checks.length, artifacts: result.data.artifacts.length, cleanup: result.data.cleanup }));
  }
  passed = true;
} finally {
  api?.close(); api?.closeAllConnections();
  const clean = await workflows?.shutdown();
  await new Promise<void>((ok) => { fixture.close(() => ok()); fixture.closeAllConnections(); });
  if (passed && clean && !values.keep) await rm(root, { recursive: true, force: true });
  else console.log(JSON.stringify({ diagnostics: root, cleanupConfirmed: clean }));
}
