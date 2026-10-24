// 测试身份：通过 tutti-ops 申请登录码（每个码对应一个新用户），换取 session 注入浏览器。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext, BrowserContext } from "playwright";
import type { EnvProfile } from "./config.ts";

const run = promisify(execFile);

export interface LoginCode {
  readonly id: string;
  readonly userId: string;
  readonly code: string;
  readonly displayName: string;
}

export type SessionCookie = Parameters<BrowserContext["addCookies"]>[0][number];

export interface Session {
  readonly sessionId: string;
  readonly isNewUser: boolean;
}

interface OpsResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

async function ops<T>(env: EnvProfile, args: string[]): Promise<T> {
  const { stdout } = await run("tutti-ops", [...args, "--admin-url", env.adminUrl, "--json"], {
    env: { ...process.env, TUTTI_OPS_MODE: "write" },
    maxBuffer: 4 * 1024 * 1024
  }).catch((error: { stdout?: string; message: string }) => ({ stdout: error.stdout ?? "", error }));
  let parsed: OpsResult<T>;
  try {
    parsed = JSON.parse(stdout) as OpsResult<T>;
  } catch {
    throw new Error(`tutti-ops ${args.slice(0, 3).join(" ")} 输出无法解析`);
  }
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(`tutti-ops ${args.slice(0, 3).join(" ")} 失败：${parsed.error?.code} ${parsed.error?.message}`);
  }
  return parsed.data;
}

export async function opsWhoami(env: EnvProfile): Promise<void> {
  await ops(env, ["auth", "status"]);
}

/** 不传 userId 时 account 会新建一个用户；传 userId 时为已有测试用户补发登录码（用于事后清理）。 */
export async function createLoginCode(env: EnvProfile, displayName: string, userId?: string): Promise<LoginCode> {
  const expiresAt = new Date(Date.now() + env.loginCodeTtlMinutes * 60_000).toISOString();
  const data = await ops<Record<string, unknown>>(env, [
    "access", "login-codes", "create",
    "--scope-app-id", env.accountAppId,
    "--display-name", displayName,
    "--expires-at", expiresAt,
    "--created-by", "tutti-regress",
    ...(userId ? ["--user-id", userId] : []),
    "--show-secrets", "--yes"
  ]);
  const record = findRecord(data);
  if (!record) throw new Error("tutti-ops 未返回登录码明文");
  return {
    id: String(record.id),
    userId: String(record.user_id ?? ""),
    code: String(record.plain_code),
    displayName
  };
}

export async function deleteLoginCode(env: EnvProfile, id: string): Promise<void> {
  await ops(env, ["access", "login-codes", "delete", "--id", id, "--deleted-by", "tutti-regress", "--yes"]);
}

/** 与 account /auth/v1/verify_login_code_for_session 一致：用登录码换 sessionId。 */
export async function verifyLoginCode(env: EnvProfile, request: APIRequestContext, code: string): Promise<Session> {
  const response = await request.post(`${env.accountApiOrigin}/auth/v1/verify_login_code_for_session`, {
    data: { code, appId: env.accountAppId }
  });
  const body = (await response.json().catch(() => null)) as
    | { code?: number; errmsg?: string; data?: { sessionId?: string; isNewUser?: boolean } }
    | null;
  const sessionId = body?.data?.sessionId;
  if (!response.ok() || body?.code !== 0 || !sessionId) {
    throw new Error(`登录码换 session 失败：HTTP ${response.status()} ${body?.code ?? ""} ${body?.errmsg ?? ""}`);
  }
  return { sessionId, isNewUser: Boolean(body.data?.isNewUser) };
}

/** account 签发的 Cookie 形态：session_id 落在根域，另有一枚 __Host- 迁移标记证明浏览器收到过新 Cookie。 */
export function sessionCookies(env: EnvProfile, sessionId: string): SessionCookie[] {
  return [
    {
      name: "session_id",
      value: sessionId,
      domain: env.sessionCookieDomain,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    },
    {
      name: "__Host-session-cookie-migrated",
      value: `v1.${createHash("sha256").update(sessionId).digest("hex")}`,
      // __Host- 前缀要求 host-only，用 url 形式让浏览器不写 Domain 属性
      url: new URL("/", env.webUrl).toString(),
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    }
  ];
}

export async function exchangeSession(env: EnvProfile, context: BrowserContext, code: string): Promise<Session> {
  const session = await verifyLoginCode(env, context.request, code);
  await context.addCookies(sessionCookies(env, session.sessionId));
  return session;
}

function findRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.plain_code === "string" && record.plain_code !== "[REDACTED]") return record;
  for (const nested of Object.values(record)) {
    const found = findRecord(nested);
    if (found) return found;
  }
  return null;
}
