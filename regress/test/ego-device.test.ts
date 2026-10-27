import assert from "node:assert/strict";
import { test } from "node:test";
import { EgoDevice, type EgoPage, type BrowserAction } from "../src/service/ego.ts";

function fixture() {
  const actions: BrowserAction[] = [];
  const page = { async action(action: BrowserAction) { actions.push(action); }, async size() { return { width: 1200, height: 800 }; } } as unknown as EgoPage;
  const device = new EgoDevice(page, () => []);
  return { actions, device };
}

test("Midscene Input 的已定位目标必须先聚焦，再替换内容；不凭当前焦点猜输入框", async () => {
  const { actions, device } = fixture();
  await device.inputPrimitives.keyboard!.typeText("hello", { target: { center: [80, 100] }, replace: true, inputStrategy: "bulk" });
  assert.deepEqual(actions, [
    { type: "tap", x: 80, y: 100 },
    { type: "keyboard", value: "ControlOrMeta+A" }, { type: "keyboard", value: "Backspace" },
    { type: "text", value: "hello" }
  ]);
});

test("按键不带定位时保持已有选区；显式定位和键入延迟遵守输入协议", async () => {
  const { actions, device } = fixture();
  await device.inputPrimitives.keyboard!.keyboardPress("ControlOrMeta+C");
  assert.deepEqual(actions, [{ type: "keyboard", value: "ControlOrMeta+C" }]);
  actions.length = 0;
  await device.inputPrimitives.keyboard!.typeText("hello", { target: { center: [2, 3] }, keyboardTypeDelay: 10 });
  assert.deepEqual(actions, [{ type: "tap", x: 2, y: 3 }, { type: "type", value: "hello", delay: 10 }]);
  await assert.rejects(device.inputPrimitives.keyboard!.clearInput({ prompt: "unresolved" }));
});

test("Scroll 保留定位区域和滚动边界语义，不把滚动到底部降级为单次默认方向", async () => {
  const { actions, device } = fixture();
  await device.inputPrimitives.scroll!.scroll({ direction: "right", distance: 120, scrollType: "scrollToTop", locate: { center: [30, 40] } } as Parameters<NonNullable<typeof device.inputPrimitives.scroll>["scroll"]>[0]);
  assert.deepEqual(actions, [{ type: "scroll", x: 0, y: -1000, startX: 30, startY: 40, repeat: 10 }]);
  actions.length = 0;
  await device.inputPrimitives.scroll!.scroll({ direction: "right", distance: 120, scrollType: "singleAction" });
  assert.deepEqual(actions, [{ type: "scroll", x: 120, y: 0 }]);
});
