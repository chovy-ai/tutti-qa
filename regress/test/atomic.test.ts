import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnv } from "../src/core/config.ts";
import { sessionCookies } from "../src/identity/identity.ts";
import { caseTag } from "../src/browser/actor.ts";
import {
  cacheConfig,
  cacheStrategy,
  caseCacheDir,
  emptyStats,
  flowCacheDir,
  hitRate,
  instrumentCache,
  sessionCacheDir
} from "../src/ai/cache.ts";
import { flowContext } from "../src/flows/flows.ts";
import { stablePin } from "../src/run/runner.ts";
import { midsceneStatus } from "../src/run/report.ts";

test("cacheStrategy 默认关闭，只接受 Midscene 支持的策略", () => {
  assert.equal(cacheStrategy(undefined), null);
  assert.equal(cacheStrategy("off"), null);
  assert.equal(cacheStrategy("read-write"), "read-write");
  assert.throws(() => cacheStrategy("on"), /REGRESS_CACHE/u);
});

test("midsceneStatus 把阻塞与待复核映射为 interrupted", () => {
  assert.equal(midsceneStatus("passed"), "passed");
  assert.equal(midsceneStatus("failed"), "failed");
  assert.equal(midsceneStatus("skipped"), "skipped");
  assert.equal(midsceneStatus("blocked"), "interrupted");
  assert.equal(midsceneStatus("uncertain"), "interrupted");
});

test("sessionCookies：session_id 落根域，迁移标记为 host-only", async () => {
  const env = await loadEnv("prod");
  const [session, migrated] = sessionCookies(env, "sid");
  assert.equal(session?.domain, env.sessionCookieDomain);
  assert.equal(session?.value, "sid");
  assert.equal(migrated?.domain, undefined);
  assert.equal(migrated?.url, new URL("/", env.webUrl).toString());
});

test("instrumentCache 统计命中、未命中与回退，回退计入有效命中率", () => {
  const records: unknown[] = [];
  const taskCache = {
    isCacheResultUsed: true,
    matchCache: (prompt: unknown, _type: string) => (prompt === "known" ? { updateFn: () => undefined } : undefined),
    updateOrAppendCacheRecord: (record: unknown, _cached?: unknown) => void records.push(record)
  };
  const stats = emptyStats();
  instrumentCache({ taskCache } as never, stats);
  taskCache.matchCache("known", "plan");
  taskCache.matchCache("new", "plan");
  taskCache.matchCache("known", "locate");
  taskCache.updateOrAppendCacheRecord({ type: "locate" }, { cacheContent: {} });
  taskCache.updateOrAppendCacheRecord({ type: "plan" });
  assert.deepEqual(stats, { plan: { hit: 1, miss: 1, fallback: 0 }, locate: { hit: 1, miss: 0, fallback: 1 } });
  assert.equal(records.length, 2);
  assert.equal(hitRate(stats), 1 / 3);
  assert.equal(hitRate(emptyStats()), null);
});

test("cacheConfig：共享 flow 在并发时降为只读，缓存关闭或不配目录时不启用", () => {
  const saved = process.env.REGRESS_CACHE;
  try {
    process.env.REGRESS_CACHE = "read-write";
    assert.equal(cacheConfig({ dir: flowCacheDir("prod"), writable: false }, "flow-x")?.strategy, "read-only");
    assert.equal(cacheConfig({ dir: caseCacheDir("room-p0", "prod") }, "c")?.strategy, "read-write");
    assert.equal(cacheConfig(null, "c"), undefined);
    delete process.env.REGRESS_CACHE;
    assert.equal(cacheConfig({ dir: caseCacheDir("room-p0", "prod") }, "c"), undefined);
  } finally {
    if (saved === undefined) delete process.env.REGRESS_CACHE;
    else process.env.REGRESS_CACHE = saved;
  }
});

test("缓存目录：用例缓存随 suite 入库，flow 缓存共享，单步缓存只在本机", () => {
  assert.match(caseCacheDir("room-p0", "prod"), /regress\/suites\/room-p0\/cache\/prod$/u);
  assert.match(flowCacheDir("prod"), /regress\/flows-cache\/prod$/u);
  assert.match(sessionCacheDir("prod"), /regress\/\.local-cache\/sessions\/prod$/u);
  assert.throws(() => caseCacheDir("../x", "prod"), /suite id/u);
});

test("测试数据按用例固定：密码与房间名每次一致，用例内房间名递增", () => {
  assert.equal(stablePin("case-a"), stablePin("case-a"));
  assert.match(stablePin("case-a"), /^\d{6}$/u);
  assert.notEqual(stablePin("case-a"), stablePin("case-b"));
  const ctx = flowContext({ env: {} as never, runId: "r", tag: "abc123", caseId: "abc123ff", ledger: {} as never });
  assert.equal(ctx.nextRoomName(), "abc123-1");
  assert.equal(ctx.nextRoomName(), "abc123-2");
  assert.equal(caseTag("fbaa0d30-3372"), "fbaa0d");
});
