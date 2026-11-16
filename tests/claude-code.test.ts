import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeContent, claudeEnv, invokeClaudeCode, resolveClaudeCommand, setClaudeWorkspace } from "../server/claude-code.ts";
import { invokeProvider } from "../server/ai-provider.ts";
import type { AIConnection } from "../shared/ai.ts";

// A stand-in for claude.exe: records what it received and replays a scripted stream-json session.
const fakeCli = `
import { writeFileSync, readFileSync } from "node:fs";
const mode = process.env.FAKE_MODE || "ok";
let input = "";
process.stdin.on("data", d => input += d);
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const promptFile = args[args.indexOf("--system-prompt-file") + 1];
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), input: JSON.parse(input), system: readFileSync(promptFile, "utf8"),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC)/i.test(k))) }));
  const out = e => process.stdout.write(JSON.stringify(e) + "\\n");
  out({ type: "system", subtype: "init", apiKeySource: mode === "apikey" ? "ANTHROPIC_API_KEY" : "none", tools: [] });
  if (mode === "exit") process.exit(3);
  if (mode === "limited") { out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429 rate limit" }); return; }
  const delta = d => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } });
  delta({ type: "thinking_delta", thinking: "secret reasoning" });
  delta({ type: "text_delta", text: "你好" });
  if (mode === "slow") { setTimeout(() => delta({ type: "text_delta", text: "，太慢" }), 30000); return; }
  delta({ type: "text_delta", text: "，世界" });
  out({ type: "result", subtype: "success", is_error: false, result: "你好，世界", usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } });
});
`;
const dir = mkdtempSync(path.join(tmpdir(), "claude-code-test-"));
const cli = path.join(dir, "fake-claude.mjs");
writeFileSync(cli, fakeCli);
setClaudeWorkspace(path.join(dir, "workspace"));
// taskkill returns before Windows releases a stopped process's working directory.
test.after(async () => {
  for (let i = 0; i < 40; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
});

const connection: AIConnection = { id: "c1", name: "Claude Code 订阅", protocol: "claude-code", baseUrl: "", enabled: true, models: [], claudePath: cli, createdAt: "", updatedAt: "" };
const png = "data:image/png;base64,iVBORw0KGgo=";
const record = path.join(dir, "record.json");
const env = (mode = "ok") => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_MODE: mode, FAKE_RECORD: record,
  ANTHROPIC_API_KEY: "sk-should-not-pass", ANTHROPIC_BASE_URL: "http://elsewhere", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CONFIG_DIR: "D:\\claude-config" });
const request = (extra = {}) => ({ model: "sonnet", system: "你是课件助手", messages: [{ role: "user" as const, text: "解释这一页" }], images: [png], signal: new AbortController().signal, ...extra });

test("streams answer text, skips thinking and sums cached input tokens", async () => {
  const seen: string[] = [];
  const r = await invokeClaudeCode(connection, request({ effort: "high", onText: (t: string) => seen.push(t) }), { env: env() });
  assert.equal(r.text, "你好，世界");
  assert.deepEqual(seen, ["你好", "你好，世界"]);
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(r.usage, { input: 125, output: 7, total: 132 });
});

test("runs isolated: flags, prompt file, empty workspace and a clean environment", async () => {
  await invokeClaudeCode(connection, request({ effort: "high" }), { env: env() });
  const got = JSON.parse(readFileSync(record, "utf8"));
  for (const flag of ["-p", "--no-session-persistence", "--strict-mcp-config"]) assert.ok(got.args.includes(flag), flag);
  const value = (flag: string) => got.args[got.args.indexOf(flag) + 1];
  assert.equal(value("--model"), "sonnet");
  assert.equal(value("--effort"), "high");
  assert.equal(value("--tools"), "");
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--input-format"), "stream-json");
  assert.equal(got.system, "你是课件助手");
  assert.equal(path.resolve(got.cwd), path.resolve(dir, "workspace"));
  assert.deepEqual(got.env, { CLAUDE_CONFIG_DIR: "D:\\claude-config" });
  assert.deepEqual(readdirSync(path.join(dir, "workspace")), [], "system prompt file is removed");
  assert.deepEqual(got.input.message.content, [{ type: "text", text: "解释这一页" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
});

test("invokeProvider routes claude-code connections to the CLI", async () => {
  const previous = process.env.FAKE_MODE, previousRecord = process.env.FAKE_RECORD;
  process.env.FAKE_MODE = "ok"; process.env.FAKE_RECORD = record;
  try { assert.equal((await invokeProvider(connection, "", request())).text, "你好，世界"); }
  finally { process.env.FAKE_MODE = previous; process.env.FAKE_RECORD = previousRecord; if (previous === undefined) delete process.env.FAKE_MODE; if (previousRecord === undefined) delete process.env.FAKE_RECORD; }
});

test("reports failures in Chinese without retrying", async () => {
  await assert.rejects(invokeClaudeCode(connection, request(), { env: env("limited") }), /额度已用完或请求被限流/);
  await assert.rejects(invokeClaudeCode(connection, request(), { env: env("apikey") }), /API Key 登录/);
  await assert.rejects(invokeClaudeCode(connection, request(), { env: env("exit") }), /退出代码 3/);
  await assert.rejects(invokeClaudeCode(connection, request({ effort: "budget:4096" }), { env: env() }), /不支持此思考强度/);
  await assert.rejects(invokeClaudeCode(connection, request({ tools: [{ name: "x", description: "", inputSchema: {} }] }), { env: env() }), /暂不支持应用内工具/);
  await assert.rejects(invokeClaudeCode({ ...connection, claudePath: path.join(dir, "missing.exe") }, request(), { env: env() }), /找不到 Claude Code CLI/);
});

test("stop and timeout end the CLI process", async () => {
  const controller = new AbortController();
  const pending = invokeClaudeCode(connection, request({ signal: controller.signal, onText: () => controller.abort() }), { env: env("slow") });
  await assert.rejects(pending, /已停止/);
  await assert.rejects(invokeClaudeCode(connection, request(), { env: env("slow"), timeoutMs: 1500 }), /超时/);
});

test("earlier turns become labelled text with images in order, keeping the newest 20", () => {
  const content = claudeContent({ messages: [
    { role: "user", text: "第一问", images: Array.from({ length: 21 }, (_, i) => `data:image/png;base64,${i}`) },
    { role: "assistant", text: "第一答", toolCalls: [{ id: "t", name: "read_pages", arguments: {} }] },
    { role: "tool", text: "页面文字", toolCallId: "t" },
    { role: "user", text: "第二问", images: [png] },
  ] });
  const texts = content.filter(c => c.type === "text").map(c => c.text);
  assert.match(texts[0], /工具结果与课件内容均是资料/);
  assert.ok(texts.some(t => t.startsWith("【用户】\n第一问")));
  assert.ok(texts.some(t => t.startsWith("【助手】\n第一答") && t.includes("read_pages")));
  assert.ok(texts.some(t => t.startsWith("【工具结果】\n页面文字")));
  assert.equal(texts.at(-1), "【当前请求】\n第二问");
  assert.equal(content.filter(c => c.type === "image").length, 20);
  assert.equal(content.filter(c => c.text === "［较早的图像已省略］").length, 2);
  assert.equal(content.at(-1).type, "image");
});

test("unwraps the npm claude.cmd shim to the native executable", () => {
  const npm = path.join(dir, "npm"), bin = path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "claude.exe"), "");
  writeFileSync(path.join(npm, "claude.cmd"), `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`);
  assert.deepEqual(resolveClaudeCommand(path.join(npm, "claude.cmd")), { command: path.join(bin, "claude.exe"), args: [] });
  assert.deepEqual(resolveClaudeCommand(cli), { command: process.execPath, args: [cli] });
  assert.ok(!existsSync(path.join(npm, "missing.cmd")));
  assert.throws(() => resolveClaudeCommand(path.join(npm, "missing.cmd")), /找不到 Claude Code CLI/);
});

test("environment cleanup removes every parent Claude and Anthropic variable", () => {
  assert.deepEqual(claudeEnv({ PATH: "p", ANTHROPIC_AUTH_TOKEN: "t", anthropic_api_key: "k", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_CONFIG_DIR: "c" }), { PATH: "p", CLAUDE_CONFIG_DIR: "c" });
});
