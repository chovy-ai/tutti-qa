import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sessionCookies } from "../identity/identity.ts";
import { loadEnv } from "../core/config.ts";
import type { BrowserContext } from "playwright";
import { ServiceError, strings, text } from "./protocol.ts";

type StorageState = Exclude<Parameters<BrowserContext["setStorageState"]>[0], string>;

export interface Account {
  id: string;
  resourceKey: string;
  env?: string;
  roles: string[];
  capabilities: string[];
  tags: string[];
  url?: string;
  allowedOrigins?: string[];
  ego?: { profile: string; space?: string };
  // 故意不保留原始账号对象，避免 loginCode/note 等字段流入接口。
  loadState(): Promise<StorageState>;
}

/** 标准账号采用 storageStateFile；旧的 name/env/profile 只在这个兼容适配器里解释。 */
export async function loadAccounts(file: string, legacySecretsDir: string): Promise<Account[]> {
  let data: { accounts?: unknown };
  try { data = JSON.parse(await readFile(file, "utf8")) as typeof data; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Account catalog could not be read");
  }
  if (!Array.isArray(data.accounts)) throw new Error("Account catalog requires an accounts array");
  const ids = new Set<string>();
  return Promise.all(data.accounts.map(async (raw: unknown): Promise<Account> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid account");
    const item = raw as Record<string, unknown>;
    const id = text(item.id ?? item.name, "account id", 255);
    if (ids.has(id)) throw new Error("Duplicate account id");
    ids.add(id);
    const legacy = item.storageStateFile === undefined;
    const envId = item.env === undefined ? undefined : text(item.env, "env", 255);
    let env;
    if (legacy) {
      // 兼容目录中的文件名与环境 id 必须是单段，不能从目录穿越读取文件。
      if (!/^[\w.-]+$/u.test(id) || !envId || !/^[\w-]+$/u.test(envId)) throw new Error("Legacy account requires safe name and env");
      env = await loadEnv(envId);
    }
    const url = item.url === undefined ? env?.webUrl : text(item.url, "url");
    const stateFile = legacy ? resolve(legacySecretsDir, `${id}.session`) : resolve(dirname(file), text(item.storageStateFile, "storageStateFile"));
    return {
      id,
      resourceKey: text(item.resourceKey ?? item.profile ?? id, "resourceKey", 255),
      env: envId,
      roles: item.roles === undefined ? [] : strings(item.roles),
      capabilities: item.capabilities === undefined ? [] : strings(item.capabilities),
      tags: item.tags === undefined ? [] : strings(item.tags),
      url,
      ...(item.profile ? { ego: { profile: text(item.profile, "profile", 255), ...(item.space ? { space: text(item.space, "space", 255) } : {}) } } : {}),
      allowedOrigins: item.allowedOrigins === undefined ? (url ? [new URL(url).origin] : undefined) : strings(item.allowedOrigins),
      async loadState() {
        try {
          if (!legacy) {
            const state = JSON.parse(await readFile(stateFile, "utf8")) as StorageState;
            if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error("Invalid storage state");
            return state;
          }
          const sid = (await readFile(stateFile, "utf8")).trim();
          if (!sid) throw new Error("Empty credential");
          // addCookies 接受 url/可选字段，storageState 则要求完整的序列化 Cookie。
          // host-only Cookie 使用无前导点的 hostname，保留 __Host- 语义。
          const cookies = sessionCookies(env!, sid).map((cookie) => ({
            name: cookie.name, value: cookie.value,
            domain: cookie.domain ?? new URL(cookie.url!).hostname,
            path: cookie.path ?? "/", expires: cookie.expires ?? -1,
            httpOnly: cookie.httpOnly ?? false, secure: cookie.secure ?? false,
            sameSite: cookie.sameSite ?? "Lax"
          }));
          return { cookies, origins: [] };
        } catch {
          throw new ServiceError(503, "ACCOUNT_AUTH_UNAVAILABLE", "Account credentials are unavailable; update them on the host");
        }
      }
    };
  }));
}
