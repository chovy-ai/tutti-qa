import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { regressRoot } from "../core/config.ts";
import { integer, strings, text, type Client } from "./protocol.ts";

export interface ServiceConfig {
  host: string;
  port: number;
  stateDir: string;
  accountsFile: string;
  legacySecretsDir: string;
  leaseDir: string;
  allowedOrigins: string[];
  allowAnonymous: boolean;
  headless: boolean;
  maxSessions: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  maxRecords: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  maxJobSeconds: number;
  aiContext: string;
  clients: Client[];
  tokenFile?: string;
}

export async function loadConfig(file?: string, envFile?: string): Promise<ServiceConfig> {
  if (envFile) {
    const env = parseEnv(await readFile(resolve(envFile), "utf8"));
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  }
  const raw = file ? JSON.parse(await readFile(resolve(file), "utf8")) as Record<string, unknown> : {};
  const root = file ? dirname(resolve(file)) : regressRoot;
  const path = (key: string, fallback: string) => raw[key] === undefined ? fallback : resolve(root, text(raw[key], key));
  const config: ServiceConfig = {
    host: raw.host === undefined ? "127.0.0.1" : text(raw.host, "host", 255),
    port: integer(raw.port, 4318, 65535, "port"),
    stateDir: path("stateDir", resolve(regressRoot, ".service")),
    accountsFile: path("accountsFile", resolve(homedir(), ".tutti-qa/accounts.json")),
    legacySecretsDir: path("legacySecretsDir", resolve(homedir(), ".tutti-qa/secrets")),
    leaseDir: path("leaseDir", resolve(dirname(path("accountsFile", resolve(homedir(), ".tutti-qa/accounts.json"))), ".browser-leases")),
    allowedOrigins: raw.allowedOrigins === undefined ? ["*"] : strings(raw.allowedOrigins),
    allowAnonymous: raw.allowAnonymous === undefined ? true : raw.allowAnonymous === true,
    headless: raw.headless === undefined ? true : raw.headless === true,
    maxSessions: integer(raw.maxSessions, 6, 100, "maxSessions"),
    maxConcurrentJobs: integer(raw.maxConcurrentJobs, 2, 100, "maxConcurrentJobs"),
    maxQueuedJobs: integer(raw.maxQueuedJobs, 100, 10_000, "maxQueuedJobs"),
    maxRecords: integer(raw.maxRecords, 10_000, 100_000, "maxRecords"),
    defaultTtlSeconds: integer(raw.defaultTtlSeconds, 900, 86400, "defaultTtlSeconds"),
    maxTtlSeconds: integer(raw.maxTtlSeconds, 3600, 86400, "maxTtlSeconds"),
    maxJobSeconds: integer(raw.maxJobSeconds, 600, 3600, "maxJobSeconds"),
    aiContext: raw.aiContext === undefined ? "You are testing a web application. Follow the requested steps and report only observed results." : text(raw.aiContext, "aiContext"),
    clients: []
  };
  if (config.defaultTtlSeconds > config.maxTtlSeconds) throw new Error("defaultTtlSeconds exceeds maxTtlSeconds");
  if (!config.headless && config.maxConcurrentJobs > 1) throw new Error("Headed mode requires maxConcurrentJobs: 1 to avoid shared clipboard interference");
  for (const key of ["headless", "allowAnonymous"] as const) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`Invalid ${key}`);
  for (const origin of config.allowedOrigins) {
    if (origin !== "*" && new URL(origin).origin !== origin) throw new Error("allowedOrigins must contain exact origins or *");
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  if (raw.clients !== undefined) {
    if (!Array.isArray(raw.clients) || !raw.clients.length) throw new Error("clients must be nonempty");
    config.clients = raw.clients.map((entry: Record<string, unknown>): Client => {
      const id = text(entry.id, "client id", 255);
      const token = process.env[text(entry.tokenEnv, "tokenEnv", 255)];
      if (!token || token.length < 32) throw new Error("Each client token environment variable must contain at least 32 characters");
      return { id, token, accountIds: entry.accountIds === undefined ? undefined : strings(entry.accountIds) };
    });
  } else {
    config.tokenFile = resolve(config.stateDir, "access.json");
    try {
      await writeFile(config.tokenFile, JSON.stringify({ token: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await chmod(config.tokenFile, 0o600);
    const { token } = JSON.parse(await readFile(config.tokenFile, "utf8")) as { token: string };
    if (typeof token !== "string" || token.length < 32) throw new Error("Invalid local access token file");
    config.clients = [{ id: "local", token }];
  }
  if (new Set(config.clients.map((c) => c.id)).size !== config.clients.length || new Set(config.clients.map((c) => c.token)).size !== config.clients.length) throw new Error("Client ids and tokens must be unique");
  return config;
}

export function checkUrl(value: string, allowed: readonly string[], accountAllowed?: readonly string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
  const matches = (origins: readonly string[]) => origins.includes("*") || origins.includes(url.origin);
  if (!matches(allowed) || (accountAllowed && !matches(accountAllowed))) throw new Error("Origin is not allowed");
  return url.href;
}
