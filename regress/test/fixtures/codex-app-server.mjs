import { createInterface } from "node:readline";
import { appendFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, log] = process.argv.slice(2);
const send = (value) => console.log(JSON.stringify(value));
const response = (id, result) => send({ id, result });
let initialized = false;
let count = 0;
const turns = new Map();
const histories = new Map();
const workdirs = new Map();
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on("line", (line) => { pending = pending.then(() => receive(line)); });
async function receive(line) {
  const message = JSON.parse(line);
  await appendFile(log, JSON.stringify(message) + "\n", { mode: 0o600 });
  const { id, method, params = {} } = message;
  if (!method) return;
  if (method === "initialize") { response(id, { userAgent: "fixture" }); return; }
  if (method === "initialized") { initialized = true; return; }
  if (!initialized) { send({ id, error: { code: -32000, message: "Not initialized" } }); return; }
  if (method === "skills/list") {
    response(id, { data: [{ skills: mode === "missing-skill" ? [] : [{ name: "ego-browser", path: "/fixture/ego-browser/SKILL.md", enabled: true }] }] }); return;
  }
  if (method === "model/list") { response(id, { data: [{ model: "host-default-model", isDefault: true }] }); return; }
  if (method === "thread/start") {
    const threadId = `thread-${++count}`; histories.set(threadId, 0);
    workdirs.set(threadId, params.cwd);
    response(id, { thread: { id: threadId } }); return;
  }
  if (method === "thread/unsubscribe") { response(id, { status: "unsubscribed" }); return; }
  if (method === "turn/interrupt") {
    response(id, {});
    const current = turns.get(params.threadId);
    if (current) {
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: current, status: "interrupted" } } });
      turns.delete(params.threadId);
    }
    return;
  }
  if (method !== "turn/start") { send({ id, error: { code: -32601, message: "Unknown method" } }); return; }
  const threadId = params.threadId;
  const round = (histories.get(threadId) ?? 0) + 1; histories.set(threadId, round);
  const turnId = `${threadId}-turn-${round}`; turns.set(threadId, turnId);
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
  const ack = () => response(id, { turn: { id: turnId, status: "inProgress" } });
  if (mode !== "early-completion" && mode !== "hold-ack") ack();
  if (mode === "crash") { process.exit(1); }
  send({ method: "item/started", params: { threadId, turnId, item: { id: "native-command", type: "commandExecution", command: "ego-browser nodejs: native reload, keyboard and waits" } } });
  if (mode === "hold" || mode === "hold-ack") return;
  if (mode === "interaction") {
    send({ id: 900, method: "item/tool/requestUserInput", params: { threadId, turnId } }); return;
  }
  let report = { answer: "Native tool work completed", round };
  if (params.outputSchema?.properties?.status) {
    const screenshots = join(params.cwd ?? workdirs.get(threadId), "screenshots");
    await mkdir(screenshots, { recursive: true });
    if (mode === "parent-symlink") {
      const outside = join(screenshots, "..", "outside"); await mkdir(outside);
      await rm(screenshots, { recursive: true }); await symlink(outside, screenshots);
    }
    if (mode !== "missing-evidence") {
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/ngAAAAASUVORK5CYII=", "base64");
      if (mode === "symlink") { const outside = join(screenshots, "..", "outside.png"); await writeFile(outside, bytes); await symlink(outside, join(screenshots, "observed.png")); }
      else await writeFile(join(screenshots, "observed.png"), bytes);
    }
    report = { status: mode === "blocked" ? "blocked" : "completed", summary: "Observed the goal using native Ego operations", uncovered: mode === "blocked" ? ["Login is required"] : [], observations: mode === "empty-evidence" ? [] : [{ summary: "Observed the requested state", url: mode === "wrong-origin" ? "https://outside.test" : "https://example.org", title: "Fixture", screenshot: mode === "traversal" ? "../observed.png" : "observed.png" }] };
  }
  const text = mode === "invalid-report" ? "Not a report" : JSON.stringify(report);
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "native-command", type: "commandExecution", command: "ego-browser nodejs", status: "completed", exitCode: 0 } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "result", type: "agentMessage", phase: "final_answer", text } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  turns.delete(threadId);
  if (mode === "early-completion") ack();
}
