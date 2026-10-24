// Midscene 基建：统一创建 agent（上下文提示、缓存、报告），并提供操作 / 断言 / 等待 / 查询四个原子能力。
// run 与 CLI 的单步命令都从这里拿 agent，保证同一套提示词、缓存与报告配置。
import type { Page } from "playwright";
import type { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { cacheConfig, type CacheScope, type CacheStats, instrumentCache } from "./cache.ts";

const AI_CONTEXT = [
  "你在操作 Tutti 的 Web 端（Room 是多人与 Agent 协作的房间）。",
  "界面可能是中文或英文，按含义而非字面匹配按钮与文案。",
  "不要点击与当前任务无关的入口；遇到新手引导、欢迎页或可跳过的提示时先跳过。"
].join("\n");

export interface AgentOptions {
  /** 报告与缓存的稳定标识，同一用例同一 actor 每次 Run 保持一致才能命中缓存 */
  readonly id: string;
  readonly groupName: string;
  readonly reportFileName: string;
  /** null 表示这个 agent 不用缓存 */
  readonly cache: CacheScope | null;
  /** 传入时累计该 agent 的缓存命中情况 */
  readonly stats?: CacheStats;
}

export function createAgent(page: Page, options: AgentOptions): PlaywrightAgent {
  const { PlaywrightAgent: Agent } = loadedMidscene();
  const cache = cacheConfig(options.cache, options.id);
  const agent = new Agent(page, {
    testId: options.id,
    groupName: options.groupName,
    reportFileName: options.reportFileName,
    generateReport: true,
    autoPrintReportMsg: false,
    // AI_CONTEXT 是每条缓存键的一部分，改动它会让全部缓存失效
    aiContexts: { default: AI_CONTEXT },
    ...(cache ? { cache } : {})
  });
  if (options.stats) instrumentCache(agent, options.stats);
  return agent;
}

export type StepVerb = "act" | "assert" | "wait" | "query";

export interface StepResult {
  readonly verb: StepVerb;
  readonly prompt: string;
  /** act / wait 成功即 true；assert 为断言结论；query 恒为 true */
  readonly pass: boolean;
  readonly detail: string;
  readonly data?: unknown;
}

/** 单步执行：act 与 wait 失败时抛错，assert 返回结论不抛错，query 返回结构化数据。 */
export async function aiStep(
  agent: PlaywrightAgent,
  verb: StepVerb,
  prompt: string,
  options: { readonly timeoutMs?: number; readonly cacheable?: boolean } = {}
): Promise<StepResult> {
  switch (verb) {
    case "act":
      await agent.aiAct(prompt, { cacheable: options.cacheable !== false });
      return { verb, prompt, pass: true, detail: "" };
    case "wait":
      await agent.aiWaitFor(prompt, { timeoutMs: options.timeoutMs ?? 60_000, checkIntervalMs: 3_000 });
      return { verb, prompt, pass: true, detail: "" };
    case "assert": {
      const verdict = await agent.aiAssert(prompt, undefined, { keepRawResponse: true });
      return { verb, prompt, pass: Boolean(verdict?.pass), detail: verdict?.thought ?? verdict?.message ?? "" };
    }
    case "query": {
      const data = await agent.aiQuery(prompt);
      return { verb, prompt, pass: true, detail: "", data };
    }
  }
}

// Midscene 在 import 时读取 MIDSCENE_RUN_DIR，所以必须先设置环境变量再动态加载。
let midscene: typeof import("@midscene/web/playwright/agent") | null = null;

export async function loadMidscene(runDir: string): Promise<void> {
  process.env.MIDSCENE_RUN_DIR = runDir;
  // Midscene 默认按本机时区决定思考与判定理由的语言（只有 Asia/Shanghai 才是中文），这里固定为中文
  process.env.MIDSCENE_PREFERRED_LANGUAGE ??= "Chinese";
  midscene = await import("@midscene/web/playwright/agent");
}

function loadedMidscene(): typeof import("@midscene/web/playwright/agent") {
  if (!midscene) throw new Error("Midscene 尚未加载，先调用 loadMidscene");
  return midscene;
}
