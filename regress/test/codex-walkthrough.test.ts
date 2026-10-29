import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/service/codex-app-server.ts";
import { CodexWalkthroughAgent } from "../src/service/codex-walkthrough.ts";
import { loadConfig, checkUrl } from "../src/service/config.ts";
import type { EgoPage } from "../src/service/ego.ts";
import { ServiceError } from "../src/service/protocol.ts";
import { parseGoal } from "../src/service/workflow-protocol.ts";

async function fixture(t: { after(fn: () => Promise<unknown>): void }, mode = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "codex-walkthrough-"));
  const log = join(dir, "protocol.jsonl");
  const server = new CodexAppServer(process.execPath, [fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url)), mode, log]);
  const controller = new AbortController();
  await writeFile(join(dir, "config.json"), JSON.stringify({ stateDir: dir, allowedOrigins: ["https://example.org"] }));
  const config = await loadConfig(join(dir, "config.json"));
  const page = { spaceId: 23, account: { allowedOrigins: ["https://example.org"] }, validate(url: string) { checkUrl(url, config.allowedOrigins); } } as unknown as EgoPage;
  const agent = new CodexWalkthroughAgent(server, config, "run-1", controller.signal);
  t.after(async () => { controller.abort(new Error("Test finished")); await agent.close().catch(() => {}); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const messages = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id?: number; method?: string; params?: { developerInstructions: string; input: { type: string; name: string; text: string }[]; outputSchema: { properties: Record<string, unknown> } }; error?: unknown });
  return { dir, server, controller, page, agent, messages };
}

test("app-server 初始化一次，同一 thread 连续 turn 保留原生工具上下文", async (t) => {
  const f = await fixture(t);
  const started = await f.server.request("thread/start", { cwd: f.dir });
  const threadId = (started.thread as { id: string }).id;
  const first = await f.server.turn(threadId, { input: [{ type: "text", text: "Start walkthrough" }] }, f.controller.signal);
  const second = await f.server.turn(threadId, { input: [{ type: "text", text: "Continue" }] }, f.controller.signal);
  assert.equal(JSON.parse(first.text).round, 1); assert.equal(JSON.parse(second.text).round, 2);
  const messages = await f.messages();
  assert.equal(messages.filter((v) => v.method === "initialize").length, 1);
  assert.equal(messages.filter((v) => v.method === "thread/start").length, 1);
  assert.equal(messages.filter((v) => v.method === "turn/start").length, 2);
});

test("turn 完成事件早于提交回执时仍能读取最终报告", async (t) => {
  const f = await fixture(t, "early-completion");
  await f.server.request("thread/start", { cwd: f.dir });
  const result = await f.server.turn("thread-1", {}, f.controller.signal);
  assert.equal(JSON.parse(result.text).round, 1);
});

test("走查提交完整目标与 Ego skill，不再传下一步动作 schema，收集真实文件证据", async (t) => {
  const f = await fixture(t);
  let progress = 0;
  const goal = parseGoal({ mode: "walkthrough", goal: "Observe chat", target: "https://example.org", constraints: ["Read only"] });
  const result = await f.agent.run(f.page, goal, () => { progress++; });
  assert.equal(result.status, "completed"); assert.equal(progress, 1);
  assert.equal(result.observations.length, 1); assert.equal(result.artifacts.length, 1);
  assert.ok((await readFile(join(f.dir, "artifacts", result.artifacts[0]!.id))).length > 8);
  await f.agent.close();
  const messages = await f.messages();
  const thread = messages.find((v) => v.method === "thread/start")!;
  assert.match(thread.params!.developerInstructions, /TaskSpace 23/);
  const turn = messages.find((v) => v.method === "turn/start")!;
  assert.equal(turn.params!.input[1]!.type, "skill"); assert.equal(turn.params!.input[1]!.name, "ego-browser");
  assert.match(turn.params!.input[0]!.text, /Observe chat/); assert.match(turn.params!.input[0]!.text, /Read only/);
  assert.equal(turn.params!.outputSchema.properties.action, undefined);
  assert.ok(messages.some((v) => v.method === "thread/unsubscribe"));
});

test("缺少 Ego skill 时明确阻塞，不开启无浏览器能力的模型 turn", async (t) => {
  const f = await fixture(t, "missing-skill");
  await assert.rejects(f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {}), (e: ServiceError) => e.code === "EGO_SKILL_UNAVAILABLE");
  assert.equal((await f.messages()).some((v) => v.method === "turn/start"), false);
});

for (const [mode, code] of [["invalid-report", "CODEX_REPORT_INVALID"], ["empty-evidence", "WALKTHROUGH_INCOMPLETE"], ["missing-evidence", "WALKTHROUGH_EVIDENCE_INVALID"], ["traversal", "WALKTHROUGH_EVIDENCE_INVALID"], ["symlink", "WALKTHROUGH_EVIDENCE_INVALID"], ["parent-symlink", "WALKTHROUGH_EVIDENCE_INVALID"]]) {
  test(`拒绝缺失或无效证据：${mode}`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {}), (e: ServiceError) => e.code === code);
  });
}

test("最终报告中的越界 URL 被入口/结果域名策略拒绝", async (t) => {
  const f = await fixture(t, "wrong-origin");
  await assert.rejects(f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {}), /Origin is not allowed/u);
});

test("模型返回阻塞时保留未覆盖项，不转为走查完成", async (t) => {
  const f = await fixture(t, "blocked");
  const result = await f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {});
  assert.equal(result.status, "blocked"); assert.deepEqual(result.uncovered, ["Login is required"]);
});

for (const mode of ["hold", "hold-ack"]) {
  test(`取消 turn（${mode}）复用 interrupt，确认停止后释放订阅`, async (t) => {
  const f = await fixture(t, mode);
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const running = f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), entered);
  await started;
  f.controller.abort(new ServiceError(409, "CANCELLED", "Requested"));
  await assert.rejects(running, (e: ServiceError) => e.code === "CANCELLED");
  await f.agent.close();
  const messages = await f.messages();
  assert.equal(messages.filter((v) => v.method === "turn/interrupt").length, 1);
  assert.ok(messages.some((v) => v.method === "thread/unsubscribe"));
});

}

test("需要人工交互时明确阻塞，不伪造许可或用户回答", async (t) => {
  const f = await fixture(t, "interaction");
  await assert.rejects(f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {}), (e: ServiceError) => e.code === "CODEX_INTERACTION_REQUIRED");
  await f.agent.close();
  const response = (await f.messages()).find((v) => v.id === 900)!;
  assert.ok(response.error); assert.equal(Object.hasOwn(response, "result"), false);
});

test("app-server 中断后报告未确认，不自动重复提交目标", async (t) => {
  const f = await fixture(t, "crash");
  await assert.rejects(f.agent.run(f.page, parseGoal({ mode: "walkthrough", goal: "Observe" }), () => {}), (e: ServiceError) => e.code === "CODEX_UNAVAILABLE");
  assert.equal((await f.messages()).filter((v) => v.method === "turn/start").length, 1);
});
