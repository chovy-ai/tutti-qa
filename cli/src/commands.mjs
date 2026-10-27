import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClientError } from "./client.mjs";

export const HELP = `tutti-qa — submit browser goals to workflows on the execution host

Connection: --server URL (or BROWSER_TEST_SERVER), --token-file FILE (or BROWSER_TEST_TOKEN)
Node.js >=22; no local browser/model dependencies. Results are JSON.

  walkthrough "goal" [--target URL] [--account ID | --roles owner,member]
  test "goal" [--target URL] [--account ID | --roles owner,member] [--expect TEXT ...]
  run --mode walkthrough|test --goal TEXT [--expect TEXT ...]
  run --file request.json|-                         Submit goal and wait for result
  run submit --file request.json|-                  Submit goal asynchronously
  run list | get ID | wait ID | cancel ID
  accounts list | capabilities | health | openapi
  artifact get ID --out FILE

Goals: --constraints TEXT (repeatable), --env NAME, --capabilities a,b, --tags a,b
Budgets: --max-steps N (12), --timeout-seconds N (600)
Client: --wait-seconds N (900), --poll-ms N (1000), --http-timeout-seconds N (30)
Output: --out-dir DIR (download evidence), --request-id ID (reuse unchanged on retries)

walkthrough = Codex + ego lite; test = Midscene + ego lite; both use existing host accounts.
Exit: 0 completed/passed/accepted; 1 failed assertion; 2 blocked/timeout/unknown/error; 130 interrupted.
Use --help or --version offline. See README.md for installation and input contracts.`;

export const OPTIONS = {
  help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  server: { type: "string" }, "token-file": { type: "string" },
  mode: { type: "string" }, goal: { type: "string" }, target: { type: "string" },
  expect: { type: "string", multiple: true }, constraints: { type: "string", multiple: true },
  account: { type: "string" }, roles: { type: "string" }, env: { type: "string" },
  capabilities: { type: "string" }, tags: { type: "string" },
  "max-steps": { type: "string" }, "timeout-seconds": { type: "string" },
  "wait-seconds": { type: "string" }, "poll-ms": { type: "string" },
  "http-timeout-seconds": { type: "string" }, "request-id": { type: "string" },
  file: { type: "string" }, out: { type: "string" }, "out-dir": { type: "string" }
};

function fail(message) { throw new ClientError("INVALID_ARGUMENT", message); }
function required(value, name) { if (typeof value !== "string" || !value.trim()) fail(`Missing ${name}`); return value; }
function id(value) { const result = required(value, "ID"); if (!/^[\w-]+$/u.test(result)) fail("Invalid ID"); return result; }
export function number(value, fallback, name, max = 86400) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) fail(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) fail(`Invalid ${name}`);
  return parsed;
}
function only(values, allowed) {
  const global = ["help", "version", "server", "token-file", "http-timeout-seconds"];
  if (Object.keys(values).some((key) => !global.includes(key) && !allowed.includes(key))) fail("Option is not supported for this command");
}
const WAIT_OPTIONS = ["wait-seconds", "poll-ms", "out-dir"];
const GOAL_OPTIONS = ["mode", "goal", "target", "expect", "constraints", "account", "roles", "env", "capabilities", "tags", "max-steps", "timeout-seconds", "file", "request-id"];
const GOAL_FIELDS = ["mode", "goal", "target", "accountId", "selector", "expectations", "constraints", "maxSteps", "timeoutSeconds"];
const TERMINAL = new Set(["completed", "passed", "failed", "blocked", "cancelled", "timed_out"]);

export async function loadGoal(file, stdin = process.stdin) {
  let content;
  if (file === "-") {
    const chunks = []; let size = 0;
    for await (const chunk of stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 256 * 1024) fail("Input exceeds 256 KiB");
      chunks.push(Buffer.from(chunk));
    }
    content = Buffer.concat(chunks);
  } else {
    try { content = await readFile(resolve(file)); } catch { fail("Could not read the goal file"); }
  }
  if (content.length > 256 * 1024) fail("Input exceeds 256 KiB");
  let goal;
  try { goal = JSON.parse(content.toString("utf8")); } catch { fail("Goal file must be valid JSON"); }
  if (!goal || typeof goal !== "object" || Array.isArray(goal) || Object.keys(goal).some((k) => !GOAL_FIELDS.includes(k))) fail("Goal file contains unsupported fields; supply a goal, not browser steps");
  return goal;
}

export async function goalBody(values, alias, positionalGoal, stdin) {
  const body = values.file ? await loadGoal(values.file, stdin) : {};
  if (alias && values.mode && values.mode !== alias) fail("Command and --mode disagree");
  if (alias) body.mode = alias;
  else if (values.mode !== undefined) body.mode = values.mode;
  if (positionalGoal && values.goal) fail("Choose positional goal or --goal");
  if (values.goal !== undefined || positionalGoal) body.goal = values.goal ?? positionalGoal;
  if (values.target !== undefined) body.target = required(values.target, "--target");
  const selectors = ["roles", "capabilities", "tags", "env"];
  if (values.account && selectors.some((k) => values[k] !== undefined)) fail("Choose --account or selector options");
  if (values.account) { delete body.selector; body.accountId = values.account; }
  if (selectors.some((k) => values[k] !== undefined)) {
    delete body.accountId;
    body.selector = { ...body.selector };
    for (const key of selectors) if (values[key] !== undefined) body.selector[key] = key === "env" ? values[key] : values[key].split(",").map((v) => v.trim()).filter(Boolean);
  }
  if (values.expect) body.expectations = values.expect;
  if (values.constraints) body.constraints = values.constraints;
  if (values["max-steps"] !== undefined) body.maxSteps = number(values["max-steps"], undefined, "--max-steps", 30);
  if (values["timeout-seconds"] !== undefined) body.timeoutSeconds = number(values["timeout-seconds"], undefined, "--timeout-seconds", 3600);
  if (!["walkthrough", "test"].includes(body.mode)) fail("Choose mode walkthrough or test");
  required(body.goal, "goal");
  return body;
}

export function runExit(run) {
  if (run.cleanup?.status === "unknown") return 2;
  if (run.status === "failed") return 1;
  if (["completed", "passed"].includes(run.status)) return 0;
  return 2;
}

export async function waitForRun(client, runId, { signal, waitSeconds = 900, pollMs = 1000 } = {}) {
  const deadline = Date.now() + waitSeconds * 1000;
  const waitLimit = AbortSignal.timeout(waitSeconds * 1000);
  const waiting = signal ? AbortSignal.any([signal, waitLimit]) : waitLimit;
  try {
    while (true) {
      if (signal?.aborted) throw new ClientError("INTERRUPTED", "Stopped waiting; the server workflow may continue");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ClientError("WAIT_TIMEOUT", "Stopped waiting; inspect or cancel the existing run instead of resubmitting it");
      const run = await client.request("GET", `/v1/runs/${id(runId)}`, { signal: waiting, timeoutMs: Math.min(client.timeoutMs, remaining) });
      if (run.finishedAt && TERMINAL.has(run.status)) return run;
      try { await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: waiting }); }
      catch { throw new ClientError("INTERRUPTED", "Stopped waiting; the server workflow may continue"); }
    }
  } catch (error) {
    const failure = waitLimit.aborted && !signal?.aborted ? new ClientError("WAIT_TIMEOUT", "Stopped waiting; inspect or cancel the existing run instead of resubmitting it") : error instanceof ClientError ? error : new ClientError("WAIT_FAILED", "Could not read the workflow result");
    failure.details = { ...failure.details, runId };
    throw failure;
  }
}

async function downloadResult(client, run, dir, signal) {
  const files = [];
  for (const artifactId of new Set(run.artifacts.map((a) => a.id))) {
    if (!/^[\w-]+\.(png|html)$/u.test(artifactId)) throw new ClientError("INVALID_ARTIFACT", "Server returned an invalid artifact ID");
    files.push(await client.download(artifactId, join(resolve(dir), artifactId), { signal }));
  }
  await mkdir(resolve(dir), { recursive: true });
  await writeFile(join(resolve(dir), "result.json"), JSON.stringify(run, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return files;
}

export async function executeCommand(client, positionals, values, { signal, stdin } = {}) {
  const [command, sub, ...rest] = positionals;
  const requestId = values["request-id"] ?? randomUUID();
  if (!/^[\x21-\x7e]{1,96}$/u.test(requestId)) fail("--request-id must be 1–96 printable ASCII characters");
  const waitOptions = { signal, waitSeconds: number(values["wait-seconds"], 900, "--wait-seconds"), pollMs: number(values["poll-ms"], 1000, "--poll-ms", 10_000) };
  const get = (path) => client.request("GET", path, { signal });
  const post = (path, body) => client.request("POST", path, { body, requestId, signal });
  const wrap = (data, extra = {}, exitCode = 0) => ({ output: { data, ...extra }, exitCode });
  const finish = async (run, extra = {}) => {
    try {
      const files = values["out-dir"] ? await downloadResult(client, run, values["out-dir"], signal) : undefined;
      return wrap(run, { ...extra, ...(files ? { downloads: files } : {}) }, runExit(run));
    } catch (error) {
      const failure = error instanceof ClientError ? error : new ClientError("OUTPUT_ERROR", "Could not save evidence; output files are never overwritten");
      failure.details = { ...failure.details, runId: run.id, ...extra };
      throw failure;
    }
  };
  if (["health", "capabilities", "openapi"].includes(command)) {
    only(values, []); if (positionals.length !== 1) fail("Unexpected positional argument");
    return wrap(await client.request("GET", command === "health" ? "/health" : `/v1/${command === "openapi" ? "openapi.json" : command}`, { signal, publicEndpoint: command === "health" }));
  }
  if (command === "accounts" && sub === "list" && !rest.length) { only(values, []); return wrap(await get("/v1/accounts")); }
  if (command === "artifact" && sub === "get" && rest.length === 1) {
    only(values, ["out"]); return wrap(await client.download(rest[0], required(values.out, "--out"), { signal }));
  }
  if (command === "run") {
    if (sub === "list" && !rest.length) { only(values, []); return wrap(await get("/v1/runs")); }
    if (["get", "wait", "cancel"].includes(sub) && rest.length === 1) {
      only(values, sub === "wait" ? WAIT_OPTIONS : sub === "cancel" ? ["request-id"] : []);
      const runId = id(rest[0]);
      if (sub === "get") return wrap(await get(`/v1/runs/${runId}`));
      if (sub === "cancel") return wrap(await post(`/v1/runs/${runId}/cancel`, {}), { requestId });
      return finish(await waitForRun(client, runId, waitOptions));
    }
  }
  const alias = command === "walkthrough" || command === "test" ? command : undefined;
  const submit = command === "run" && sub === "submit" && !rest.length;
  if (alias || command === "run" && positionals.length === 1 || submit) {
    only(values, [...GOAL_OPTIONS, ...(submit ? [] : WAIT_OPTIONS)]);
    const body = await goalBody(values, alias, alias ? positionals.slice(1).join(" ") : undefined, stdin);
    let run = await post("/v1/runs", body);
    if (submit) return wrap(run, { requestId });
    try { run = await waitForRun(client, run.id, waitOptions); }
    catch (error) { if (error instanceof ClientError) error.details = { ...error.details, requestId }; throw error; }
    return finish(run, { requestId });
  }
  fail("Unknown command or arguments; run tutti-qa --help");
}
