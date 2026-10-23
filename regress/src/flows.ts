// 固定流程库：用例前置条件与清理统一走这里，用代码维护。
// 页面改版时优先修改这里的提示词或实现，Plan 与 .pos 用例不需要跟着改。
import { resolve } from "node:path";
import type { Actor } from "./browser.ts";
import { type EnvProfile, regressRoot } from "./config.ts";
import type { Ledger } from "./ledger.ts";

export interface FlowContext {
  readonly env: EnvProfile;
  readonly runId: string;
  /** 6 位短标识，拼进测试数据名称，便于识别本次 Run 产生的数据 */
  readonly runTag: string;
  readonly caseId: string;
  readonly ledger: Ledger;
}

export type FlowArgs = Readonly<Record<string, string>>;
export type FlowResult = Record<string, string> | void;
type Flow = (ctx: FlowContext, actor: Actor, args: FlowArgs) => Promise<FlowResult>;

const LONG_WAIT = { timeoutMs: 60_000, checkIntervalMs: 3_000 };

/** 新用户登录后进入应用：跳过欢迎页，停在房间列表可见的主界面。由 runner 在创建 actor 后自动调用。 */
export async function enterApp(ctx: FlowContext, actor: Actor): Promise<void> {
  await actor.page.goto(ctx.env.webUrl, { waitUntil: "load" });
  if (/\/auth\/login/u.test(actor.page.url())) {
    throw new Error("session 未生效，被重定向到登录页");
  }
  await actor.agent.aiAct("如果当前是欢迎页或新手引导，点击右上角的 Skip for now（跳过）；如果已经是主界面则不做任何操作");
  await actor.agent.aiWaitFor("页面左侧有房间列表区域（Local rooms / My cloud rooms 或 Rooms 分组）", LONG_WAIT);
}

const flows: Record<string, Flow> = {
  /** 打开新建房间弹窗并停在填写房间信息的步骤（会先选择房间类型）。 */
  async openCreateRoomDialog(_ctx, actor, args) {
    const kind = args.kind ?? "My cloud rooms";
    await actor.agent.aiAct(
      `点击 Create room 按钮，或房间列表分组旁的加号后选择新建房间；如果弹窗要求先选择房间类型，选择「${kind}」并点击 Next`
    );
    await actor.agent.aiWaitFor("新建房间弹窗处于填写房间信息的步骤，能看到房间名称输入框", LONG_WAIT);
  },

  /** 新建房间。keepDefaultName=true 时保留系统默认名称，返回值 name 为实际创建的名称。 */
  async createRoom(ctx, actor, args) {
    await flows.openCreateRoomDialog!(ctx, actor, args);
    let name = args.name ?? `${ctx.runTag}-${Math.random().toString(36).slice(2, 6)}`;
    if (args.keepDefaultName === "true") {
      name = await actor.agent.aiString("房间名称输入框中当前的值");
    } else {
      await actor.agent.aiInput(name, "房间名称输入框", { mode: "replace" });
    }
    await actor.agent.aiAct("点击新建房间弹窗底部的完成或创建按钮");
    await actor.agent.aiWaitFor(`左侧房间列表中出现名为「${name}」的房间`, LONG_WAIT);
    await ctx.ledger.add({ kind: "room", name, owner: actor.name, ownerUserId: actor.loginCode.userId, caseId: ctx.caseId });
    return { name };
  },

  /** 让下一次文件选择器自动选中 fixtures 下的文件（Midscene 无法操作系统文件对话框）。 */
  async armFileChooser(_ctx, actor, args) {
    const file = resolve(regressRoot, "fixtures", need(args, "file"));
    actor.page.once("filechooser", (chooser) => void chooser.setFiles(file));
  },

  async openRoomEditDialog(ctx, actor, args) {
    await flows.openRoomMenu!(ctx, actor, args);
    await actor.agent.aiAct("点击菜单中的编辑（Edit）");
    await actor.agent.aiWaitFor("房间信息编辑弹窗已打开");
  },

  async openRoom(_ctx, actor, args) {
    await actor.agent.aiAct(`在左侧房间列表中点击房间「${need(args, "room")}」进入该房间`);
    await actor.agent.aiWaitFor(`当前打开的是房间「${args.room}」`, LONG_WAIT);
  },

  async openRoomMenu(_ctx, actor, args) {
    await actor.agent.aiAct(`在左侧房间列表中把鼠标悬停在房间「${need(args, "room")}」上，点击条目右侧出现的更多按钮`);
    await actor.agent.aiWaitFor("房间操作菜单已弹出");
  },

  async openRoomInfoPanel(ctx, actor, args) {
    await flows.openRoom!(ctx, actor, args);
    await actor.agent.aiAct(
      [
        "打开房间信息面板：它包含邀请成员（房间链接、密码、允许新成员加入）、成员列表与共享 Agent。",
        "入口可能是右上角的成员头像组、Invite collaborators 按钮，或群聊顶部的 People 下拉；",
        "如果打开的面板不包含这些内容，关闭它再换另一个入口"
      ].join("")
    );
    await actor.agent.aiWaitFor("已打开包含成员列表或邀请设置（房间链接、密码、准入开关）的房间信息面板", LONG_WAIT);
  },

  async setPasswordProtection(ctx, actor, args) {
    const enabled = need(args, "enabled") === "true";
    await flows.openRoomInfoPanel!(ctx, actor, args);
    await actor.agent.aiAct(`在房间信息面板中把密码保护开关设为${enabled ? "打开" : "关闭"}状态；如果已经是该状态则不操作`);
    await actor.agent.aiWaitFor(`密码保护开关处于${enabled ? "打开" : "关闭"}状态`);
  },

  async setAdmission(ctx, actor, args) {
    const enabled = need(args, "enabled") === "true";
    await flows.openRoomInfoPanel!(ctx, actor, args);
    await actor.agent.aiAct(`在房间信息面板中把「允许新成员加入」开关设为${enabled ? "打开" : "关闭"}状态；如果已经是该状态则不操作`);
    await actor.agent.aiWaitFor(`「允许新成员加入」开关处于${enabled ? "打开" : "关闭"}状态`);
  },

  /** 复制邀请信息并读取剪贴板，返回 invite（全文）、link、password（可能为空）。 */
  async copyInvite(ctx, actor, args) {
    await flows.openRoomInfoPanel!(ctx, actor, args);
    await actor.page.evaluate(() => navigator.clipboard.writeText(""));
    await actor.agent.aiAct("点击房间信息面板中的复制邀请信息按钮");
    return flows.readClipboard!(ctx, actor, args);
  },

  /** 读取剪贴板中的邀请信息；用于在当前页面状态下复制（不重新打开面板）的场景。 */
  async readClipboard(_ctx, actor) {
    const invite = await actor.page.evaluate(() => navigator.clipboard.readText());
    if (!invite.trim()) throw new Error("剪贴板为空，复制邀请信息未生效");
    const link = /https?:\/\/\S+/u.exec(invite)?.[0] ?? "";
    const password = /(?<!\d)\d{6}(?!\d)/u.exec(invite.replace(link, ""))?.[0] ?? "";
    return { invite, link, password };
  },

  async clearClipboard(_ctx, actor) {
    await actor.page.evaluate(() => navigator.clipboard.writeText(""));
  },

  /** 通过加入房间弹窗粘贴邀请信息并确认。传 room 时等待加入成功；不传则只提交，由用例自己断言结果。 */
  async joinWithInvite(_ctx, actor, args) {
    await actor.agent.aiAct("打开加入房间弹窗（Join with link，或房间列表分组旁加号菜单中的加入房间）");
    await actor.agent.aiInput(need(args, "invite"), "加入房间弹窗中粘贴链接与密码的输入框", { mode: "replace" });
    await actor.agent.aiAct("点击加入房间弹窗中的确认按钮");
    if (args.room) await actor.agent.aiWaitFor(`已进入房间「${args.room}」，且它出现在左侧房间列表中`, LONG_WAIT);
  },

  async openInviteLink(_ctx, actor, args) {
    await actor.page.goto(need(args, "link"), { waitUntil: "load" });
  },

  async leaveRoom(ctx, actor, args) {
    await flows.openRoomMenu!(ctx, actor, args);
    await actor.agent.aiAct("点击菜单中的离开房间（Leave），在确认弹窗中确认离开");
    await actor.agent.aiWaitFor(`左侧房间列表中不再有房间「${args.room}」`, LONG_WAIT);
  },

  async deleteRoom(ctx, actor, args) {
    await flows.openRoomMenu!(ctx, actor, args);
    await actor.agent.aiAct("点击菜单中的删除（Delete），在确认弹窗中确认删除");
    await actor.agent.aiWaitFor(`左侧房间列表中不再有房间「${args.room}」`, LONG_WAIT);
  }
};

export const flowNames = Object.keys(flows);

export async function runFlow(ctx: FlowContext, actor: Actor, name: string, args: FlowArgs): Promise<FlowResult> {
  const flow = flows[name];
  if (!flow) throw new Error(`未知 flow ${name}`);
  return flow(ctx, actor, args);
}

/**
 * 清理：actor 都是本次 Run 新建的用户，房间列表里只会有测试数据。
 * 房主删除、成员离开，直到列表为空。返回未能清理的房间名。
 */
export async function clearRooms(actor: Actor, env: EnvProfile): Promise<string[]> {
  await actor.page.goto(env.webUrl, { waitUntil: "load" });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rooms = await actor.agent.aiQuery<string[]>("左侧房间列表中所有房间的名称，字符串数组；没有房间时返回空数组");
    if (!Array.isArray(rooms) || rooms.length === 0) return [];
    await actor.agent.aiAct(
      `在左侧房间列表中悬停房间「${rooms[0]}」并点击更多按钮；菜单里有删除（Delete）就删除并确认，只有离开（Leave）就离开并确认`
    );
    await actor.agent.aiWaitFor(`左侧房间列表中不再有房间「${rooms[0]}」`, LONG_WAIT).catch(() => undefined);
  }
  const left = await actor.agent.aiQuery<string[]>("左侧房间列表中所有房间的名称，字符串数组；没有房间时返回空数组");
  return Array.isArray(left) ? left : ["<无法读取房间列表>"];
}

function need(args: FlowArgs, key: string): string {
  const value = args[key];
  if (value === undefined || value === "") throw new Error(`flow 缺少参数 ${key}`);
  return value;
}
