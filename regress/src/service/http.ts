import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { missingModelEnv } from "../core/config.ts";
import type { ServiceConfig } from "./config.ts";
import { OPENAPI } from "./openapi.ts";
import { readArtifact } from "./provider.ts";
import { BrowserService } from "./service.ts";
import { ServiceError, integer, object, parseJob, parseSession, stepKeys, type Client } from "./protocol.ts";
import { parseGoal } from "./workflow-protocol.ts";
import type { GoalWorkflows } from "./workflows.ts";

interface Reply { status: number; data: unknown }

/** 一次进程生命周期内，缓存包括正在执行的请求，防止并发重试重复创建资源。 */
export function createHttpServer(service: BrowserService, config: ServiceConfig, workflows?: GoalWorkflows) {
  const requests = new Map<string, { hash: string; reply: Promise<Reply> }>();
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const failure = error instanceof ServiceError ? error : new ServiceError(500, "INTERNAL_ERROR", "Request could not be completed");
      send(res, failure.status, { error: { code: failure.code, message: failure.message }, requestId: randomUUID() });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") { send(res, 200, { status: "ok" }); return; }
    const client = authenticate(req, config.clients);
    if (req.method === "GET") {
      if (path === "/v1/openapi.json") { send(res, 200, OPENAPI); return; }
      if (path === "/v1/capabilities") {
        send(res, 200, { data: {
          version: "1.1.0", provider: "playwright", modelConfigured: missingModelEnv().length === 0,
          goalWorkflows: workflows ? [
            { mode: "walkthrough", agent: "codex", browser: "ego-lite" },
            { mode: "test", agent: "midscene", browser: "ego-lite" }
          ] : [],
          steps: Object.keys(stepKeys),
          maxSessions: config.maxSessions, maxConcurrentJobs: config.maxConcurrentJobs,
          defaultTtlSeconds: config.defaultTtlSeconds, maxTtlSeconds: config.maxTtlSeconds, maxJobSeconds: config.maxJobSeconds,
          allowedOrigins: config.allowedOrigins, allowAnonymous: config.allowAnonymous,
          persistence: "Results and artifacts are saved locally; API handles and idempotency keys last until service restart"
        } }); return;
      }
      if (path === "/v1/accounts") { send(res, 200, { data: service.listAccounts(client) }); return; }
      if (path === "/v1/runs") { send(res, 200, { data: needWorkflows().list(client.id) }); return; }
      const run = path.match(/^\/v1\/runs\/([\w-]+)$/u);
      if (run) { send(res, 200, { data: needWorkflows().get(client.id, run[1]!) }); return; }
      if (path === "/v1/sessions") { send(res, 200, { data: service.listSessions(client.id) }); return; }
      const session = path.match(/^\/v1\/sessions\/([\w-]+)$/u);
      if (session) { send(res, 200, { data: service.getSession(client.id, session[1]!) }); return; }
      const job = path.match(/^\/v1\/jobs\/([\w-]+)$/u);
      if (job) { send(res, 200, { data: service.getJob(client.id, job[1]!) }); return; }
      const artifact = path.match(/^\/v1\/artifacts\/([\w.-]+)$/u);
      if (artifact) {
        let record;
        try { record = service.artifact(client.id, artifact[1]!); }
        catch (error) {
          if (!(error instanceof ServiceError) || error.status !== 404 || !workflows) throw error;
          record = workflows.artifact(client.id, artifact[1]!);
        }
        const content = await readArtifact(config, record);
        res.writeHead(200, {
          "content-type": record.contentType, "content-length": content.length,
          "content-disposition": `attachment; filename="${record.id}"`, "cache-control": "no-store",
          "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
        });
        res.end(content); return;
      }
    }
    if (req.method === "DELETE") {
      const match = path.match(/^\/v1\/sessions\/([\w-]+)$/u);
      if (match) { await service.close(client.id, match[1]!); send(res, 200, { data: service.getSession(client.id, match[1]!) }); return; }
    }
    if (req.method === "POST") {
      const isRoute = path === "/v1/runs" || /^\/v1\/runs\/[\w-]+\/cancel$/u.test(path) || path === "/v1/sessions" || /^\/v1\/sessions\/[\w-]+\/(renew|jobs)$/u.test(path) || /^\/v1\/jobs\/[\w-]+\/cancel$/u.test(path);
      if (isRoute) {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/u.test(key)) throw new ServiceError(400, "IDEMPOTENCY_KEY_REQUIRED", "POST requires an Idempotency-Key header (1–128 printable ASCII characters)");
        const input = await readJson(req);
        const cacheKey = JSON.stringify([client.id, path, key]);
        const hash = createHash("sha256").update(canonical(input)).digest("hex");
        let cached = requests.get(cacheKey);
        if (cached && cached.hash !== hash) throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", "This key was already used with a different body");
        if (!cached) {
          if (requests.size >= config.maxRecords) throw new ServiceError(429, "RECORD_LIMIT", "Request record limit reached");
          const reply = mutate(client, path, input);
          cached = { hash, reply };
          requests.set(cacheKey, cached);
        }
        const reply = await cached.reply;
        send(res, reply.status, { data: reply.data }); return;
      }
    }
    throw new ServiceError(404, "NOT_FOUND", "Endpoint not found");
  }

  async function mutate(client: Client, path: string, input: unknown): Promise<Reply> {
    if (path === "/v1/runs") return { status: 202, data: needWorkflows().submit(client, parseGoal(input)) };
    const cancelRun = path.match(/^\/v1\/runs\/([\w-]+)\/cancel$/u);
    if (cancelRun) { object(input, []); return { status: 200, data: await needWorkflows().cancel(client.id, cancelRun[1]!) }; }
    if (path === "/v1/sessions") return { status: 201, data: await service.create(client, parseSession(input, config.defaultTtlSeconds, config.maxTtlSeconds)) };
    const match = path.match(/^\/v1\/sessions\/([\w-]+)\/(jobs|renew)$/u);
    if (match) {
      if (match[2] === "jobs") return { status: 202, data: service.submit(client.id, match[1]!, parseJob(input, config.maxJobSeconds)) };
      const body = object(input, ["ttlSeconds"]);
      return { status: 200, data: service.renew(client.id, match[1]!, integer(body.ttlSeconds, config.defaultTtlSeconds, config.maxTtlSeconds, "ttlSeconds")) };
    }
    const cancel = path.match(/^\/v1\/jobs\/([\w-]+)\/cancel$/u);
    if (cancel) { object(input, []); return { status: 200, data: await service.cancelJob(client.id, cancel[1]!) }; }
    throw new ServiceError(404, "NOT_FOUND", "Endpoint not found");
  }
  function needWorkflows(): GoalWorkflows {
    if (!workflows) throw new ServiceError(503, "WORKFLOWS_UNAVAILABLE", "Goal workflows are not configured on this host");
    return workflows;
  }
  return server;
}

function authenticate(req: IncomingMessage, clients: readonly Client[]): Client {
  const match = req.headers.authorization?.match(/^Bearer (.+)$/u);
  const digest = createHash("sha256").update(match?.[1] ?? "").digest();
  const client = clients.find((c) => timingSafeEqual(digest, createHash("sha256").update(c.token).digest()));
  if (!match || !client) throw new ServiceError(401, "UNAUTHORIZED", "A valid bearer token is required");
  return client;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 256 * 1024) throw new ServiceError(413, "BODY_TOO_LARGE", "JSON body exceeds 256 KiB");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ServiceError(400, "INVALID_JSON", "Request body is not valid JSON"); }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(data));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
