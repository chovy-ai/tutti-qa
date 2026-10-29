import { stepKeys } from "./protocol.ts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const envelope = (schema: object) => ({ type: "object", required: ["data"], properties: { data: schema } });
const json = (schema: object) => ({ "application/json": { schema } });
const response = (schema: object) => ({ description: "Success", content: json(envelope(schema)) });
const body = (schema: object) => ({ required: true, content: json(schema) });
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const idem = { name: "Idempotency-Key", in: "header", required: true, description: "Reuse the same key and JSON body on retries. Keys are scoped to route for this service lifetime; all callers share one service identity.", schema: { type: "string", minLength: 1, maxLength: 128 } };
const error = { description: "Request rejected or operation failed", content: json({ type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }, requestId: { type: "string" } } }) };
const operation = (operationId: string, schema: object, options: { input?: object; pathId?: boolean; code?: string } = {}) => ({
  operationId,
  parameters: [...(options.pathId ? [id] : []), ...(options.input ? [idem] : [])],
  ...(options.input ? { requestBody: body(options.input) } : {}),
  responses: { [options.code ?? "200"]: response(schema), default: error }
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Browser Test Service", version: "1.1.0", description: "Goal workflows: Codex + ego lite walkthroughs and Midscene + ego lite tests, using the existing host account pool. Also retains session/step APIs. No authentication; all requests share the local service identity." },
  paths: {
    "/health": { get: { operationId: "health", security: [], responses: { "200": { description: "Process is listening" } } } },
    "/v1/openapi.json": { get: { operationId: "openapi", responses: { "200": { description: "This OpenAPI document" } } } },
    "/v1/capabilities": { get: operation("capabilities", { type: "object" }) },
    "/v1/accounts": { get: operation("listAccounts", { type: "array", items: ref("Account") }) },
    "/v1/runs": {
      get: operation("listGoalRuns", { type: "array", items: ref("GoalRun") }),
      post: operation("submitGoalRun", ref("GoalRun"), { input: ref("GoalInput"), code: "202" })
    },
    "/v1/runs/{id}": { get: operation("getGoalRun", ref("GoalRun"), { pathId: true }) },
    "/v1/runs/{id}/cancel": { post: operation("cancelGoalRun", ref("GoalRun"), { pathId: true, input: { type: "object", additionalProperties: false } }) },
    "/v1/sessions": {
      get: operation("listSessions", { type: "array", items: ref("Session") }),
      post: operation("createSession", ref("Session"), { input: ref("CreateSession"), code: "201" })
    },
    "/v1/sessions/{id}": {
      get: operation("getSession", ref("Session"), { pathId: true }),
      delete: operation("closeSession", ref("Session"), { pathId: true })
    },
    "/v1/sessions/{id}/renew": { post: operation("renewSession", ref("Session"), { pathId: true, input: { type: "object", additionalProperties: false, properties: { ttlSeconds: { type: "integer", minimum: 1, maximum: 86400 } } } }) },
    "/v1/sessions/{id}/jobs": { post: operation("submitJob", ref("Job"), { pathId: true, code: "202", input: ref("SubmitJob") }) },
    "/v1/jobs/{id}": { get: operation("getJob", ref("Job"), { pathId: true }) },
    "/v1/jobs/{id}/cancel": { post: operation("cancelJob", ref("Job"), { pathId: true, input: { type: "object", additionalProperties: false } }) },
    "/v1/artifacts/{id}": { get: { operationId: "downloadArtifact", parameters: [id], responses: { "200": { description: "Service artifact", content: { "image/png": { schema: { type: "string", format: "binary" } }, "text/html": { schema: { type: "string" } } } }, default: error } } }
  },
  components: {
    schemas: {
      GoalInput: {
        type: "object", additionalProperties: false, required: ["mode", "goal"],
        description: "Submit a goal, not browser steps. The host chooses an existing permitted account when accountId/selector are omitted. accountId and selector are mutually exclusive.",
        not: { required: ["accountId", "selector"] },
        properties: {
          mode: { enum: ["walkthrough", "test"] }, goal: { type: "string", minLength: 1, maxLength: 10_000 },
          target: { type: "string", format: "uri", maxLength: 2000 }, accountId: { type: "string", minLength: 1, maxLength: 255 },
          selector: { $ref: "#/components/schemas/CreateSession/properties/selector" },
          ...Object.fromEntries(["expectations", "constraints"].map((key) => [key, { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2000 } }])),
          maxSteps: { type: "integer", minimum: 1, maximum: 1000, default: 1000, description: "walkthrough: requested native-browser operation budget (model-guided); test: host-enforced plan step limit" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 600 }
        }
      },
      GoalRun: {
        type: "object", required: ["id", "mode", "goal", "agent", "browser", "status", "phase", "createdAt", "checks", "observations", "artifacts", "uncovered"],
        properties: {
          id: { type: "string" }, mode: { enum: ["walkthrough", "test"] }, goal: { type: "string" },
          agent: { enum: ["codex", "midscene"] }, browser: { const: "ego-lite" },
          status: { enum: ["queued", "running", "completed", "passed", "failed", "blocked", "cancelled", "timed_out"] },
          phase: { enum: ["queued", "account", "planning", "executing", "verifying", "cleanup", "finished"] },
          createdAt: { type: "string", format: "date-time" }, startedAt: { type: "string", format: "date-time" }, finishedAt: { type: "string", format: "date-time" },
          accountId: { type: "string" }, summary: { type: "string" }, uncovered: { type: "array", items: { type: "string" } },
          cleanup: { type: "object", properties: { status: { enum: ["closed", "unknown", "not_started"] } } },
          checks: { type: "array", items: { type: "object", properties: { expectation: { type: "string" }, pass: { type: "boolean" }, detail: { type: "string" }, source: { enum: ["requested", "inferred"] } } } },
          observations: { type: "array", items: { type: "object", properties: { step: { type: "integer" }, summary: { type: "string" }, url: { type: "string" }, title: { type: "string" } } } },
          artifacts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, contentType: { enum: ["image/png", "text/html"] } } } },
          error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }
        }
      },
      Account: { type: "object", properties: { id: { type: "string" }, env: { type: "string" }, roles: { type: "array", items: { type: "string" } }, capabilities: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } }, status: { enum: ["available", "busy"] } } },
      CreateSession: {
        type: "object", additionalProperties: false,
        description: "accountId and selector are mutually exclusive. Omit both for an isolated anonymous session. A session holds its account lease until confirmed browser cleanup.",
        properties: {
          accountId: { type: "string", minLength: 1, maxLength: 255 },
          selector: { type: "object", additionalProperties: false, properties: { env: { type: "string" }, ...Object.fromEntries(["roles", "capabilities", "tags"].map((key) => [key, { type: "array", items: { type: "string" } }])) } },
          url: { type: "string", format: "uri" }, ttlSeconds: { type: "integer", minimum: 1, maximum: 86400 }
        }
      },
      Session: { type: "object", required: ["id", "status", "createdAt", "expiresAt"], properties: { id: { type: "string" }, accountId: { type: "string" }, status: { enum: ["creating", "ready", "closing", "closed", "quarantined"] }, createdAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" } } },
      SubmitJob: { type: "object", additionalProperties: false, required: ["steps"], properties: { steps: { type: "array", minItems: 1, maxItems: 100, items: ref("Step") }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 } } },
      Step: {
        oneOf: Object.entries(stepKeys).map(([type, keys]) => ({
          type: "object", additionalProperties: false, required: ["type", ...keys.filter((key) => key !== "fullPage")],
          properties: { type: { const: type }, ...Object.fromEntries(keys.map((key) => [key, key === "fullPage" ? { type: "boolean" } : { type: "string", maxLength: 10_000, ...(key === "value" ? {} : { minLength: 1 }) }])) }
        }))
      },
      Job: { type: "object", required: ["id", "sessionId", "status", "results"], properties: { id: { type: "string" }, sessionId: { type: "string" }, status: { enum: ["queued", "running", "passed", "failed", "cancelled", "timed_out"] }, createdAt: { type: "string", format: "date-time" }, startedAt: { type: "string", format: "date-time" }, finishedAt: { type: "string", format: "date-time" }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }, results: { type: "array", items: ref("StepResult") } } },
      StepResult: { type: "object", required: ["type", "pass"], properties: { type: { type: "string" }, pass: { type: "boolean" }, data: {}, artifacts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, contentType: { enum: ["image/png", "text/html"] } } } } } }
    }
  }
};
