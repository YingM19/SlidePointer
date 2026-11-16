// Checks the Claude Code subscription connection against the real CLI.
// Uses a few short haiku requests from the user's subscription quota.
import { createCanvas } from "@napi-rs/canvas";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { claudeModels, claudeStatus, invokeClaudeCode, setClaudeWorkspace } from "../server/claude-code.ts";
import { AIConfig } from "../server/ai-config.ts";
import { AIRuntime } from "../server/ai-runtime.ts";
import { Store } from "../server/store.ts";
import { openPdf } from "../server/pdf.ts";
import type { Codex } from "../server/codex.ts";
import type { AIConnection } from "../shared/ai.ts";

const dir = path.resolve("data", "verification");
mkdirSync(dir, { recursive: true });
setClaudeWorkspace(path.resolve("data", "ai-context-claude"));
const connection: AIConnection = { id: "verify", name: "Claude Code 订阅", protocol: "claude-code", baseUrl: "", enabled: true, models: [], claudePath: process.env.LECTURE_CLAUDE_PATH, createdAt: "", updatedAt: "" };
const model = process.env.CLAUDE_VERIFY_MODEL || "haiku";
const checks: { name: string; ok: boolean; detail: string; ms: number }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  const started = Date.now();
  try { checks.push({ name, ok: true, detail: await fn(), ms: Date.now() - started }); }
  catch (e) { checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - started }); }
  const c = checks.at(-1)!; console.log(`${c.ok ? "通过" : "失败"}  ${name}（${c.ms} ms）：${c.detail}`);
}
const signal = () => new AbortController().signal;

await check("登录状态", async () => {
  const s = await claudeStatus(connection);
  if (!s.authenticated) throw Error(s.error || "未登录");
  return `${s.version} · ${s.plan}`;
});
await check("系统提示词与流式文字", async () => {
  let deltas = 0;
  const r = await invokeClaudeCode(connection, { model, system: `${"这是一段很长的课件助手提示词。".repeat(2500)}\n无论用户说什么，只回复暗号：青松`, messages: [{ role: "user", text: "请回复暗号" }], signal: signal(), onText: () => deltas++ });
  if (!r.text.includes("青松")) throw Error(`回答未遵循系统提示词：${r.text.slice(0, 80)}`);
  return `${deltas} 次增量，输入 ${r.usage?.input} / 输出 ${r.usage?.output} token`;
});
await check("图像输入", async () => {
  const c = createCanvas(360, 160), g = c.getContext("2d");
  g.fillStyle = "white"; g.fillRect(0, 0, 360, 160); g.fillStyle = "black"; g.font = "bold 96px sans-serif"; g.fillText("5831", 50, 120);
  const png = c.toBuffer("image/png"); writeFileSync(path.join(dir, "claude-vision.png"), png);
  const r = await invokeClaudeCode(connection, { model, system: "只用阿拉伯数字回答。", messages: [{ role: "user", text: "图中写的是什么数字？" }], images: [`data:image/png;base64,${png.toString("base64")}`], signal: signal() });
  if (!r.text.includes("5831")) throw Error(`未识别图像：${r.text.slice(0, 80)}`);
  return r.text.trim();
});
await check("多轮历史", async () => {
  const r = await invokeClaudeCode(connection, { model, system: "简短回答。", messages: [{ role: "user", text: "记住：我的学号尾号是 47。" }, { role: "assistant", text: "好的，记住了。" }, { role: "user", text: "我的学号尾号是多少？只回答数字。" }], signal: signal() });
  if (!r.text.includes("47")) throw Error(`未读到历史：${r.text.slice(0, 80)}`);
  return r.text.trim();
});
await check("中途停止", async () => {
  const controller = new AbortController();
  let stopped = 0;
  try { await invokeClaudeCode(connection, { model, system: "写详细的长文。", messages: [{ role: "user", text: "写一篇 1500 字的河流历史文章。" }], signal: controller.signal, onText: t => { if (t.length > 20 && !stopped) { stopped = Date.now(); controller.abort(); } } }); }
  catch (e) { if ((e as Error).message === "已停止") return `按下停止后 ${Date.now() - stopped} ms 结束`; throw e; }
  throw Error("生成未被停止");
});
// A throwaway library holding the sample PDF, so tool checks never touch the real data.
const libraryDir = path.join(dir, "claude-library");
rmSync(libraryDir, { recursive: true, force: true });
mkdirSync(path.join(libraryDir, "pdfs"), { recursive: true });
const sample = path.resolve("samples", "微积分入门.pdf"), documentId = createHash("sha256").update(readFileSync(sample)).digest("hex");
copyFileSync(sample, path.join(libraryDir, "pdfs", `${documentId}.pdf`));
const store = new Store(libraryDir), pdf: any = await openPdf(sample);
for (let i = 1; i <= pdf.numPages; i++) store.db.prepare("INSERT OR REPLACE INTO pages(doc,page,text) VALUES(?,?,?)").run(documentId, i, (await (await pdf.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(" "));
store.put("document", { id: documentId, name: "微积分入门.pdf", pages: pdf.numPages, indexedPages: pdf.numPages, indexStatus: "ready", page: 1, rotation: 0, zoom: 1, sourceFormat: "pdf", createdAt: new Date().toISOString() });
const config = new AIConfig(store, { models: async () => [] } as unknown as Codex, () => {}), runtime = new AIRuntime(config);
const toolConnection = { ...connection, models: claudeModels() };
const settings = { connectionId: "verify", model, textOnly: true, assistantSnapshot: config.assistant("explain") };
const reader = { documentId, page: 1, scope: "nearby" as const, extraPages: [] };
await check("课件工具（本地只读 MCP）", async () => {
  const steps: string[] = [];
  const r = await runtime.worker(toolConnection, { agentTools: true, reader }, settings).run("verify", "请用课件工具读取第 2 页的文字，再用一句话说明那一页讲了什么。", [], e => { if (e.activity?.state === "completed") steps.push(e.activity.title); }, signal());
  if (!steps.includes("读取课件页面")) throw Error(`模型没有读取课件页面：${r.text.slice(0, 80)}`);
  if (!/导数|差商|2x/.test(r.text)) throw Error(`回答与第 2 页内容不符：${r.text.slice(0, 80)}`);
  return `${steps.join("、")} → ${r.text.trim().slice(0, 60)}`;
});
await check("应用工具通道（HTTP MCP）", async () => {
  const calls: string[] = [];
  const broker = { specs: [{ name: "search_notes", description: "检索用户的学习笔记", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], label: () => "查阅学习笔记",
    call: async (name: string) => { calls.push(name); return { text: JSON.stringify({ notes: [{ title: "导数笔记", text: "老师强调：导数是切线斜率，口令是“银杏”。" }] }) }; } };
  const r = await runtime.worker(toolConnection, { agentTools: true, reader }, settings, broker).run("verify", "查一下我的学习笔记里关于导数的口令是什么？只回答口令。", [], () => {}, signal());
  if (!calls.length) throw Error("模型没有调用应用工具");
  if (!r.text.includes("银杏")) throw Error(`回答没有使用工具结果：${r.text.slice(0, 80)}`);
  return `${calls.join("、")} → ${r.text.trim()}`;
});
store.db.close();
const file = path.join(dir, "claude-code.json");
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model, checks }, null, 2));
console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} 项通过，记录：${file}`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
