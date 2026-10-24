// ProcessOn .pos 用例库解析。语义与 .claude/skills/tutti-diff-testcase/scripts/pos_tool.py 保持一致：
// 用例节点 = 子节点中同时出现「前置」与「预期」的节点。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type Priority = "P0" | "P1" | "P2";

export interface PosCase {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority | null;
  readonly path: readonly string[];
  readonly pre: string;
  readonly role: string;
  readonly entry: string;
  readonly op: string;
  readonly expect: readonly string[];
  readonly note: string;
  readonly sourceHash: string;
}

interface PosNode {
  readonly id: string;
  readonly title?: string;
  readonly children?: readonly PosNode[];
}

const TAG_RE = /<[^>]+>/g;
const PRIORITY_RE = /^(?:🔴|🟠|🟡)?\s*【(P[012])】\s*/u;
const FIELD_RE = /^(前置|操作|预期|备注)[:：]\s*/u;

export function strip(title: string | undefined): string {
  return (title ?? "")
    .replaceAll("<br>", "\n")
    .replace(TAG_RE, "")
    .replaceAll("&nbsp;", " ")
    .trim();
}

export async function loadPos(file: string): Promise<PosNode> {
  const document = JSON.parse(await readFile(file, "utf8"));
  return document.diagram.elements as PosNode;
}

export function findNode(root: PosNode, id: string): PosNode {
  for (const { node } of walk(root, [])) {
    if (node.id === id) return node;
  }
  throw new Error(`.pos 中找不到节点 ${id}`);
}

export function extractCases(root: PosNode, subtreeIds: readonly string[]): PosCase[] {
  const cases: PosCase[] = [];
  for (const { node, path } of walk(root, [])) {
    if (!path.some((ancestor) => subtreeIds.includes(ancestor.id)) && !subtreeIds.includes(node.id)) continue;
    const parsed = parseCase(node, path.slice(1).map((ancestor) => strip(ancestor.title)));
    if (parsed) cases.push(parsed);
  }
  return cases;
}

export function parseCase(node: PosNode, path: readonly string[]): PosCase | null {
  const fields = new Map<string, string>();
  for (const child of node.children ?? []) {
    const text = strip(child.title);
    const match = FIELD_RE.exec(text);
    if (match) fields.set(match[1]!, text.slice(match[0].length).trim());
  }
  if (!fields.has("前置") || !fields.has("预期")) return null;

  const rawTitle = strip(node.title);
  const priority = (PRIORITY_RE.exec(rawTitle)?.[1] as Priority | undefined) ?? null;
  const title = rawTitle.replace(PRIORITY_RE, "").trim();
  const pre = fields.get("前置")!;
  const op = fields.get("操作") ?? "";
  const expect = splitExpect(fields.get("预期")!);
  const note = fields.get("备注") ?? "";
  return {
    id: node.id,
    title,
    priority,
    path,
    pre,
    role: preField(pre, "角色"),
    entry: preField(pre, "入口"),
    op,
    expect,
    note,
    sourceHash: hashCase({ title, priority, pre, op, expect, note })
  };
}

// 预期是「n) 维度 ｜ 内容」多行，或单段自由文本。
function splitExpect(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 || /^\d+\)/u.test(lines[0] ?? "")) {
    return lines.map((line) => line.replace(/^\d+\)\s*/u, ""));
  }
  return [text.trim()];
}

function preField(pre: string, key: string): string {
  const match = new RegExp(`${key}[:：]([^；;]*)`, "u").exec(pre);
  return match?.[1]?.trim() ?? "";
}

function hashCase(content: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

function* walk(node: PosNode, ancestors: PosNode[]): Generator<{ node: PosNode; path: PosNode[] }> {
  yield { node, path: ancestors };
  for (const child of node.children ?? []) {
    yield* walk(child, [...ancestors, node]);
  }
}
