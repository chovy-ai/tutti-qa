// 通用接口不包含产品业务字段；凭据与底层浏览器句柄只存在于 provider 内。
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new ServiceError(400, "INVALID_REQUEST", message);
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  const record = value as Record<string, unknown>;
  requireValue(Object.keys(record).every((key) => keys.includes(key)), "Unknown field");
  return record;
}

export function text(value: unknown, name: string, max = 10_000): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max, `Invalid ${name}`);
  return value as string;
}

export function integer(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  requireValue(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max, `Invalid ${name}`);
  return value as number;
}

export function strings(value: unknown): string[] {
  requireValue(Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === "string" && v.length <= 255), "Expected a string array");
  return value as string[];
}

export type Step =
  | { type: "navigate"; url: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "press"; selector: string; key: string }
  | { type: "select"; selector: string; value: string }
  | { type: "snapshot" }
  | { type: "screenshot"; fullPage?: boolean }
  | { type: "act" | "assert" | "wait" | "query"; prompt: string };

export const stepKeys: Record<Step["type"], readonly string[]> = {
  navigate: ["url"], click: ["selector"], fill: ["selector", "value"], press: ["selector", "key"],
  select: ["selector", "value"], snapshot: [], screenshot: ["fullPage"],
  act: ["prompt"], assert: ["prompt"], wait: ["prompt"], query: ["prompt"]
};

export function parseSteps(value: unknown): Step[] {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 100, "Expected 1–100 steps");
  return (value as unknown[]).map((raw) => {
    requireValue(raw && typeof raw === "object" && !Array.isArray(raw), "Invalid step");
    const type = (raw as { type?: unknown }).type;
    requireValue(typeof type === "string" && Object.hasOwn(stepKeys, type), "Unknown step type");
    const keys = stepKeys[type as Step["type"]];
    const step = object(raw, ["type", ...keys]);
    for (const key of keys) {
      if (key === "fullPage") requireValue(step[key] === undefined || typeof step[key] === "boolean", "Invalid fullPage");
      else if (key === "value") requireValue(typeof step[key] === "string" && step[key].length <= 10_000, "Invalid value");
      else text(step[key], key);
    }
    return step as unknown as Step;
  });
}

export interface Artifact {
  id: string;
  contentType: "image/png" | "text/html";
}

export interface StepResult {
  type: Step["type"];
  pass: boolean;
  data?: unknown;
  artifacts?: Artifact[];
}

export interface Client {
  id: string;
  token: string;
  accountIds?: readonly string[];
}

export interface CreateSession {
  accountId?: string;
  selector?: { env?: string; roles?: string[]; capabilities?: string[]; tags?: string[] };
  url?: string;
  ttlSeconds: number;
}

export function parseSession(raw: unknown, defaultTtl: number, maxTtl: number): CreateSession {
  const body = object(raw, ["accountId", "selector", "url", "ttlSeconds"]);
  requireValue(!(body.accountId && body.selector), "Choose accountId or selector");
  const result: CreateSession = { ttlSeconds: integer(body.ttlSeconds, defaultTtl, maxTtl, "ttlSeconds") };
  if (body.accountId !== undefined) result.accountId = text(body.accountId, "accountId", 255);
  if (body.url !== undefined) result.url = text(body.url, "url");
  if (body.selector !== undefined) {
    const selector = object(body.selector, ["env", "roles", "capabilities", "tags"]);
    result.selector = {};
    if (selector.env !== undefined) result.selector.env = text(selector.env, "env", 255);
    for (const key of ["roles", "capabilities", "tags"] as const) {
      if (selector[key] !== undefined) result.selector[key] = strings(selector[key]);
    }
  }
  return result;
}

export interface SubmitJob {
  steps: Step[];
  timeoutSeconds: number;
}

export function parseJob(raw: unknown, maxTimeout: number): SubmitJob {
  const body = object(raw, ["steps", "timeoutSeconds"]);
  return { steps: parseSteps(body.steps), timeoutSeconds: integer(body.timeoutSeconds, Math.min(300, maxTimeout), maxTimeout, "timeoutSeconds") };
}
