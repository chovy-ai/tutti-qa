import { stepKeys } from "./protocol.ts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const envelope = (schema: object) => ({ type: "object", required: ["data"], properties: { data: schema } });
const json = (schema: object) => ({ "application/json": { schema } });
const response = (schema: object) => ({ description: "Success", content: json(envelope(schema)) });
const body = (schema: object) => ({ required: true, content: json(schema) });
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const idem = { name: "Idempotency-Key", in: "header", required: true, description: "Reuse the same key and JSON body on retries. Keys are scoped to caller and route for this service lifetime.", schema: { type: "string", minLength: 1, maxLength: 128 } };
const error = { description: "Request rejected or operation failed", content: json({ type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } }, requestId: { type: "string" } } }) };
const operation = (operationId: string, schema: object, options: { input?: object; pathId?: boolean; code?: string } = {}) => ({
  operationId,
  parameters: [...(options.pathId ? [id] : []), ...(options.input ? [idem] : [])],
  ...(options.input ? { requestBody: body(options.input) } : {}),
  responses: { [options.code ?? "200"]: response(schema), default: error }
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Browser Test Service", version: "1.0.0", description: "Generic browser sessions, account leases and deterministic/AI test steps. All /v1 endpoints require a host-configured bearer token." },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": { get: { operationId: "health", security: [], responses: { "200": { description: "Process is listening" } } } },
    "/v1/openapi.json": { get: { operationId: "openapi", responses: { "200": { description: "This OpenAPI document" } } } },
    "/v1/capabilities": { get: operation("capabilities", { type: "object" }) },
    "/v1/accounts": { get: operation("listAccounts", { type: "array", items: ref("Account") }) },
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
    "/v1/artifacts/{id}": { get: { operationId: "downloadArtifact", parameters: [id], responses: { "200": { description: "Artifact owned by this caller", content: { "image/png": { schema: { type: "string", format: "binary" } }, "text/html": { schema: { type: "string" } } } }, default: error } } }
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
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
