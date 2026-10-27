import { mkdir, readFile, copyFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { aiStep, createAgent, loadMidscene } from "../ai/midscene.ts";
import { missingModelEnv } from "../core/config.ts";
import type { Account } from "./accounts.ts";
import { checkUrl, type ServiceConfig } from "./config.ts";
import { ServiceError, type Artifact, type Step, type StepResult } from "./protocol.ts";

export interface BrowserHandle {
  execute(step: Step, artifactId: string): Promise<StepResult>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  open(id: string, account?: Account, url?: string): Promise<BrowserHandle>;
}

export class PlaywrightProvider implements BrowserProvider {
  private modelReady: Promise<void> | undefined;
  readonly config: ServiceConfig;
  constructor(config: ServiceConfig) { this.config = config; }

  async open(id: string, account?: Account, url?: string): Promise<BrowserHandle> {
    const config = this.config;
    const storageState = account ? await account.loadState() : undefined;
    const initialUrl = url ?? account?.url;
    const validateUrl = (url: string) => {
      try { return checkUrl(url, config.allowedOrigins, account?.allowedOrigins); }
      catch { throw new ServiceError(400, "ORIGIN_NOT_ALLOWED", "URL is invalid or its origin is not allowed"); }
    };
    if (initialUrl) validateUrl(initialUrl);
    // 每个会话单独启动进程：超时/取消可以关闭本会话，其他调用方不受影响。
    const browser: Browser = await chromium.launch({ headless: config.headless });
    try {
      const context = await browser.newContext({
        storageState, viewport: { width: 1440, height: 900 }, acceptDownloads: false,
        serviceWorkers: "block"
      });
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(30_000);
      let deniedNavigation = false;
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && !request.frame().parentFrame()) {
          try { validateUrl(request.url()); }
          catch { deniedNavigation = true; await route.abort("blockedbyclient"); return; }
        }
        await route.continue();
      });
      const page = await context.newPage();
      if (initialUrl) await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
      const artifactRoot = resolve(config.stateDir, "artifacts");
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
      const model = async () => {
        if (missingModelEnv().length) throw new ServiceError(503, "MODEL_UNAVAILABLE", "Configure the model on the host before AI steps");
        this.modelReady ??= loadMidscene(resolve(config.stateDir, "midscene"));
        await this.modelReady;
      };
      return {
        async execute(step, artifactId) {
          deniedNavigation = false;
          const artifacts: Artifact[] = [];
          const run = async (): Promise<StepResult> => {
            switch (step.type) {
              case "navigate":
                await page.goto(validateUrl(step.url), { waitUntil: "domcontentloaded" });
                return { type: step.type, pass: true, data: { url: page.url() } };
              case "click": await page.locator(step.selector).click(); break;
              case "fill": await page.locator(step.selector).fill(step.value); break;
              case "press": await page.locator(step.selector).press(step.key); break;
              case "select": await page.locator(step.selector).selectOption(step.value); break;
              case "snapshot": return { type: step.type, pass: true, data: await snapshot(page) };
              case "screenshot": {
                const name = `${artifactId}.png`;
                await page.screenshot({ path: resolve(artifactRoot, name), fullPage: step.fullPage === true });
                artifacts.push({ id: name, contentType: "image/png" });
                break;
              }
              default: {
                await model();
                const agent = createAgent(page, {
                  id: `${id}-${artifactId}`, groupName: id, reportFileName: artifactId,
                  context: config.aiContext, cache: null
                });
                try {
                  const result = await aiStep(agent, step.type, step.prompt);
                  return { type: step.type, pass: result.pass, data: result.data ?? result.detail, artifacts };
                } finally {
                  // 只复制本次 agent 的报告；HTTP 侧只接受已登记的 artifact id。
                  if (agent.reportFile) {
                    const source = resolve(agent.reportFile);
                    const reportsRoot = resolve(config.stateDir, "midscene") + sep;
                    if (source.startsWith(reportsRoot)) {
                      const name = `${artifactId}.html`;
                      await copyFile(source, resolve(artifactRoot, name));
                      artifacts.push({ id: name, contentType: "text/html" });
                    }
                  }
                }
              }
            }
            return { type: step.type, pass: true, ...(artifacts.length ? { artifacts } : {}) };
          };
          const result = await run();
          if (deniedNavigation) throw new ServiceError(400, "ORIGIN_NOT_ALLOWED", "A navigation was blocked by the origin policy");
          return result;
        },
        close: () => browser.close()
      };
    } catch (error) {
      try { await browser.close(); }
      catch { throw new ServiceError(503, "CLEANUP_FAILED", "Browser startup cleanup is uncertain; account remains reserved"); }
      throw error;
    }
  }
}

async function snapshot(page: Page): Promise<{ url: string; title: string; tree: string }> {
  return { url: page.url(), title: await page.title(), tree: await page.locator("body").ariaSnapshot() };
}

export async function readArtifact(config: ServiceConfig, artifact: Artifact): Promise<Buffer> {
  if (!/^[\w-]+\.(png|html)$/u.test(artifact.id)) throw new Error("Invalid artifact id");
  return readFile(resolve(config.stateDir, "artifacts", artifact.id));
}
