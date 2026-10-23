// 资源台账：Run 中创建的每个线上资源都先记账再使用，清理阶段与 `cleanup --run` 都以它为准。
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export type LedgerEntry =
  | { kind: "login-code"; id: string; userId: string; caseId: string }
  | { kind: "room"; name: string; owner: string; ownerUserId: string; caseId: string };

export interface Ledger {
  readonly file: string;
  add(entry: LedgerEntry): Promise<void>;
}

export function openLedger(runDir: string): Ledger {
  const file = join(runDir, "ledger.jsonl");
  return {
    file,
    async add(entry) {
      await appendFile(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, "utf8");
    }
  };
}

export async function readLedger(file: string): Promise<LedgerEntry[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}
