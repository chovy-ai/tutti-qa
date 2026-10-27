import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Account } from "./accounts.ts";
import type { ServiceConfig } from "./config.ts";
import type { BrowserHandle, BrowserProvider } from "./provider.ts";
import { ServiceError, type Client, type CreateSession, type SubmitJob, type StepResult, type Artifact } from "./protocol.ts";

export interface SessionRecord {
  id: string;
  accountId?: string;
  status: "creating" | "ready" | "closing" | "closed" | "quarantined";
  createdAt: string;
  expiresAt: string;
}

interface Session extends SessionRecord {
  owner: string;
  resourceKey?: string;
  handle?: BrowserHandle;
  opening?: Promise<BrowserHandle>;
  closing?: Promise<void>;
  leaseHeld?: boolean;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results: StepResult[];
  error?: { code: string; message: string };
}

interface Job extends JobRecord {
  owner: string;
  input: SubmitJob;
  cancel: AbortController;
}

export class BrowserService {
  private sessions = new Map<string, Session>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active = new Set<string>();
  private running = new Set<Promise<void>>();
  private stopping = false;
  private timer: NodeJS.Timeout;

  readonly config: ServiceConfig;
  readonly accounts: readonly Account[];
  readonly provider: BrowserProvider;
  constructor(config: ServiceConfig, accounts: readonly Account[], provider: BrowserProvider) {
    this.config = config;
    this.accounts = accounts;
    this.provider = provider;
    this.timer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (["ready", "creating"].includes(session.status) && Date.parse(session.expiresAt) <= Date.now()) {
          void this.close(session.owner, session.id).catch(() => {});
        }
      }
    }, 1000).unref();
  }

  listAccounts(client: Client) {
    return this.accounts.filter((a) => this.allowed(client, a.id)).map((account) => ({
      id: account.id, env: account.env, roles: account.roles, capabilities: account.capabilities, tags: account.tags,
      status: this.busy(account.resourceKey) ? "busy" : "available"
    }));
  }

  listSessions(owner: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map(publicSession);
  }

  getSession(owner: string, id: string): SessionRecord {
    return publicSession(this.session(owner, id));
  }

  async create(client: Client, input: CreateSession): Promise<SessionRecord> {
    if (this.stopping) throw new ServiceError(503, "STOPPING", "Service is stopping");
    if (this.sessions.size >= this.config.maxRecords) throw new ServiceError(429, "RECORD_LIMIT", "Session record limit reached; restart after closing sessions");
    if ([...this.sessions.values()].filter((s) => s.status !== "closed").length >= this.config.maxSessions) throw new ServiceError(429, "SESSION_LIMIT", "Session capacity reached");
    let account: Account | undefined;
    if (input.accountId || input.selector) {
      const matches = this.accounts.filter((a) => this.allowed(client, a.id) && (
        input.accountId ? a.id === input.accountId :
          (!input.selector?.env || a.env === input.selector.env) &&
          ["roles", "capabilities", "tags"].every((key) =>
            (input.selector?.[key as "roles"] ?? []).every((v) => a[key as "roles"].includes(v)))
      ));
      if (!matches.length) throw new ServiceError(404, "ACCOUNT_NOT_FOUND", "No permitted account matches");
      account = matches.find((a) => !this.busy(a.resourceKey));
      if (!account) throw new ServiceError(409, "ACCOUNT_BUSY", "Matching accounts are in use");
    } else if (!this.config.allowAnonymous) throw new ServiceError(400, "ACCOUNT_REQUIRED", "An account is required");
    const session: Session = {
      id: randomUUID(), owner: client.id, accountId: account?.id, resourceKey: account?.resourceKey,
      status: "creating", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
    };
    // 在首次 await 前占用 resourceKey，避免并发创建分配同一账号。
    this.sessions.set(session.id, session);
    try {
      if (account) {
        await mkdir(this.config.leaseDir, { recursive: true, mode: 0o700 });
        try { await mkdir(this.leasePath(account.resourceKey), { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ServiceError(409, "ACCOUNT_BUSY", "Account is reserved by another service or requires host recovery");
          throw error;
        }
        session.leaseHeld = true;
        await writeFile(resolve(this.leasePath(account.resourceKey), "owner.json"), JSON.stringify({ pid: process.pid, sessionId: session.id, createdAt: session.createdAt }) + "\n", { mode: 0o600 });
      }
      if (session.status !== "creating") throw new ServiceError(409, "SESSION_CLOSED", "Session closed during startup");
      session.opening = this.provider.open(session.id, account, input.url);
      session.handle = await session.opening;
      if (session.status !== "creating") {
        await session.closing;
        throw new ServiceError(409, "SESSION_CLOSED", "Session closed during startup");
      }
      session.status = "ready";
      return publicSession(session);
    } catch (error) {
      // Provider.open 必须在失败返回前清理它创建的进程。
      if (error instanceof ServiceError && error.code === "CLEANUP_FAILED") session.status = "quarantined";
      else if (session.status === "creating" || session.status === "closed") {
        try { await this.releaseLease(session); session.status = "closed"; }
        catch { session.status = "quarantined"; }
      }
      const failure = error instanceof ServiceError ? error : new ServiceError(503, "BROWSER_START_FAILED", "Browser could not start; check host configuration");
      failure.sessionId = session.id;
      throw failure;
    }
  }

  renew(owner: string, id: string, ttlSeconds: number): SessionRecord {
    const session = this.session(owner, id);
    this.requireReady(session);
    session.expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return publicSession(session);
  }

  async close(owner: string, id: string): Promise<void> {
    const session = this.session(owner, id);
    if (session.status === "closed") return;
    if (session.closing) return session.closing;
    const wasQuarantined = session.status === "quarantined";
    session.status = "closing";
    const cancelled: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.sessionId !== id || !["queued", "running"].includes(job.status)) continue;
      job.cancel.abort();
      if (job.status === "queued") {
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
        cancelled.push(job);
      }
    }
    this.queue = this.queue.filter((job) => job.sessionId !== id);
    session.closing = (async () => {
      try {
        const handle = session.handle ?? await session.opening?.catch((error: unknown) => {
          if (error instanceof ServiceError && error.code === "CLEANUP_FAILED") throw error;
          return undefined;
        });
        if (handle) await handle.close();
        else if (wasQuarantined) throw new Error("Unknown browser state");
        await this.releaseLease(session);
        session.status = "closed";
      } catch {
        // 关闭结果不确定时保留租约，不能把账号重新分给别人。
        session.status = "quarantined";
        throw new ServiceError(503, "CLEANUP_FAILED", "Browser cleanup is uncertain; account remains reserved");
      } finally {
        await Promise.all(cancelled.map((job) => this.persist(job)));
        session.closing = undefined;
      }
    })();
    return session.closing;
  }

  submit(owner: string, sessionId: string, input: SubmitJob): JobRecord {
    const session = this.session(owner, sessionId);
    this.requireReady(session);
    if (this.jobs.size >= this.config.maxRecords) throw new ServiceError(429, "RECORD_LIMIT", "Job record limit reached");
    if (this.queue.length >= this.config.maxQueuedJobs) throw new ServiceError(429, "QUEUE_FULL", "Job queue is full");
    const job: Job = { id: randomUUID(), sessionId, owner, input, cancel: new AbortController(), status: "queued", createdAt: new Date().toISOString(), results: [] };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.schedule();
    return publicJob(job);
  }

  getJob(owner: string, id: string): JobRecord {
    return publicJob(this.job(owner, id));
  }

  async cancelJob(owner: string, id: string): Promise<JobRecord> {
    const job = this.job(owner, id);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.queue = this.queue.filter((item) => item !== job);
      await this.persist(job);
    } else if (job.status === "running") {
      // 运行中的操作不能安全回滚；关闭整个会话后才允许归还账号。
      await this.close(owner, job.sessionId);
    }
    return publicJob(job);
  }

  artifact(owner: string, id: string): Artifact {
    for (const job of this.jobs.values()) {
      if (job.owner !== owner) continue;
      const artifact = job.results.flatMap((r) => r.artifacts ?? []).find((a) => a.id === id);
      if (artifact) return artifact;
    }
    throw new ServiceError(404, "NOT_FOUND", "Artifact not found");
  }

  async shutdown(): Promise<boolean> {
    this.stopping = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.sessions.values()].map((s) => this.close(s.owner, s.id)));
    await Promise.allSettled([...this.running]);
    return results.every((r) => r.status === "fulfilled");
  }

  private allowed(client: Client, id: string): boolean { return !client.accountIds || client.accountIds.includes(id); }
  private busy(key: string): boolean { return existsSync(this.leasePath(key)) || [...this.sessions.values()].some((s) => s.resourceKey === key && s.status !== "closed"); }
  private leasePath(key: string): string { return resolve(this.config.leaseDir, createHash("sha256").update(key).digest("hex")); }
  private async releaseLease(session: Session): Promise<void> {
    if (!session.leaseHeld || !session.resourceKey) return;
    await rm(this.leasePath(session.resourceKey), { recursive: true });
    session.leaseHeld = false;
  }
  private session(owner: string, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new ServiceError(404, "NOT_FOUND", "Session not found");
    return session;
  }
  private job(owner: string, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ServiceError(404, "NOT_FOUND", "Job not found");
    return job;
  }
  private requireReady(session: Session): void {
    if (session.status !== "ready" || Date.parse(session.expiresAt) <= Date.now() || this.stopping) throw new ServiceError(409, "SESSION_UNAVAILABLE", "Session is closed, expired, or unavailable");
  }

  private schedule(): void {
    if (this.stopping) return;
    while (this.active.size < this.config.maxConcurrentJobs) {
      const index = this.queue.findIndex((job) => !this.active.has(job.sessionId));
      if (index === -1) break;
      const job = this.queue.splice(index, 1)[0]!;
      this.active.add(job.sessionId);
      const task = this.execute(job).finally(() => {
        this.active.delete(job.sessionId);
        this.running.delete(task);
        this.schedule();
      });
      this.running.add(task);
    }
  }

  private async execute(job: Job): Promise<void> {
    const session = this.sessions.get(job.sessionId)!;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    let timeout: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      job.cancel.signal.addEventListener("abort", () => reject(new ServiceError(409, "CANCELLED", "Job cancelled; session closed")), { once: true });
      timeout = setTimeout(() => {
        job.status = "timed_out";
        reject(new ServiceError(408, "JOB_TIMEOUT", "Job exceeded its deadline; session closed"));
      }, job.input.timeoutSeconds * 1000).unref();
    });
    const work = async () => {
      for (const step of job.input.steps) {
        if (job.cancel.signal.aborted || jobStatus(job) === "timed_out") return;
        let result: StepResult;
        try { result = await session.handle!.execute(step, `${job.id}-${job.results.length + 1}`); }
        catch (error) {
          if (!job.cancel.signal.aborted && jobStatus(job) !== "timed_out") job.results.push({ type: step.type, pass: false });
          throw error;
        }
        if (job.cancel.signal.aborted || jobStatus(job) === "timed_out") return;
        job.results.push(result);
        if (!result.pass) { job.status = "failed"; return; }
      }
      if (!job.cancel.signal.aborted) job.status = "passed";
    };
    try { await Promise.race([work(), interrupted]); }
    catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError(500, "STEP_FAILED", "Browser step failed");
      job.error = { code: failure.code, message: failure.message };
      if (jobStatus(job) !== "timed_out") job.status = job.cancel.signal.aborted ? "cancelled" : "failed";
      // 错误后页面状态不确定，销毁会话，避免后续排队操作基于错误状态继续。
      await this.close(job.owner, job.sessionId).catch(() => {});
    } finally {
      clearTimeout(timeout);
      job.finishedAt = new Date().toISOString();
      await this.persist(job);
    }
  }

  private async persist(job: Job): Promise<void> {
    // 只保存结果，不保存包含 fill 值、提示词等内容的原始请求。
    const dir = resolve(this.config.stateDir, "jobs");
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(resolve(dir, `${job.id}.json`), JSON.stringify(publicJob(job), null, 2) + "\n", { mode: 0o600 });
    } catch {
      job.error = { code: "RESULT_WRITE_FAILED", message: "Result could not be saved on the host" };
      if (jobStatus(job) === "passed") job.status = "failed";
    }
  }
}

function publicSession(s: Session): SessionRecord {
  return { id: s.id, accountId: s.accountId, status: s.status, createdAt: s.createdAt, expiresAt: s.expiresAt };
}

function publicJob(job: Job): JobRecord {
  return { id: job.id, sessionId: job.sessionId, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, results: [...job.results], error: job.error };
}

function jobStatus(job: Job): JobRecord["status"] { return job.status; }
