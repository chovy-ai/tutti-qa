import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSuite } from "../src/config.ts";
import { loadPlans, validatePlan, type Plan } from "../src/plan.ts";
import { parseCase } from "../src/pos.ts";
import { evaluateCheck, interpolate, selectCases, suiteCases } from "../src/runner.ts";

const node = {
  id: "case-1",
  title: "🔴【P0】确认删除",
  children: [
    { id: "a", title: "前置：删除确认弹窗已弹出；角色：房主；入口：删除按钮" },
    { id: "b", title: "操作：点击删除房间" },
    { id: "c", title: "预期：\n1) 列表展示 ｜ 房间从列表移除\n2) 权限授权 ｜ 其他成员侧同步消失" },
    { id: "d", title: "备注：口径待定" }
  ]
};

test("parseCase 拆出前置、角色、入口与多条预期", () => {
  const parsed = parseCase(node, ["房间管理", "删除房间"]);
  assert.ok(parsed);
  assert.equal(parsed.priority, "P0");
  assert.equal(parsed.title, "确认删除");
  assert.equal(parsed.role, "房主");
  assert.equal(parsed.entry, "删除按钮");
  assert.deepEqual(parsed.expect, ["列表展示 ｜ 房间从列表移除", "权限授权 ｜ 其他成员侧同步消失"]);
});

test("parseCase 单段预期保持为一条，非用例节点返回 null", () => {
  const single = parseCase({ ...node, children: [node.children[0]!, { id: "c", title: "预期：房间创建成功" }] }, []);
  assert.deepEqual(single?.expect, ["房间创建成功"]);
  assert.equal(parseCase({ id: "x", title: "分组", children: [] }, []), null);
});

test("用例内容变化会改变 sourceHash", () => {
  const before = parseCase(node, [])!;
  const after = parseCase({ ...node, children: [...node.children.slice(0, 1), { id: "b", title: "操作：双击删除" }, ...node.children.slice(2)] }, [])!;
  assert.notEqual(before.sourceHash, after.sourceHash);
});

test("validatePlan 要求每条预期都有断言或 uncovered", () => {
  const source = parseCase(node, [])!;
  const plan: Plan = {
    case: source.id,
    title: source.title,
    sourceHash: source.sourceHash,
    mode: "auto",
    actors: ["owner"],
    steps: [{ actor: "owner", n: 1, assert: "房间已移除" }]
  };
  assert.match(validatePlan(plan, source).join(), /预期第 2 条/u);
  assert.deepEqual(validatePlan({ ...plan, uncovered: [{ n: 2, reason: "多人" }] }, source), []);
  assert.match(validatePlan({ ...plan, sourceHash: "stale" }, source).join(), /重新编译/u);
  assert.match(validatePlan({ ...plan, steps: [{ actor: "ghost", act: "x" }] }, source).join(), /未声明的 actor/u);
  assert.match(validatePlan({ ...plan, setup: [{ actor: "owner", n: 1, assert: "x" }] }, source).join(), /setup 中不能有断言/u);
});

test("interpolate 替换变量，缺失变量直接报错", () => {
  const vars = { runId: "abc123", room: { name: "R1" } };
  assert.equal(interpolate("{{runId}}-{{ room.name }}", vars), "abc123-R1");
  assert.throws(() => interpolate("{{room.password}}", vars), /room.password/u);
});

test("evaluateCheck 覆盖全部操作符", () => {
  assert.ok(evaluateCheck("empty", " ", undefined));
  assert.ok(evaluateCheck("nonEmpty", "x", undefined));
  assert.ok(evaluateCheck("equals", "a", "a"));
  assert.ok(evaluateCheck("notEquals", "a", "b"));
  assert.ok(evaluateCheck("contains", "abc", "b"));
  assert.ok(evaluateCheck("notContains", "abc", "z"));
  assert.ok(evaluateCheck("matches", "123456", "^\\d{6}$"));
  assert.ok(!evaluateCheck("matches", "12345", "^\\d{6}$"));
});

test("room-p0 的 Plan 与当前 .pos 一一对应且全部有效", async () => {
  const suite = await loadSuite("room-p0");
  const cases = await suiteCases(suite);
  const plans = await loadPlans(new URL("../plans/room-p0", import.meta.url).pathname);
  assert.equal(plans.length, cases.length);
  for (const { file, plan } of plans) {
    assert.deepEqual(validatePlan(plan, cases.find((item) => item.id === plan.case)), [], file);
  }
});

test("selectCases 支持 id 前缀，未匹配时报错", () => {
  const a = parseCase({ ...node, id: "aaaa1111-x" }, [])!;
  const b = parseCase({ ...node, id: "bbbb2222-y" }, [])!;
  assert.deepEqual(selectCases([a, b], ["bbbb2222"]).map((item) => item.id), ["bbbb2222-y"]);
  assert.equal(selectCases([a, b], undefined).length, 2);
  assert.throws(() => selectCases([a, b], ["cccc"]), /没有匹配/u);
});
