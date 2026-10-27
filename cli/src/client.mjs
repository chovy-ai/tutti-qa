import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class ClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function readToken(file, envToken) {
  if (!file) return envToken?.trim();
  let value;
  try { value = (await readFile(resolve(file), "utf8")).trim(); }
  catch { throw new ClientError("TOKEN_FILE_ERROR", "Could not read the token file"); }
  if (value.startsWith("{")) {
    try { value = JSON.parse(value).token; }
    catch { throw new ClientError("TOKEN_FILE_ERROR", "Token JSON must contain a token string"); }
  }
  if (typeof value !== "string" || !value.trim()) throw new ClientError("TOKEN_FILE_ERROR", "Token file is empty or invalid");
  return value.trim();
}

export class BrowserClient {
  constructor({ server = "http://127.0.0.1:4318", token, timeoutMs = 30_000, retries = 2, fetchImpl = fetch } = {}) {
    let url;
    try { url = new URL(server); } catch { throw new ClientError("INVALID_SERVER", "Server must be an absolute HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ClientError("INVALID_SERVER", "Server must use HTTP(S) without URL credentials, query or fragment");
    }
    this.server = url.href.replace(/\/+$/u, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
  }

  async request(method, path, { body, requestId, signal, publicEndpoint = false, timeoutMs = this.timeoutMs } = {}) {
    const key = method === "POST" ? (requestId ?? randomUUID()) : undefined;
    if (key && !/^[\x21-\x7e]{1,128}$/u.test(key)) throw new ClientError("INVALID_REQUEST_ID", "Request ID must be 1–128 printable ASCII characters");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return this.perform(method, path, { key, payload, signal, publicEndpoint, timeoutMs }, async (response) => {
      let value;
      try { value = await response.json(); }
      catch { throw new ClientError("INVALID_RESPONSE", "Server did not return a complete JSON response"); }
      if (!publicEndpoint && !path.endsWith("/openapi.json") && (!value || !Object.hasOwn(value, "data"))) {
        throw new ClientError("INVALID_RESPONSE", "Server response is missing data");
      }
      return publicEndpoint || path.endsWith("/openapi.json") ? value : value.data;
    });
  }

  async download(id, out, { signal } = {}) {
    if (!/^[\w-]+\.(png|html)$/u.test(id)) throw new ClientError("INVALID_ARTIFACT", "Invalid artifact ID");
    const destination = resolve(out);
    // 在请求之前检查输出位置；wx 保证不会覆盖已有文件。
    await mkdir(dirname(destination), { recursive: true });
    let file;
    try { file = await open(destination, "wx", 0o600); }
    catch { throw new ClientError("OUTPUT_ERROR", "Output file already exists or could not be created"); }
    let bytes = 0;
    try {
      await this.perform("GET", `/v1/artifacts/${encodeURIComponent(id)}`, { signal, timeoutMs: this.timeoutMs }, async (response) => {
        if (!response.body) throw new ClientError("INVALID_RESPONSE", "Artifact response has no body");
        const expected = id.endsWith(".png") ? "image/png" : "text/html";
        if (response.headers.get("content-type")?.split(";", 1)[0] !== expected) throw new ClientError("INVALID_RESPONSE", "Artifact content type does not match its ID");
        // 仅 JSON 请求可自动重试读取；文件传输失败后移除本次未完成文件，由调用方重试。
        for await (const chunk of response.body) { await file.writeFile(chunk); bytes += chunk.length; }
      }, false);
      await file.close();
      return { id, path: destination, bytes };
    } catch (error) {
      await file.close().catch(() => {});
      await rm(destination).catch(() => {});
      throw error;
    }
  }

  async perform(method, path, options, consume, retryRead = true) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new ClientError("INVALID_PATH", "Invalid API path");
    if (!options.publicEndpoint && (!this.token || !/^[\x21-\x7e]+$/u.test(this.token))) {
      throw new ClientError("TOKEN_REQUIRED", "Set BROWSER_TEST_TOKEN or use --token-file");
    }
    const headers = { accept: "application/json" };
    if (!options.publicEndpoint) headers.authorization = `Bearer ${this.token}`;
    if (options.key) headers["idempotency-key"] = options.key;
    if (options.payload !== undefined) headers["content-type"] = "application/json";
    let attempts = 0;
    while (true) {
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await this.fetch(this.server + path, {
          method, headers, body: options.payload, redirect: "manual", signal
        });
        if (!response.ok) {
          let failure;
          try { failure = await response.json(); } catch { /* 不把代理 HTML 或原始响应写进终端。 */ }
          const code = typeof failure?.error?.code === "string" ? failure.error.code : `HTTP_${response.status}`;
          const message = typeof failure?.error?.message === "string" ? failure.error.message : `Server returned HTTP ${response.status}`;
          if (!failure?.error && [502, 503, 504].includes(response.status) && attempts < this.retries) {
            attempts++;
            await delay(200 * attempts, undefined, { signal: options.signal });
            continue;
          }
          throw new ClientError(code, this.redact(message), { status: response.status, ...(options.key ? { requestId: options.key } : {}), operationState: "rejected" });
        }
        return await consume(response);
      } catch (error) {
        if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Command interrupted", { ...(options.key ? { requestId: options.key } : {}), operationState: method === "GET" ? "unconfirmed" : "unknown" });
        if (error instanceof ClientError && error.code !== "INVALID_RESPONSE") throw error;
        if (retryRead && attempts < this.retries) {
          attempts++;
          await delay(200 * attempts, undefined, { signal: options.signal }).catch(() => {});
          continue;
        }
        throw new ClientError(method === "GET" ? "REQUEST_FAILED" : "REQUEST_UNCONFIRMED", "Could not confirm the server response; do not resubmit with a new request ID", {
          method, path, ...(options.key ? { requestId: options.key } : {}), operationState: method === "GET" ? "unconfirmed" : "unknown"
        });
      }
    }
  }

  redact(message) { return this.token ? message.split(this.token).join("[redacted]") : message; }
}
