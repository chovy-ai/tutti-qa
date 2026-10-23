// 浏览器与 Actor：每个 actor 是一个独立用户、独立 BrowserContext，各自持有一个 Midscene agent。
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { PlaywrightAgent } from "@midscene/web/playwright/agent";
import type { EnvProfile } from "./config.ts";
import { createLoginCode, exchangeSession, type LoginCode } from "./identity.ts";
import type { Ledger } from "./ledger.ts";

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
  agent: PlaywrightAgent;
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

const AI_CONTEXT = [
  "你在操作 Tutti 的 Web 端（Room 是多人与 Agent 协作的房间）。",
  "界面可能是中文或英文，按含义而非字面匹配按钮与文案。",
  "不要点击与当前任务无关的入口；遇到新手引导、欢迎页或可跳过的提示时先跳过。"
].join("\n");

export async function launchBrowser(): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return chromium.launch({
    headless: process.env.REGRESS_HEADED !== "1",
    ...(proxy ? { proxy: { server: proxy, bypass: process.env.NO_PROXY ?? process.env.no_proxy } } : {})
  });
}

export function actorFactory(
  browser: Browser,
  env: EnvProfile,
  runId: string,
  ledger: Ledger
): ActorFactory {
  const issues: NetworkIssue[] = [];
  const { PlaywrightAgent: Agent } = loadedMidscene();
  const open = async (
    context: BrowserContext,
    name: string,
    caseId: string,
    reportName: string
  ): Promise<{ page: Page; agent: PlaywrightAgent }> => {
    const page = await context.newPage();
    observe(page, name, issues);
    const agent = new Agent(page, {
      testId: `${caseId}-${name}`,
      groupName: reportName,
      reportFileName: `${reportName}-${name.replace("#", "-tab")}`,
      generateReport: true,
      autoPrintReportMsg: false,
      aiContexts: { default: AI_CONTEXT }
    });
    return { page, agent };
  };
  const actor = (
    name: string,
    displayName: string,
    context: BrowserContext,
    loginCode: LoginCode,
    opened: { page: Page; agent: PlaywrightAgent },
    caseId: string,
    reportName: string
  ): Actor => {
    const self: Actor = {
      name,
      displayName,
      context,
      loginCode,
      ...opened,
      async restart() {
        await self.page.close().catch(() => undefined);
        Object.assign(self, await open(context, name, caseId, reportName));
      }
    };
    return self;
  };
  return {
    browser,
    issues,
    async create(name, caseId, reportName, userId) {
      // 登录码的 display_name 会成为新用户昵称，带上 runId 便于在后台识别与清理
      const displayName = `QA ${name} ${runId.slice(9, 15)}`;
      const loginCode = await createLoginCode(env, displayName, userId);
      await ledger.add({ kind: "login-code", id: loginCode.id, userId: loginCode.userId, caseId });
      const context = await browser.newContext({
        locale: env.locale,
        timezoneId: env.timezoneId,
        viewport: { width: 1440, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"]
      });
      await exchangeSession(env, context, loginCode.code);
      return actor(name, displayName, context, loginCode, await open(context, name, caseId, reportName), caseId, reportName);
    },
    async tab(base, name, caseId, reportName) {
      const opened = await open(base.context, name, caseId, reportName);
      return actor(name, base.displayName, base.context, base.loginCode, opened, caseId, reportName);
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

// Midscene 在 import 时读取 MIDSCENE_RUN_DIR，所以必须先设置环境变量再动态加载。
let midscene: typeof import("@midscene/web/playwright/agent") | null = null;

export async function loadMidscene(runDir: string): Promise<void> {
  process.env.MIDSCENE_RUN_DIR = runDir;
  midscene = await import("@midscene/web/playwright/agent");
}

function loadedMidscene(): typeof import("@midscene/web/playwright/agent") {
  if (!midscene) throw new Error("Midscene 尚未加载，先调用 loadMidscene");
  return midscene;
}
