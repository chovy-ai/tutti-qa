// 事后清理：按 Run 台账为每个测试用户补发登录码，登录后清空其房间，最后回收全部登录码。
import { join, resolve } from "node:path";
import { loadEnv, regressRoot } from "./config.ts";
import { actorFactory, launchBrowser } from "./browser.ts";
import { loadMidscene } from "./midscene.ts";
import { clearRooms, enterApp, flowContext } from "./flows.ts";
import { deleteLoginCode } from "./identity.ts";
import { openLedger, readLedger } from "./ledger.ts";

export interface CleanupResult {
  readonly users: readonly { userId: string; leftovers: readonly string[]; error?: string }[];
  readonly loginCodesDeleted: number;
  readonly errors: readonly string[];
}

export async function cleanupRun(runId: string, envId: string): Promise<CleanupResult> {
  const env = await loadEnv(envId);
  const runDir = resolve(regressRoot, ".runs", runId);
  const ledger = openLedger(runDir);
  const userIds = [
    ...new Set(
      (await readLedger(ledger.file)).flatMap((entry) => (entry.kind === "login-code" && entry.userId ? [entry.userId] : []))
    )
  ];
  await loadMidscene(join(runDir, "midscene-cleanup"));
  const browser = await launchBrowser();
  const users: CleanupResult["users"][number][] = [];
  try {
    const factory = actorFactory(browser, env, ledger, { flowCacheWritable: false });
    for (const userId of userIds) {
      try {
        const actor = await factory.create("cleanup", "cleanup", "cleanup", userId);
        await enterApp(flowContext({ env, runId, tag: "cleanup", caseId: "cleanup", ledger }), actor);
        users.push({ userId, leftovers: await clearRooms(actor, env) });
        await actor.context.close();
      } catch (error) {
        users.push({ userId, leftovers: [], error: (error as Error).message });
      }
    }
  } finally {
    await browser.close();
  }
  const errors: string[] = [];
  let deleted = 0;
  for (const entry of await readLedger(ledger.file)) {
    if (entry.kind !== "login-code") continue;
    try {
      await deleteLoginCode(env, entry.id);
      deleted += 1;
    } catch (error) {
      // 已删除的登录码再次删除会失败，这里只记录不中断
      errors.push(`登录码 ${entry.id}：${(error as Error).message}`);
    }
  }
  return { users, loginCodesDeleted: deleted, errors };
}
