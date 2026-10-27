#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadAccounts } from "./accounts.ts";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http.ts";
import { PlaywrightProvider } from "./provider.ts";
import { BrowserService } from "./service.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, "env-file": { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("Usage: pnpm service [--config service.json] [--env-file /absolute/path/model.env]\nSee SERVICE.md for the API and configuration.");
} else {
  const config = await loadConfig(values.config, values["env-file"]);
  const lock = resolve(config.stateDir, "server.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Service lock exists. Stop the running service, or verify orphaned browsers are closed before removing server.lock. See SERVICE.md.");
    throw error;
  }
  let running = false;
  try {
    await writeFile(resolve(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    const accounts = await loadAccounts(config.accountsFile, config.legacySecretsDir);
    const service = new BrowserService(config, accounts, new PlaywrightProvider(config));
    const server = createHttpServer(service, config);
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(config.port, config.host, () => { server.off("error", fail); ok(); });
    });
    running = true;
    console.log(JSON.stringify({ status: "listening", host: config.host, port: config.port, accounts: accounts.length, tokenFile: config.tokenFile, stateDir: config.stateDir }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      // 先拒绝新连接，再取消作业和关闭浏览器；只有确认清理成功才删除锁。
      server.close();
      const clean = await service.shutdown();
      server.closeAllConnections();
      if (clean) await rm(lock, { recursive: true });
      else { console.error("Browser cleanup is uncertain; server.lock was retained for host inspection"); process.exitCode = 1; }
    };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
  } finally {
    if (!running) await rm(lock, { recursive: true, force: true });
  }
}
