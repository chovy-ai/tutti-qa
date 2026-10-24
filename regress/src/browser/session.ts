// 浏览器会话：每个会话是一个独立的 Chromium 进程（独立 profile、剪贴板与崩溃域），用指定测试身份登录后
// 常驻后台并暴露 CDP 地址。CLI 的单步命令、外部 Agent 或 Playwright 都通过 CDP 接入同一个页面。
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { loadEnv, regressRoot } from "../core/config.ts";
import { resolveIdentity } from "../identity/identities.ts";

export interface SessionRecord {
  readonly id: string;
  /** `<batch>:<name>` */
  readonly identity: string;
  readonly displayName: string;
  readonly env: string;
  readonly pid: number;
  readonly cdpUrl: string;
  readonly headed: boolean;
  readonly startedAt: string;
}

export interface SessionStatus extends SessionRecord {
  readonly alive: boolean;
}

export const sessionsRoot = resolve(regressRoot, ".sessions");

const VIEWPORT = { width: 1440, height: 900 };

function sessionDir(id: string): string {
  if (!/^[\w.-]+$/u.test(id)) throw new Error(`会话 id 只能包含字母、数字、. _ -：${id}`);
  return join(sessionsRoot, id);
}

export function sessionMidsceneDir(id: string): string {
  return join(sessionDir(id), "midscene");
}

export interface StartOptions {
  readonly identity: string;
  /** 默认取身份名加时间戳 */
  readonly id?: string;
  readonly headed?: boolean;
}

/** 启动一个独立浏览器进程并登录；返回后进程在后台常驻，直到 stopSession。 */
export async function startSession(options: StartOptions): Promise<SessionRecord> {
  const { batch, identity } = await resolveIdentity(options.identity);
  const env = await loadEnv(batch.env);
  const id = options.id ?? `${identity.name}-${Date.now().toString(36)}`;
  const dir = sessionDir(id);
  if (await readRecord(id).catch(() => null)) throw new Error(`会话 ${id} 已存在`);
  await mkdir(dir, { recursive: true });
  const port = await freePort();
  const headed = options.headed === true;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const bypass = process.env.NO_PROXY ?? process.env.no_proxy;
  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(dir, "profile")}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--lang=${env.locale}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      ...(headed ? [] : ["--headless=new"]),
      ...(proxy ? [`--proxy-server=${proxy}`, ...(bypass ? [`--proxy-bypass-list=${bypass.replaceAll(",", ";")}`] : [])] : []),
      "about:blank"
    ],
    // 独立进程组：CLI 退出后浏览器继续运行，stop 时按进程组结束
    { detached: true, stdio: "ignore", env: { ...process.env, TZ: env.timezoneId, LANG: env.locale.replace("-", "_") } }
  );
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("浏览器进程启动失败");
  const record: SessionRecord = {
    id,
    identity: `${batch.batch}:${identity.name}`,
    displayName: identity.displayName,
    env: env.id,
    pid,
    cdpUrl: `http://127.0.0.1:${port}`,
    headed,
    startedAt: new Date().toISOString()
  };
  await writeFile(join(dir, "session.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    await waitForCdp(record.cdpUrl, 20_000);
    const connected = await connectSession(id);
    try {
      await connected.context.addCookies([...identity.cookies]);
      await connected.page.goto(env.webUrl, { waitUntil: "load" });
      if (/\/auth\/login/u.test(connected.page.url())) throw new Error("session 未生效，被重定向到登录页");
    } finally {
      await connected.disconnect();
    }
  } catch (error) {
    await stopSession(id).catch(() => undefined);
    throw error;
  }
  return record;
}

/** 并发启动多个会话，返回顺序与输入一致；单个失败不影响其他会话。 */
export async function startSessions(
  list: readonly StartOptions[],
  concurrency = list.length
): Promise<({ ok: true; session: SessionRecord } | { ok: false; identity: string; error: string })[]> {
  const results: Awaited<ReturnType<typeof startSessions>> = new Array(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < list.length; index = next++) {
      const options = list[index]!;
      results[index] = await startSession(options).then(
        (session) => ({ ok: true as const, session }),
        (error: Error) => ({ ok: false as const, identity: options.identity, error: error.message })
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return results;
}

export interface ConnectedSession {
  readonly record: SessionRecord;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /** 只断开 CDP 连接，浏览器进程继续运行 */
  disconnect(): Promise<void>;
}

export async function connectSession(id: string): Promise<ConnectedSession> {
  const record = await readRecord(id);
  if (!isAlive(record.pid)) throw new Error(`会话 ${id} 的浏览器进程已退出`);
  const env = await loadEnv(record.env);
  const browser = await chromium.connectOverCDP(record.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // 权限绑定在本次 CDP 连接上，每次接入都重新授予
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(env.webUrl).origin });
  const pages = context.pages();
  const page = pages.find((item) => item.url() !== "about:blank") ?? pages[0] ?? (await context.newPage());
  return {
    record,
    browser,
    context,
    page,
    async disconnect() {
      // connectOverCDP 得到的 Browser 上 close() 只断开连接，不结束进程
      await browser.close().catch(() => undefined);
    }
  };
}

export async function listSessions(): Promise<SessionStatus[]> {
  const ids = await readdir(sessionsRoot).catch(() => [] as string[]);
  const records = await Promise.all(ids.map((id) => readRecord(id).catch(() => null)));
  return records.flatMap((record) => (record ? [{ ...record, alive: isAlive(record.pid) }] : []));
}

/** 结束浏览器进程并删除 profile；session.json 与 Midscene 报告保留，便于事后查看。 */
export async function stopSession(id: string): Promise<void> {
  const record = await readRecord(id);
  if (isAlive(record.pid)) {
    try {
      process.kill(-record.pid, "SIGTERM");
    } catch {
      process.kill(record.pid, "SIGTERM");
    }
    for (let waited = 0; waited < 5_000 && isAlive(record.pid); waited += 100) await sleep(100);
    if (isAlive(record.pid)) process.kill(-record.pid, "SIGKILL");
  }
  await rm(join(sessionDir(id), "profile"), { recursive: true, force: true });
}

async function readRecord(id: string): Promise<SessionRecord> {
  return JSON.parse(await readFile(join(sessionDir(id), "session.json"), "utf8")) as SessionRecord;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("无法分配端口"))));
    });
  });
}

async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await fetch(`${cdpUrl}/json/version`).then((response) => response.ok, () => false);
    if (ready) return;
    await sleep(200);
  }
  throw new Error(`浏览器 ${timeoutMs / 1000}s 内未就绪：${cdpUrl}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
