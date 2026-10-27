import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { InputPrimitives, AbstractInterface } from "@midscene/core/device";
import type { defineActionsFromInputPrimitives } from "@midscene/core/device";
import type { Account } from "./accounts.ts";
import { checkUrl, type ServiceConfig } from "./config.ts";
import { ServiceError, type Artifact, type Step, type StepResult } from "./protocol.ts";
import type { BrowserHandle, BrowserProvider } from "./provider.ts";

export type BrowserAction =
  | { type: "click" | "fill" | "press"; selector: string; value?: string }
  | { type: "navigate"; url: string }
  | { type: "scroll"; x: number; y: number; startX?: number; startY?: number; repeat?: number }
  | { type: "tap" | "hover" | "doubleClick" | "rightClick"; x: number; y: number }
  | { type: "keyboard" | "text"; value: string }
  | { type: "type"; value: string; delay?: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number };

interface Space { id: number; name: string; ownership: string; profileId: string; profileName: string }
export interface Observation { url: string; title: string; snapshot: string }

// 只执行主机生成的固定脚本分支；Agent/外部传入的文本始终是 JSON 数据。
const SCRIPT = String.raw`
const emit = (value) => console.log("BROWSER_WORKFLOW_RESULT " + JSON.stringify(value));
try {
  if (input.operation === "spaces") { emit({ ok: true, value: await listTaskSpaces() }); }
  else if (input.operation === "profiles") { emit({ ok: true, value: await profiles() }); }
  else if (input.operation === "open") {
    const task = await taskSpace(input.name, { profileId: input.profileId });
    emit({ ok: true, value: { spaceId: task.spaceId, label: "p1" } });
  } else {
    const spaces = await listTaskSpaces();
    const current = spaces.find((s) => s.id === input.spaceId);
    if (!current && input.operation === "finish") { emit({ ok: true, value: null }); }
    else {
      if (!current || current.ownership !== "agent") throw { code: "EGO_CONTROL_UNAVAILABLE" };
      const task = await taskSpace(input.spaceId);
      const page = task.page(input.label);
      let value = null;
      if (input.operation === "finish") { await task.finish({ keep: [] }); }
      else if (input.operation === "observe") {
        value = { url: await page.url(), title: await page.title(), snapshot: await page.snapshot() };
      } else if (input.operation === "size") {
        value = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      } else if (input.operation === "screenshot") {
        value = await page.screenshot({ path: input.path, scale: "css" });
      } else if (input.operation === "action") {
        const a = input.action;
        if (a.type === "navigate") await page.goto(a.url);
        else if (a.type === "click") await page.click(a.selector);
        else if (a.type === "fill") await page.fill(a.selector, a.value);
        else if (a.type === "press") await page.press(a.selector, a.value);
        else if (a.type === "keyboard") await page.keyboard.press(a.value);
        else if (a.type === "text") await page.keyboard.insertText(a.value);
        else if (a.type === "type") await page.keyboard.type(a.value, a.delay === undefined ? {} : { delay: a.delay });
        else if (a.type === "scroll") {
          const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
          await page.mouse.move(a.startX ?? size.width / 2, a.startY ?? size.height / 2);
          const times = Math.max(1, Math.min(10, a.repeat || 1));
          for (let n = 0; n < times; n++) await page.mouse.wheel(a.x, a.y);
        }
        else if (a.type === "tap") await page.mouse.click(a.x, a.y);
        else if (a.type === "doubleClick") await page.mouse.click(a.x, a.y, { clickCount: 2 });
        else if (a.type === "rightClick") await page.mouse.click(a.x, a.y, { button: "right" });
        else if (a.type === "hover") await page.mouse.move(a.x, a.y);
        else if (a.type === "drag") {
          await page.mouse.move(a.x, a.y); await page.mouse.down();
          await page.mouse.move(a.toX, a.toY, { steps: 10 }); await page.mouse.up();
        } else throw { code: "EGO_UNSUPPORTED_ACTION" };
      } else throw { code: "EGO_UNSUPPORTED_OPERATION" };
      emit({ ok: true, value });
    }
  }
} catch (error) {
  emit({ ok: false, code: /^[A-Z_0-9]+$/.test(error.code || "") ? error.code : "EGO_OPERATION_FAILED" });
}`;

export async function egoCall<T>(input: Record<string, unknown>): Promise<T> {
  const script = `const input = ${JSON.stringify(input)};\n${SCRIPT}`;
  return new Promise<T>((ok, fail) => {
    const child = execFile("ego-browser", ["nodejs"], { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const line = `${stdout}\n${stderr}`.split("\n").find((line) => line.startsWith("BROWSER_WORKFLOW_RESULT "));
      if (!line) { fail(new ServiceError(503, "EGO_UNCONFIRMED", "Ego lite did not return a confirmed receipt")); return; }
      try {
        const receipt = JSON.parse(line.slice("BROWSER_WORKFLOW_RESULT ".length)) as { ok: boolean; code?: string; value: T };
        if (!receipt.ok) fail(new ServiceError(409, receipt.code ?? "EGO_OPERATION_FAILED", "Ego lite could not complete the browser operation"));
        else if (error) fail(new ServiceError(503, "EGO_UNCONFIRMED", "Ego lite receipt could not be confirmed"));
        else ok(receipt.value);
      } catch { fail(new ServiceError(503, "EGO_UNCONFIRMED", "Ego lite returned an invalid receipt")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
  });
}

export class EgoPage {
  readonly spaceId: number;
  readonly config: ServiceConfig;
  readonly account: Account;
  private closed = false;
  private closing = false;
  private finishAttempted = false;
  private actions = 0;
  private maxActions = 100;
  constructor(spaceId: number, config: ServiceConfig, account: Account) { this.spaceId = spaceId; this.config = config; this.account = account; }
  budget(max: number) { this.maxActions = max; }
  private async call<T>(operation: string, data: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || this.closing && operation !== "finish") throw new ServiceError(409, "SESSION_CLOSED", "Ego workflow page is closed");
    return egoCall<T>({ operation, spaceId: this.spaceId, label: "p1", ...data });
  }
  async observe(): Promise<Observation> {
    const result = await this.call<Observation>("observe");
    this.validate(result.url);
    return result;
  }
  validate(url: string): void {
    if (url === "about:blank") return;
    try { checkUrl(url, this.config.allowedOrigins, this.account.allowedOrigins); }
    catch { throw new ServiceError(400, "ORIGIN_NOT_ALLOWED", "Workflow navigation is outside the permitted origins"); }
  }
  async action(action: BrowserAction): Promise<void> {
    if (++this.actions > this.maxActions) throw new ServiceError(409, "ACTION_BUDGET", "Workflow action budget exhausted");
    if (action.type === "navigate") this.validate(action.url);
    await this.call("action", { action });
  }
  size(): Promise<{ width: number; height: number }> { return this.call("size"); }
  async screenshot(id: string): Promise<Artifact> {
    if (!/^[\w-]+$/u.test(id)) throw new Error("Invalid screenshot id");
    const dir = resolve(this.config.stateDir, "artifacts");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.call("screenshot", { path: resolve(dir, `${id}.png`) });
    return { id: `${id}.png`, contentType: "image/png" };
  }
  async frame(): Promise<string> {
    const artifact = await this.screenshot(`frame-${randomUUID()}`);
    const path = resolve(this.config.stateDir, "artifacts", artifact.id);
    try { return `data:image/png;base64,${(await readFile(path)).toString("base64")}`; }
    finally { await rm(path).catch(() => {}); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (!this.finishAttempted) {
      this.finishAttempted = true;
      await this.call("finish");
    }
    const spaces = await egoCall<Space[]>({ operation: "spaces" });
    if (spaces.some((s) => s.id === this.spaceId)) throw new ServiceError(503, "CLEANUP_FAILED", "Ego space remains open or under user control");
    this.closed = true;
  }
}

export class EgoDevice implements AbstractInterface {
  interfaceType = "ego-lite";
  readonly page: EgoPage;
  readonly inputPrimitives: InputPrimitives;
  readonly defineActions: typeof defineActionsFromInputPrimitives;
  constructor(page: EgoPage, defineActions: typeof defineActionsFromInputPrimitives) {
    this.page = page;
    this.defineActions = defineActions;
    const at = (type: "tap" | "doubleClick" | "rightClick" | "hover") => async (p: { x: number; y: number }) => page.action({ type, ...p });
    const point = (target: unknown): { x: number; y: number } | undefined => {
      if (target === undefined) return undefined;
      const center = target && typeof target === "object" ? (target as { center?: unknown }).center : undefined;
      if (!Array.isArray(center) || center.length !== 2 || !center.every((v) => typeof v === "number" && Number.isFinite(v))) throw new ServiceError(409, "EGO_LOCATOR_UNRESOLVED", "Midscene input target was not resolved to browser coordinates");
      return { x: center[0], y: center[1] };
    };
    const focus = async (target: unknown) => { const p = point(target); if (p) await page.action({ type: "tap", ...p }); };
    const clear = async () => { await page.action({ type: "keyboard", value: "ControlOrMeta+A" }); await page.action({ type: "keyboard", value: "Backspace" }); };
    this.inputPrimitives = {
      pointer: {
        tap: at("tap"), doubleClick: at("doubleClick"), rightClick: at("rightClick"), hover: at("hover"),
        dragAndDrop: async (from, to) => page.action({ type: "drag", ...from, toX: to.x, toY: to.y })
      },
      keyboard: {
        keyboardPress: async (value, options) => { await focus(options?.target); await page.action({ type: "keyboard", value }); },
        clearInput: async (target) => { await focus(target); await clear(); },
        typeText: async (value, options) => {
          await focus(options?.target);
          if (options?.focusOnly) return;
          if (options?.replace) await clear();
          if (options?.inputStrategy === "bulk") await page.action({ type: "text", value });
          else await page.action({ type: "type", value, ...(options?.keyboardTypeDelay !== undefined ? { delay: options.keyboardTypeDelay } : {}) });
        }
      },
      scroll: { scroll: async (param) => {
        const edge = param.scrollType && param.scrollType !== "singleAction";
        const directions = { scrollToTop: "up", scrollToBottom: "down", scrollToLeft: "left", scrollToRight: "right" } as const;
        const direction = edge ? directions[param.scrollType as keyof typeof directions] : param.direction;
        const amount = edge ? 1000 : param.distance ?? 500;
        const start = point(param.locate);
        await page.action({ type: "scroll", x: direction === "left" ? -amount : direction === "right" ? amount : 0, y: direction === "up" ? -amount : direction === "down" ? amount : 0,
          ...(start ? { startX: start.x, startY: start.y } : {}), ...(edge ? { repeat: 10 } : {}) });
      } }
    };
  }
  actionSpace() { return this.defineActions(this.inputPrimitives, { size: () => this.size() }); }
  screenshotBase64() { return this.page.frame(); }
  size() { return this.page.size(); }
  url = async () => (await this.page.observe()).url;
  describe() { return "A browser page in the existing QA account's ego lite profile"; }
}

export class EgoBrowserProvider implements BrowserProvider {
  readonly config: ServiceConfig;
  private pages = new Map<string, EgoPage>();
  constructor(config: ServiceConfig) { this.config = config; }
  page(id: string): EgoPage {
    const page = this.pages.get(id);
    if (!page) throw new ServiceError(404, "NOT_FOUND", "Workflow browser not found");
    return page;
  }
  async open(id: string, account?: Account, url?: string): Promise<BrowserHandle> {
    if (!account?.ego) throw new ServiceError(409, "EGO_ACCOUNT_REQUIRED", "Choose an existing account with an ego lite profile");
    if (url ?? account.url) {
      try { checkUrl((url ?? account.url)!, this.config.allowedOrigins, account.allowedOrigins); }
      catch { throw new ServiceError(400, "ORIGIN_NOT_ALLOWED", "Target is outside the account's permitted origins"); }
    }
    const spaces = await egoCall<Space[]>({ operation: "spaces" });
    const anchor = spaces.find((s) => s.name === account.ego!.space && s.profileName === account.ego!.profile);
    let profileId = anchor?.profileId;
    if (!profileId) {
      const profiles = await egoCall<{ id: string; name: string }[]>({ operation: "profiles" });
      profileId = profiles.find((p) => p.name === account.ego!.profile || p.id === account.ego!.profile)?.id;
    }
    if (!profileId) throw new ServiceError(409, "EGO_PROFILE_MISSING", "Account's ego lite profile is missing; configure it on the host");
    if (spaces.some((s) => s.profileId === profileId && s.ownership !== "user")) throw new ServiceError(409, "EGO_PROFILE_BUSY", "Account profile is controlled by another task or a human handoff");
    const name = `qa-workflow-${id}`;
    let page: EgoPage | undefined;
    try {
      const opened = await egoCall<{ spaceId: number }>({ operation: "open", name, profileId });
      page = new EgoPage(opened.spaceId, this.config, account);
      this.pages.set(id, page);
      const target = url ?? account.url;
      if (target) await page.action({ type: "navigate", url: target });
      return {
        execute: async (step: Step): Promise<StepResult> => {
          if (step.type === "snapshot") return { type: step.type, pass: true, data: await page!.observe() };
          throw new ServiceError(400, "WORKFLOW_ONLY", "Ego browser actions are managed by a goal workflow");
        },
        close: async () => { await page!.close(); this.pages.delete(id); }
      };
    } catch (error) {
      try {
        if (!page) {
          const created = (await egoCall<Space[]>({ operation: "spaces" })).find((s) => s.name === name);
          if (created) page = new EgoPage(created.id, this.config, account);
        }
        if (page) await page.close();
        this.pages.delete(id);
      } catch { throw new ServiceError(503, "CLEANUP_FAILED", "Ego startup cleanup could not be confirmed; account remains reserved"); }
      throw error;
    }
  }
}
