// Real app-server/tool/session smoke; reads only Ego's installed guide, never opens a browser.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServer } from "../src/service/codex-app-server.ts";

const server = new CodexAppServer();
const dir = await mkdtemp(join(tmpdir(), "tutti-codex-session-smoke-"));
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Session smoke timed out")), 120_000);
let threadId: string | undefined;
try {
  const catalog = await server.request("skills/list", { cwds: [dir] });
  const entries = catalog.data as { skills: { name: string; path: string; enabled: boolean }[] }[];
  const skill = entries.flatMap((entry) => entry.skills).find((skill) => skill.name === "ego-browser" && skill.enabled);
  assert.ok(skill, "An enabled ego-browser skill is required");
  const models = await server.request("model/list", { includeHidden: false });
  const model = (models.data as { model: string; isDefault: boolean }[]).find((model) => model.isDefault)?.model;
  assert.ok(model, "Codex must advertise a default model");
  const started = await server.request("thread/start", {
    cwd: dir, model, ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
    developerInstructions: "This is a metadata-only integration smoke. Run ego-browser skill to read the installed guide. Do not create, inspect or operate any browser spaces or webpages, read credentials, or change configuration."
  });
  threadId = (started.thread as { id: string }).id;
  const outputSchema = { type: "object", additionalProperties: false, required: ["marker", "guideVersion"], properties: { marker: { type: "string" }, guideVersion: { type: "string" } } };
  const marker = randomUUID();
  let events = 0;
  const first = await server.turn(threadId, {
    input: [
      { type: "text", text: `$ego-browser Remember marker ${marker}. Run ego-browser skill once using the shell tool. Return the marker and installed guide version. Do not run ego-browser nodejs, access a page or open a browser.` },
      { type: "skill", name: skill.name, path: skill.path }
    ],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir], networkAccess: true }, outputSchema
  }, controller.signal, () => { events++; });
  const initial = JSON.parse(first.text) as { marker: string; guideVersion: string };
  assert.equal(initial.marker, marker); assert.ok(initial.guideVersion);
  assert.ok(first.toolItems.some((item) => item.type === "commandExecution" && typeof item.command === "string" && item.command.includes("ego-browser") && item.exitCode === 0), "Codex must actually execute the installed Ego CLI");
  console.log(JSON.stringify({ firstTurnCompleted: true, model, egoCommandSucceeded: true, guideVersion: initial.guideVersion, progressEvents: events }));
  const second = await server.turn(threadId, {
    input: [{ type: "text", text: "Return the marker and guide version from the previous turn using only the existing conversation history. Do not run any tools." }], outputSchema
  }, controller.signal);
  assert.deepEqual(JSON.parse(second.text), initial);
  console.log(JSON.stringify({ secondTurnCompleted: true, sameThread: true, contextRetained: true, browserOperations: false }));
} catch (error) {
  // Native details are deliberately kept out of stdout; task runners save scrubbed diagnostics.
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer); controller.abort(new Error("Session smoke finished"));
  if (threadId) {
    await server.stopThread(threadId).catch(() => {});
    await server.request("thread/unsubscribe", { threadId }).catch(() => {});
  }
  await server.close(); await rm(dir, { recursive: true, force: true });
}
