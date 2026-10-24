// Midscene 缓存：目录布局、读写策略与命中统计。
// 缓存只覆盖「怎么操作」（aiAct 的规划与元素定位），断言、等待、查询每次都走模型。
//
// suites/<suite>/cache/<env>/<用例id>-<actor>.cache.yaml   用例自己的 steps，入库；用例通过后清掉本次未用到的条目
// flows-cache/<env>/flow-<flow>.cache.yaml                公共前置流程，跨用例共享，入库；只在串行 Run 中写入，并发时只读
// .local-cache/sessions/<env>/<cacheId>.cache.yaml        单步命令（act / assert …），只在本机
import { resolve } from "node:path";
import type { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { regressRoot, suiteDir } from "../core/config.ts";

export type CacheStrategy = "read-only" | "read-write" | "write-only";

export function caseCacheDir(suite: string, env: string): string {
  return resolve(suiteDir(suite), "cache", env);
}

export function flowCacheDir(env: string): string {
  return resolve(regressRoot, "flows-cache", env);
}

export function sessionCacheDir(env: string): string {
  return resolve(regressRoot, ".local-cache", "sessions", env);
}

/** 缓存默认关闭；REGRESS_CACHE=read-write 等开启。 */
export function cacheStrategy(value = process.env.REGRESS_CACHE): CacheStrategy | null {
  if (!value || value === "off") return null;
  if (value === "read-only" || value === "read-write" || value === "write-only") return value;
  throw new Error(`REGRESS_CACHE 只能是 off / read-only / read-write / write-only，当前为 ${value}`);
}

export interface CacheScope {
  /** 缓存文件所在目录，见文件头的布局 */
  readonly dir: string;
  /** false 时即使全局为 read-write 也只读，用于并发 Run 中的共享 flow 缓存 */
  readonly writable?: boolean;
}

/** 返回 Midscene agent 的 cache 配置；缓存关闭或 scope 为 null 时返回 undefined。 */
export function cacheConfig(scope: CacheScope | null, id: string): { id: string; strategy: CacheStrategy; cacheDir: string } | undefined {
  const strategy = cacheStrategy();
  if (!strategy || !scope) return undefined;
  const effective = scope.writable === false && strategy !== "write-only" ? "read-only" : strategy;
  return { id, strategy: effective, cacheDir: scope.dir };
}

/**
 * hit：查到了缓存记录；fallback：查到了但这次没用上（plan 回放失败、xpath 在当前页面找不到元素），
 * 回退到 AI 并更新了记录，是 hit 的子集；miss：没有记录，走 AI 后新写入。
 */
export interface CacheStats {
  readonly plan: { hit: number; miss: number; fallback: number };
  readonly locate: { hit: number; miss: number; fallback: number };
}

export function emptyStats(): CacheStats {
  return { plan: { hit: 0, miss: 0, fallback: 0 }, locate: { hit: 0, miss: 0, fallback: 0 } };
}

export function addStats(target: CacheStats, source: CacheStats): CacheStats {
  target.plan.hit += source.plan.hit;
  target.plan.miss += source.plan.miss;
  target.plan.fallback += source.plan.fallback;
  target.locate.hit += source.locate.hit;
  target.locate.miss += source.locate.miss;
  target.locate.fallback += source.locate.fallback;
  return target;
}

/** 有效命中率（0–1）：真正省掉模型调用的查找占比；没有任何查找时返回 null。 */
export function hitRate(stats: CacheStats): number | null {
  const total = stats.plan.hit + stats.plan.miss + stats.locate.hit + stats.locate.miss;
  const effective = stats.plan.hit - stats.plan.fallback + stats.locate.hit - stats.locate.fallback;
  return total === 0 ? null : effective / total;
}

interface TaskCacheLike {
  isCacheResultUsed?: boolean;
  matchCache(prompt: unknown, type: "plan" | "locate"): { updateFn?: unknown } | undefined;
  updateOrAppendCacheRecord(newRecord: unknown, cachedRecord?: unknown): void;
}

/**
 * 包装 agent 内部的 TaskCache，统计命中、未命中与回退。
 * 依赖 Midscene 1.16 的 TaskCache.matchCache / updateOrAppendCacheRecord；结构变化时静默不统计，不影响执行。
 */
export function instrumentCache(agent: PlaywrightAgent, stats: CacheStats): void {
  const cache = (agent as unknown as { taskCache?: TaskCacheLike }).taskCache;
  if (!cache || typeof cache.matchCache !== "function" || typeof cache.updateOrAppendCacheRecord !== "function") return;
  const match = cache.matchCache.bind(cache);
  cache.matchCache = (prompt, type) => {
    const result = match(prompt, type);
    // 只读文件被关闭（write-only）时 matchCache 不查找，也就不算未命中
    if (cache.isCacheResultUsed === false) return result;
    if (type === "plan") stats.plan[result ? "hit" : "miss"] += 1;
    else stats.locate[result ? "hit" : "miss"] += 1;
    return result;
  };
  const update = cache.updateOrAppendCacheRecord.bind(cache);
  cache.updateOrAppendCacheRecord = (newRecord, cachedRecord) => {
    const type = (newRecord as { type?: string }).type;
    if (cachedRecord && (type === "plan" || type === "locate")) stats[type].fallback += 1;
    update(newRecord, cachedRecord);
  };
}
