// Plan = 一条 .pos 用例的可执行编译结果。落盘在 plans/<suite>/，人工审核后才参与执行。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { flowNames } from "../flows/flows.ts";
import type { PosCase } from "./pos.ts";

export type PlanMode = "auto" | "manual";

export type CheckOp = "empty" | "nonEmpty" | "equals" | "notEquals" | "contains" | "notContains" | "matches";

/**
 * 一个步骤只能是以下之一：
 * - act：自然语言操作，交给 Midscene aiAct
 * - flow：固定流程（代码维护），返回值可 save 到变量表
 * - reload：刷新当前页面
 * - assert：视觉断言（Midscene aiAssert），归属 .pos 预期第 n 条
 * - check：代码断言（对变量做确定性比较），归属 .pos 预期第 n 条
 */
export interface PlanStep {
  readonly actor?: string;
  readonly act?: string;
  /** 仅用于 act：false 表示这一步不进缓存（带「如果…」分支的操作） */
  readonly cache?: boolean;
  readonly flow?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly save?: string;
  readonly reload?: boolean;
  readonly assert?: string;
  readonly check?: { readonly op: CheckOp; readonly left: string; readonly right?: string };
  readonly n?: number;
  /** assert 前等待条件成立的最长时间，用于实时同步、异步创建类断言 */
  readonly waitMs?: number;
}

export interface Plan {
  readonly case: string;
  readonly title: string;
  readonly sourceHash: string;
  readonly mode: PlanMode;
  /** manual 时必填：为什么不能自动化 */
  readonly reason?: string;
  readonly requires?: readonly string[];
  /** 每个名字是一个新用户；name#2 表示同一用户的第二个标签页 */
  readonly actors?: readonly string[];
  /** 前置条件；失败记为 blocked */
  readonly setup?: readonly PlanStep[];
  /** 操作与断言；操作失败记为 failed */
  readonly steps?: readonly PlanStep[];
  /** 无法自动断言的预期条目，报告中列为人工复核 */
  readonly uncovered?: readonly { readonly n: number; readonly reason: string }[];
}

export interface LoadedPlan {
  readonly file: string;
  readonly plan: Plan;
}

export async function loadPlans(dir: string): Promise<LoadedPlan[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".yaml")).sort();
  const plans: LoadedPlan[] = [];
  for (const file of files) {
    const path = join(dir, file);
    plans.push({ file: path, plan: parse(await readFile(path, "utf8")) as Plan });
  }
  return plans;
}

export function stepKind(step: PlanStep): "act" | "flow" | "reload" | "assert" | "check" | null {
  const kinds = (["act", "flow", "reload", "assert", "check"] as const).filter((key) => step[key] !== undefined);
  return kinds.length === 1 ? kinds[0]! : null;
}

export function validatePlan(plan: Plan, source: PosCase | undefined): string[] {
  const problems: string[] = [];
  if (!source) return [`.pos 中已不存在用例 ${plan.case}`];
  if (plan.sourceHash !== source.sourceHash) {
    problems.push(`用例内容已变化（plan ${plan.sourceHash} ≠ pos ${source.sourceHash}），需要重新编译`);
  }
  if (plan.mode === "manual") {
    if (!plan.reason) problems.push("manual plan 缺少 reason");
    return problems;
  }
  const actors = new Set(plan.actors ?? []);
  if (actors.size === 0) problems.push("auto plan 至少需要一个 actor");
  for (const name of actors) {
    const [base] = name.split("#");
    if (name.includes("#") && !actors.has(base!)) problems.push(`标签页 ${name} 缺少对应的用户 ${base}`);
  }
  const covered = new Set<number>();
  const check = (step: PlanStep, phase: "setup" | "steps") => {
    const kind = stepKind(step);
    if (!kind) problems.push(`步骤必须且只能是 act / flow / reload / assert / check 之一：${JSON.stringify(step)}`);
    if (kind !== "check" && (!step.actor || !actors.has(step.actor))) problems.push(`步骤使用了未声明的 actor ${step.actor}`);
    if (kind === "flow" && !flowNames.includes(step.flow!)) problems.push(`未知 flow ${step.flow}`);
    if (step.cache !== undefined && kind !== "act") problems.push(`cache 只能用于 act 步骤：${JSON.stringify(step)}`);
    if (kind === "assert" || kind === "check") {
      if (phase === "setup") problems.push("setup 中不能有断言");
      if (!step.n || step.n < 1 || step.n > source.expect.length) problems.push(`断言的 n 超出预期范围：${step.n}`);
      else covered.add(step.n);
    }
  };
  for (const step of plan.setup ?? []) check(step, "setup");
  for (const step of plan.steps ?? []) check(step, "steps");
  for (const item of plan.uncovered ?? []) covered.add(item.n);
  for (let n = 1; n <= source.expect.length; n += 1) {
    if (!covered.has(n)) problems.push(`预期第 ${n} 条既没有断言也没有标记 uncovered`);
  }
  return problems;
}
