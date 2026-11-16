// Checks the Claude Code subscription connection against the real CLI.
// Uses a few short haiku requests from the user's subscription quota.
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeStatus, invokeClaudeCode, setClaudeWorkspace } from "../server/claude-code.ts";
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
const file = path.join(dir, "claude-code.json");
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model, checks }, null, 2));
console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} 项通过，记录：${file}`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
