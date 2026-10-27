import { integer, object, parseSession, requireValue, strings, text, type CreateSession } from "./protocol.ts";

export interface GoalInput {
  mode: "walkthrough" | "test";
  goal: string;
  target?: string;
  accountId?: string;
  selector?: CreateSession["selector"];
  expectations: string[];
  constraints: string[];
  maxSteps: number;
  timeoutSeconds: number;
}

export function parseGoal(raw: unknown): GoalInput {
  const body = object(raw, ["mode", "goal", "target", "accountId", "selector", "expectations", "constraints", "maxSteps", "timeoutSeconds"]);
  requireValue(body.mode === "walkthrough" || body.mode === "test", "mode must be walkthrough or test");
  const session = parseSession({ ...(body.accountId !== undefined ? { accountId: body.accountId } : {}), ...(body.selector !== undefined ? { selector: body.selector } : {}) }, 900, 3600);
  const longStrings = (value: unknown) => {
    requireValue(Array.isArray(value) && value.length <= 20, "Expected at most 20 criteria");
    return value.map((v) => text(v, "criterion", 2000));
  };
  return {
    mode: body.mode as GoalInput["mode"], goal: text(body.goal, "goal", 10_000),
    ...(body.target !== undefined ? { target: text(body.target, "target", 2000) } : {}),
    ...(session.accountId ? { accountId: session.accountId } : { selector: session.selector ?? {} }),
    expectations: body.expectations === undefined ? [] : longStrings(body.expectations),
    constraints: body.constraints === undefined ? [] : longStrings(body.constraints),
    maxSteps: integer(body.maxSteps, 12, 30, "maxSteps"),
    timeoutSeconds: integer(body.timeoutSeconds, 600, 3600, "timeoutSeconds")
  };
}

export interface PlannedAction { type: "act" | "observe" | "screenshot"; instruction: string }
export interface TestPlan { actions: PlannedAction[]; checks: string[]; blockedReason: string }
export function parseTestPlan(raw: unknown, maxSteps: number): TestPlan {
  const plan = object(raw, ["actions", "checks", "blockedReason"]);
  requireValue(Array.isArray(plan.actions) && plan.actions.length <= maxSteps, "Agent plan exceeds action budget");
  const actions = plan.actions.map((v): PlannedAction => {
    const action = object(v, ["type", "instruction"]);
    requireValue(action.type === "act" || action.type === "observe" || action.type === "screenshot", "Unknown internal workflow action");
    return { type: action.type as PlannedAction["type"], instruction: text(action.instruction, "instruction", 2000) };
  });
  requireValue(Array.isArray(plan.checks) && plan.checks.length <= 20, "Invalid agent checks");
  const checks = plan.checks.map((v) => text(v, "check", 2000));
  requireValue(typeof plan.blockedReason === "string", "Invalid blocked reason");
  return { actions, checks, blockedReason: plan.blockedReason as string };
}
