// 测试身份批次：一键申请 N 个新用户（登录码 → session → Cookie），存成本地批次文件供浏览器会话使用。
// 批次文件含 session 凭据，只写在 regress/.identities/（已 gitignore，权限 0600）。
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { request } from "playwright";
import { type EnvProfile, loadEnv, regressRoot } from "./config.ts";
import { createLoginCode, deleteLoginCode, type SessionCookie, sessionCookies, verifyLoginCode } from "./identity.ts";
import { openLedger, readLedger } from "./ledger.ts";

export interface Identity {
  readonly name: string;
  readonly displayName: string;
  readonly userId: string;
  readonly loginCodeId: string;
  readonly cookies: readonly SessionCookie[];
}

export interface IdentityBatch {
  readonly batch: string;
  readonly env: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly identities: readonly Identity[];
}

export const identitiesRoot = resolve(regressRoot, ".identities");

function batchDir(batch: string): string {
  if (!/^[\w.-]+$/u.test(batch)) throw new Error(`批次名只能包含字母、数字、. _ -：${batch}`);
  return join(identitiesRoot, batch);
}

/** 并发申请；任一失败时已申请成功的登录码仍记在台账里，可用 release 回收。 */
export async function issueIdentities(envId: string, names: readonly string[], batch = defaultBatch()): Promise<IdentityBatch> {
  if (names.length === 0) throw new Error("至少申请一个身份");
  if (new Set(names).size !== names.length) throw new Error(`身份名重复：${names.join(",")}`);
  const env = await loadEnv(envId);
  const dir = batchDir(batch);
  await mkdir(dir, { recursive: true });
  // 先记下环境，申请中途失败时 release 仍能按台账回收
  await writeFile(join(dir, "batch.json"), `${JSON.stringify({ batch, env: env.id })}\n`, "utf8");
  const ledger = openLedger(dir);
  const api = await request.newContext();
  try {
    const identities = await Promise.all(
      names.map(async (name): Promise<Identity> => {
        // display_name 会成为新用户昵称，带上批次便于在后台识别
        const displayName = `QA ${name} ${batch.slice(-6)}`;
        const code = await createLoginCode(env, displayName);
        await ledger.add({ kind: "login-code", id: code.id, userId: code.userId, caseId: `identity:${batch}` });
        const session = await verifyLoginCode(env, api, code.code);
        return { name, displayName, userId: code.userId, loginCodeId: code.id, cookies: sessionCookies(env, session.sessionId) };
      })
    );
    const createdAt = new Date();
    const result: IdentityBatch = {
      batch,
      env: env.id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + env.loginCodeTtlMinutes * 60_000).toISOString(),
      identities
    };
    const file = join(dir, "identities.json");
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return result;
  } finally {
    await api.dispose();
  }
}

export async function loadIdentityBatch(batch: string): Promise<IdentityBatch> {
  return JSON.parse(await readFile(join(batchDir(batch), "identities.json"), "utf8")) as IdentityBatch;
}

/** `<batch>:<name>` → 身份；批次里只有一个身份时可以省略 name。 */
export async function resolveIdentity(ref: string): Promise<{ batch: IdentityBatch; identity: Identity }> {
  const [batchName, name] = ref.split(":");
  const batch = await loadIdentityBatch(batchName!);
  const identity = name
    ? batch.identities.find((item) => item.name === name)
    : batch.identities.length === 1
      ? batch.identities[0]
      : undefined;
  if (!identity) {
    throw new Error(`批次 ${batch.batch} 中找不到身份 ${name ?? "（批次有多个身份，需写成 batch:name）"}`);
  }
  return { batch, identity };
}

/** 按台账回收本批次的全部登录码（含申请中途失败时已发出的）。新建的用户本身无法删除，会留在线上。 */
export async function releaseIdentities(batch: string): Promise<{ deleted: number; errors: string[] }> {
  const dir = batchDir(batch);
  const meta = JSON.parse(await readFile(join(dir, "batch.json"), "utf8")) as { env: string };
  const env: EnvProfile = await loadEnv(meta.env);
  const errors: string[] = [];
  let deleted = 0;
  for (const entry of await readLedger(openLedger(dir).file)) {
    if (entry.kind !== "login-code") continue;
    try {
      await deleteLoginCode(env, entry.id);
      deleted += 1;
    } catch (error) {
      // 已删除的登录码再次删除会失败，这里只记录不中断
      errors.push(`登录码 ${entry.id}：${(error as Error).message}`);
    }
  }
  return { deleted, errors };
}

/** 形如 20261024T112233，与 runId 的时间部分一致 */
function defaultBatch(): string {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+/u, "");
}
