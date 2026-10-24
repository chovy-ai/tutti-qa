import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const regressRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface EnvProfile {
  readonly id: string;
  /** Web 入口，登录后应落在这里 */
  readonly webUrl: string;
  /** account 服务经网关暴露的地址，用于登录码换 session */
  readonly accountApiOrigin: string;
  readonly accountAppId: string;
  /** session_id Cookie 的 Domain，与 account DomainPolicy 的 rootDomain 一致 */
  readonly sessionCookieDomain: string;
  /** tutti-ops 使用的 admin 地址；token 由 tutti-ops 自身配置或 TUTTI_OPS_TOKEN 提供 */
  readonly adminUrl: string;
  readonly locale: string;
  readonly timezoneId: string;
  /** 环境提供的能力，Plan 的 requires 必须是它的子集，否则用例 skipped */
  readonly capabilities: readonly string[];
  /** 登录码有效期（分钟），Run 结束后无论成败都会删除 */
  readonly loginCodeTtlMinutes: number;
}

export interface Suite {
  readonly id: string;
  readonly title: string;
  /** 相对 tutti-qa 根目录 */
  readonly pos: string;
  readonly roots: readonly string[];
  readonly priorities: readonly string[];
}

export async function loadEnv(id: string): Promise<EnvProfile> {
  return readJSON<EnvProfile>(resolve(regressRoot, "envs", `${id}.json`));
}

export async function loadSuite(id: string): Promise<Suite> {
  return readJSON<Suite>(resolve(suiteDir(id), "suite.json"));
}

export function suitePosPath(suite: Suite): string {
  return resolve(regressRoot, "..", suite.pos);
}

/** 一个 suite 的全部内容在同一目录下：suite.json、plans/、cache/ */
export function suiteDir(id: string): string {
  if (!/^[\w.-]+$/u.test(id)) throw new Error(`suite id 只能包含字母、数字、. _ -：${id}`);
  return resolve(regressRoot, "suites", id);
}

export function suitePlansDir(suite: Suite): string {
  return resolve(suiteDir(suite.id), "plans");
}

export const requiredModelEnv = [
  "MIDSCENE_MODEL_NAME",
  "MIDSCENE_MODEL_BASE_URL",
  "MIDSCENE_MODEL_API_KEY",
  "MIDSCENE_MODEL_FAMILY"
] as const;

export function missingModelEnv(): string[] {
  // codex://app-server 由本机 Codex CLI 提供模型调用，不需要 API key
  const localProvider = process.env.MIDSCENE_MODEL_BASE_URL?.startsWith("codex://") ?? false;
  return requiredModelEnv.filter((key) => !process.env[key] && !(localProvider && key === "MIDSCENE_MODEL_API_KEY"));
}

async function readJSON<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
