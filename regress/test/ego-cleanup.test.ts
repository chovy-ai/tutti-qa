import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Account } from "../src/service/accounts.ts";
import type { ServiceConfig } from "../src/service/config.ts";
import { EgoPage } from "../src/service/ego.ts";

test("人工接管期间不关闭，归还后只调用一次 finish，空间消失才确认回收", async (t) => {
  // Run the actual Ego adapter script against a local simulator, never a real profile.
  const dir = await mkdtemp(join(tmpdir(), "qa-ego-close-"));
  const state = join(dir, "ownership");
  const calls = join(dir, "finish-calls");
  await writeFile(calls, "");
  await writeFile(state, "agentDelegatedToUser");
  await writeFile(join(dir, "runtime.mjs"), `
    import { readFile, appendFile } from "node:fs/promises";
    globalThis.listTaskSpaces = async () => {
      const ownership = await readFile(${JSON.stringify(state)}, "utf8");
      return ownership ? [{ id: 7, name: "qa-workflow-fixture", ownership }] : [];
    };
    globalThis.taskSpace = async () => ({
      page: () => ({}),
      finish: () => appendFile(${JSON.stringify(calls)}, "finish\\n")
    });
  `);
  await writeFile(join(dir, "ego-browser"),
    '#!/bin/sh\nexec "' + process.execPath + '" --import "' + join(dir, "runtime.mjs") + '" --input-type=module\n', { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = dir + ":" + oldPath;
  t.after(async () => { process.env.PATH = oldPath; await rm(dir, { recursive: true, force: true }); });

  const page = new EgoPage(7, {} as ServiceConfig, {} as Account, "qa-workflow-fixture");
  await assert.rejects(page.close());
  assert.equal(await readFile(calls, "utf8"), "");
  await writeFile(state, "agent");
  await assert.rejects(page.close());
  assert.equal(await readFile(calls, "utf8"), "finish\n");
  await assert.rejects(page.close());
  await writeFile(state, "");
  await page.close();
  assert.equal(await readFile(calls, "utf8"), "finish\n");
});
