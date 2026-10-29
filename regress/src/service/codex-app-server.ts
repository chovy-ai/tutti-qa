import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ServiceError } from "./protocol.ts";

type Params = Record<string, unknown>;
type Listener = (method: string, params: Params) => void;
interface Pending { resolve(value: Params): void; reject(error: Error): void; dispose(): void }
interface Turn { id: string; status: string; items?: Params[]; error?: unknown }
interface ActiveTurn { id?: string; completion: Promise<Turn>; interruption?: Promise<Params> }

const unavailable = () => new ServiceError(503, "CODEX_UNAVAILABLE", "Codex app-server did not confirm the operation; check its host installation, login and configuration");

/** One host process; separate threads retain each walkthrough's own tool history. */
export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private turns = new Map<string, ActiveTurn>();
  private stopped = false;
  private readonly command: string;
  private readonly args: string[];

  constructor(command = "codex", args = ["app-server", "--listen", "stdio://", "--disable", "multi_agent", "--disable", "apps", "--disable", "plugins", "--disable", "hooks"]) {
    this.command = command;
    this.args = args;
  }

  private async start(): Promise<void> {
    if (this.stopped) throw unavailable();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      // Diagnostics may contain host configuration. Never forward raw stderr to API callers.
      child.stderr.resume();
      child.stdin.on("error", () => this.failed(child));
      child.once("error", () => this.failed(child));
      child.once("exit", () => this.failed(child));
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try { this.receive(child, JSON.parse(line) as Params); }
        catch { this.failed(child); child.kill("SIGTERM"); }
      });
      await this.send("initialize", { clientInfo: { name: "tutti-qa", version: "0.1.0" } });
      this.notify("initialized", {});
    })();
    try { await this.starting; }
    catch (error) { this.starting = undefined; throw error; }
  }

  private failed(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.starting = undefined;
    child.kill("SIGTERM");
    for (const pending of this.pending.values()) { pending.dispose(); pending.reject(unavailable()); }
    this.pending.clear();
    for (const listener of this.listeners) listener("transport/closed", {});
  }

  private receive(child: ChildProcessWithoutNullStreams, message: Params): void {
    if (this.child !== child) return;
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        // There is no interactive approval UI on this headless service. Do not approve on a user's behalf.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive requests are unavailable in this QA service" } }) + "\n");
        const params = message.params && typeof message.params === "object" ? message.params as Params : {};
        for (const listener of this.listeners) listener("interaction/required", params);
      } else {
        const params = message.params && typeof message.params === "object" ? message.params as Params : {};
        for (const listener of this.listeners) listener(message.method, params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.dispose();
    if (message.error) pending.reject(unavailable());
    else if (message.result && typeof message.result === "object") pending.resolve(message.result as Params);
    else pending.reject(unavailable());
  }

  private notify(method: string, params: Params): void {
    if (!this.child) throw unavailable();
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  private send(method: string, params: Params, signal?: AbortSignal): Promise<Params> {
    const child = this.child;
    if (!child) return Promise.reject(unavailable());
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A lost start response is not permission to submit the walkthrough again.
        this.failed(child);
      }, 15_000).unref();
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { this.pending.delete(id); dispose(); reject(signal?.reason); };
      this.pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) this.failed(child);
      });
    });
  }

  async request(method: string, params: Params): Promise<Params> {
    await this.start();
    return this.send(method, params);
  }

  /** A turn may make any number of native tool calls; tool execution stays inside Codex. */
  async turn(threadId: string, params: Params, signal: AbortSignal, onProgress?: () => void): Promise<{ turnId: string; text: string; toolItems: Params[] }> {
    signal.throwIfAborted();
    await this.start();
    if (this.turns.has(threadId)) throw new ServiceError(409, "CODEX_THREAD_BUSY", "This walkthrough thread already has an active turn");
    let turnId: string | undefined;
    let text = "";
    const toolItems: Params[] = [];
    let final: Turn | undefined;
    let resolveTurn: (turn: Turn) => void = () => {};
    let rejectTurn: (error: unknown) => void = () => {};
    const completion = new Promise<Turn>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    void completion.catch(() => {});
    const active: ActiveTurn = { completion };
    this.turns.set(threadId, active);
    let rejectInterrupted: (error: unknown) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => {});
    const interrupt = () => {
      if (turnId && !active.interruption) {
        active.interruption = this.send("turn/interrupt", { threadId, turnId });
        void active.interruption.catch(() => {});
      }
    };
    const abort = () => { interrupt(); rejectInterrupted(signal.reason); };
    const listener: Listener = (method, value) => {
      if (method === "transport/closed") { rejectTurn(unavailable()); return; }
      if (method === "interaction/required" && (!value.threadId || value.threadId === threadId)) {
        interrupt();
        rejectInterrupted(new ServiceError(409, "CODEX_INTERACTION_REQUIRED", "Codex requires human input or permission; complete the host interaction before rerunning"));
        return;
      }
      if (value.threadId !== threadId) return;
      if (method === "turn/started") {
        const turn = value.turn as Turn;
        turnId = turn.id;
        active.id = turnId;
        if (signal.aborted) interrupt();
      }
      if (value.turnId && turnId && value.turnId !== turnId) return;
      if (method === "item/started") onProgress?.();
      if (method === "item/completed") {
        const item = value.item as Params;
        if (item?.type === "agentMessage" && typeof item.text === "string" && (!item.phase || item.phase === "final_answer")) text = item.text;
        if (item?.type === "commandExecution" || item?.type === "mcpToolCall") toolItems.push(item);
      }
      if (method === "turn/completed") {
        final = value.turn as Turn;
        if (!turnId || final.id === turnId) resolveTurn(final);
      }
    };
    this.listeners.add(listener);
    const release = () => {
      this.listeners.delete(listener);
      if (this.turns.get(threadId) === active) this.turns.delete(threadId);
    };
    void completion.then(release, release);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.send("turn/start", { ...params, threadId }, signal);
      const started = response.turn as Turn | undefined;
      if (!started?.id) throw unavailable();
      turnId = started.id;
      active.id = turnId;
      if (signal.aborted) { interrupt(); throw signal.reason; }
      const turn = final?.id === turnId ? final : await Promise.race([completion, interrupted]);
      if (turn.id !== turnId) throw unavailable();
      if (turn.status !== "completed") {
        const failure = new ServiceError(503, "CODEX_TURN_FAILED", "Codex walkthrough did not complete; inspect its host session");
        failure.cause = turn.error;
        throw failure;
      }
      if (!text) {
        const item = turn.items?.findLast((item) => item.type === "agentMessage" && (!item.phase || item.phase === "final_answer"));
        if (typeof item?.text === "string") text = item.text;
      }
      if (!text) throw new ServiceError(503, "CODEX_REPORT_MISSING", "Codex completed without a walkthrough report");
      return { turnId, text, toolItems };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async stopThread(threadId: string): Promise<void> {
    const active = this.turns.get(threadId);
    if (!active) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (active.id && !active.interruption) {
        active.interruption = this.send("turn/interrupt", { threadId, turnId: active.id });
        void active.interruption.catch(() => {});
      }
      await Promise.race([
        active.completion,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unavailable()), 3000).unref(); })
      ]);
    } catch {
      if (this.child) this.failed(this.child);
      throw new ServiceError(503, "CODEX_STOP_UNCONFIRMED", "Codex did not confirm that its walkthrough turn stopped");
    } finally { clearTimeout(timer); }
  }

  async close(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, 1000).unref();
      const fallback = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000).unref();
      child.once("exit", () => { clearTimeout(timer); clearTimeout(fallback); resolve(); });
      child.stdin.end();
    });
  }
}
