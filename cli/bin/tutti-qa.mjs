#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BrowserClient, ClientError, readToken } from "../src/client.mjs";
import { executeCommand, HELP, OPTIONS, number } from "../src/commands.mjs";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  let args;
  try { args = parseArgs({ options: OPTIONS, allowPositionals: true }); }
  catch { throw new ClientError("INVALID_ARGUMENT", "Invalid command arguments; run tutti-qa --help"); }
  if (args.values.help || args.positionals.length === 0 && !args.values.version) {
    console.log(HELP);
  } else if (args.values.version) {
    console.log("0.1.0");
  } else {
    const client = new BrowserClient({
      server: args.values.server ?? process.env.BROWSER_TEST_SERVER,
      token: await readToken(args.values["token-file"], process.env.BROWSER_TEST_TOKEN),
      timeoutMs: number(args.values["http-timeout-seconds"], 30, "--http-timeout-seconds", 3600) * 1000
    });
    const result = await executeCommand(client, args.positionals, args.values, { signal: controller.signal });
    console.log(JSON.stringify(result.output));
    process.exitCode = controller.signal.aborted ? 130 : result.exitCode;
  }
} catch (error) {
  const failure = error instanceof ClientError ? error : new ClientError("CLIENT_ERROR", "Command failed; check input and local output permissions");
  console.error(JSON.stringify({ error: { code: failure.code, message: failure.message }, ...failure.details }));
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
