// 浏览器与 Actor：每个 actor 是一个独立用户、独立 BrowserContext。
// 一个 actor 持有一个用例 agent（用例自己的 steps）和按需创建的 flow agent（公共前置流程，跨用例共享缓存）。
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { addStats, type CacheStats, emptyStats } from "./cache.ts";
import type { EnvProfile } from "./config.ts";
import { createLoginCode, exchangeSession, type LoginCode } from "./identity.ts";
import type { Ledger } from "./ledger.ts";
import { createAgent } from "./midscene.ts";

export interface NetworkIssue {
  readonly actor: string;
  readonly kind: "http" | "requestfailed" | "console" | "pageerror";
  readonly detail: string;
  readonly at: string;
}

export interface Actor {
  readonly name: string;
  readonly displayName: string;
  readonly context: BrowserContext;
  readonly loginCode: LoginCode;
  page: Page;
  /** 用例自己的 agent，缓存在 cases/<用例id>-<actor> */
  agent: PlaywrightAgent;
  /** 公共 flow 的 agent，缓存在 flows/<flow>，同一页面上按 flow 名复用 */
  flow(name: string): PlaywrightAgent;
  /** 本 actor 创建过的全部 agent（含超时重启前的），用于收集报告 */
  agents(): readonly PlaywrightAgent[];
  /** 用例 agent 与 flow agent 的缓存命中情况 */
  cacheStats(): CacheStats;
  /** 关闭当前页面（中断进行中的 AI 操作），换一个新页面与 agent，用于超时后的清理 */
  restart(): Promise<void>;
}

export interface ActorFactory {
  readonly browser: Browser;
  readonly issues: NetworkIssue[];
  /** 申请登录码、建立独立 context；不传 userId 即新建用户 */
  create(name: string, caseId: string, reportName: string, userId?: string): Promise<Actor>;
  /** 同一用户的另一个标签页（name 形如 owner#2），共享 context 与登录态 */
  tab(base: Actor, name: string, caseId: string, reportName: string): Promise<Actor>;
}

export interface ActorFactoryOptions {
  /** 共享的 flow 缓存是否可写；并发 Run 中多个 worker 同时写同一文件会互相覆盖，只在串行时写 */
  readonly flowCacheWritable: boolean;
}

export async function launchBrowser(): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return chromium.launch({
    headless: process.env.REGRESS_HEADED !== "1",
    ...(proxy ? { proxy: { server: proxy, bypass: process.env.NO_PROXY ?? process.env.no_proxy } } : {})
  });
}

/** 测试数据的稳定标识：取用例 id 前 6 位，同一用例每次 Run 一致，提示词才能命中缓存 */
export function caseTag(caseId: string): string {
  return caseId.slice(0, 6);
}

export function actorFactory(
  browser: Browser,
  env: EnvProfile,
  ledger: Ledger,
  options: ActorFactoryOptions
): ActorFactory {
  const issues: NetworkIssue[] = [];
  const actor = async (
    name: string,
    displayName: string,
    context: BrowserContext,
    loginCode: LoginCode,
    caseId: string,
    reportName: string
  ): Promise<Actor> => {
    const reportBase = `${reportName}-${name.replace("#", "-tab")}`;
    const created: PlaywrightAgent[] = [];
    const caseStats = emptyStats();
    const flowStats = emptyStats();
    let flowAgents = new Map<string, PlaywrightAgent>();
    const open = async (): Promise<{ page: Page; agent: PlaywrightAgent }> => {
      const page = await context.newPage();
      observe(page, name, issues);
      const agent = createAgent(page, {
        id: `${caseId}-${name}`,
        groupName: reportName,
        reportFileName: reportBase,
        cache: { kind: "cases", env: env.id },
        stats: caseStats
      });
      created.push(agent);
      return { page, agent };
    };
    const self: Actor = {
      name,
      displayName,
      context,
      loginCode,
      ...(await open()),
      flow(flowName) {
        let agent = flowAgents.get(flowName);
        if (!agent) {
          agent = createAgent(self.page, {
            id: `flow-${flowName}`,
            groupName: reportName,
            reportFileName: `${reportBase}-flow-${flowName}`,
            cache: { kind: "flows", env: env.id, writable: options.flowCacheWritable },
            stats: flowStats
          });
          flowAgents.set(flowName, agent);
          created.push(agent);
        }
        return agent;
      },
      agents: () => created,
      cacheStats: () => addStats(addStats(emptyStats(), caseStats), flowStats),
      async restart() {
        await self.page.close().catch(() => undefined);
        flowAgents = new Map();
        Object.assign(self, await open());
      }
    };
    return self;
  };
  return {
    browser,
    issues,
    async create(name, caseId, reportName, userId) {
      // 登录码的 display_name 会成为新用户昵称：带用例标识便于在后台识别，且每次 Run 一致
      const displayName = `QA ${name} ${caseTag(caseId)}`;
      const loginCode = await createLoginCode(env, displayName, userId);
      await ledger.add({ kind: "login-code", id: loginCode.id, userId: loginCode.userId, caseId });
      const context = await browser.newContext({
        locale: env.locale,
        timezoneId: env.timezoneId,
        viewport: { width: 1440, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"]
      });
      await exchangeSession(env, context, loginCode.code);
      return actor(name, displayName, context, loginCode, caseId, reportName);
    },
    async tab(base, name, caseId, reportName) {
      return actor(name, base.displayName, base.context, base.loginCode, caseId, reportName);
    }
  };
}

function observe(page: Page, actor: string, issues: NetworkIssue[]): void {
  const at = () => new Date().toISOString();
  page.on("response", (response) => {
    if (response.status() >= 500 || (response.status() >= 400 && response.url().includes("/api/"))) {
      issues.push({ actor, kind: "http", detail: `${response.status()} ${redact(response.url())}`, at: at() });
    }
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    if (reason.includes("ERR_ABORTED")) return;
    issues.push({ actor, kind: "requestfailed", detail: `${reason} ${redact(request.url())}`, at: at() });
  });
  page.on("pageerror", (error) => issues.push({ actor, kind: "pageerror", detail: error.message.slice(0, 300), at: at() }));
}

/** 证据里只保留 origin + path，避免把 query 中的凭据写进报告。 */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u, 1)[0] ?? "";
  }
}
