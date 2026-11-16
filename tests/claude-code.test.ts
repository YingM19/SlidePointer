import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeContent, claudeEnv, invokeClaudeCode, resolveClaudeCommand, setClaudeWorkspace } from "../server/claude-code.ts";
import { invokeProvider } from "../server/ai-provider.ts";
import type { AIConnection } from "../shared/ai.ts";
import { ClaudeSessionWorker, claudeSessionFile, deleteClaudeSession } from "../server/claude-sessions.ts";
import { Store } from "../server/store.ts";

// A stand-in for claude.exe: records what it received and replays a scripted stream-json session.
const fakeCli = `
import { writeFileSync, readFileSync } from "node:fs";
const mode = process.env.FAKE_MODE || "ok";
let input = "";
process.stdin.on("data", d => input += d);
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const promptFile = args[args.indexOf("--system-prompt-file") + 1];
  const mcpFile = args.includes("--mcp-config") ? args[args.indexOf("--mcp-config") + 1] : "";
  const mcp = mcpFile ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers : null;
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), input: JSON.parse(input), system: readFileSync(promptFile, "utf8"), mcp,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|ANTHROPIC)/i.test(k))) }));
  const out = e => process.stdout.write(JSON.stringify(e) + "\\n");
  out({ type: "system", subtype: "init", apiKeySource: mode === "apikey" ? "ANTHROPIC_API_KEY" : "none", tools: [],
    mcp_servers: Object.keys(mcp || {}).map(name => ({ name, status: mode === "mcpfail" ? "failed" : "connected" })) });
  if (mode === "exit") process.exit(3);
  if (mode === "nosession" && args.includes("--resume") && !args.includes("--fork-session")) { out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: x"] }); process.exit(1); }
  if (mode === "limited") { out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "API Error: 429 rate limit" }); return; }
  const delta = d => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } });
  if (mode === "mcpfail") { setTimeout(() => {}, 30000); return; }
  if (mode === "rogue") { out({ type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Bash", input: { command: "dir" } }] } }); setTimeout(() => {}, 30000); return; }
  if (mode === "tools") {
    // Call the app's tool channel the way the real CLI would, with the configured bearer token.
    const server = mcp.lecture_workspace;
    fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_pages", arguments: { pages: [2] } } }) })
      .then(r => r.json()).then(reply => {
        out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "tu1", name: "mcp__lecture_workspace__read_pages", input: { pages: [2] } }] } });
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: reply.result.content }] } });
        delta({ type: "text_delta", text: "第 2 页讲导数" });
        out({ type: "result", subtype: "success", is_error: false, result: "第 2 页讲导数", usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: { a: { inputTokens: 10, cacheReadInputTokens: 30, cacheCreationInputTokens: 60, outputTokens: 20 }, b: { inputTokens: 5, outputTokens: 5 } } });
      });
    return;
  }
  delta({ type: "thinking_delta", thinking: "secret reasoning" });
  delta({ type: "text_delta", text: "你好" });
  if (mode === "slow") { setTimeout(() => delta({ type: "text_delta", text: "，太慢" }), 30000); return; }
  delta({ type: "text_delta", text: "，世界" });
  out({ type: "assistant", uuid: "assistant-1", message: { content: [{ type: "text", text: "你好，世界" }] } });
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
  await assert.rejects(invokeClaudeCode(connection, request({ tools: [{ name: "x", description: "", inputSchema: {} }] }), { env: env() }), /工具由 CLI 执行/);
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

// Tool rounds run inside the CLI; the worker lends it the app's MCP channel and audits every call.
const doc = "d".repeat(64);
async function workerFixture() {
  const { AIConfig } = await import("../server/ai-config.ts");
  const { AIRuntime } = await import("../server/ai-runtime.ts");
  const { Store } = await import("../server/store.ts");
  const { claudeModels } = await import("../server/claude-code.ts");
  const store = new Store(path.join(dir, `store-${Math.random().toString(36).slice(2)}`));
  const config = new AIConfig(store, { models: async () => [] } as any, () => {});
  const c: AIConnection = { ...connection, models: claudeModels() };
  const settings = { connectionId: c.id, model: "sonnet", assistantSnapshot: config.assistant("explain") };
  return { runtime: new AIRuntime(config), c, settings, store };
}
async function withEnv<T>(mode: string, fn: () => Promise<T>) {
  const saved = { mode: process.env.FAKE_MODE, record: process.env.FAKE_RECORD };
  process.env.FAKE_MODE = mode; process.env.FAKE_RECORD = record;
  try { return await fn(); }
  finally { for (const [k, v] of [["FAKE_MODE", saved.mode], ["FAKE_RECORD", saved.record]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const reader = { documentId: doc, page: 1, scope: "page" as const, extraPages: [] };

test("worker lends the broker over authenticated MCP and reports tool steps and sources", async () => {
  const f = await workerFixture();
  const calls: unknown[] = [];
  const broker = { specs: [{ name: "read_pages", description: "读页", inputSchema: { type: "object" } }], label: () => "读取课件页面",
    call: async (name: string, args: Record<string, unknown>) => { calls.push([name, args]); return { text: JSON.stringify({ sources: [{ id: "s1", documentId: doc, page: 2, text: "导数" }, { id: "s2", documentId: "e".repeat(64), page: 1, text: "别的课件" }] }) }; } };
  const events: any[] = [];
  const worker = f.runtime.worker(f.c, { agentTools: true, reader }, f.settings, broker);
  const thread = await worker.thread("sonnet");
  const result = await withEnv("tools", () => worker.run(thread, "第二页讲什么", [], e => events.push(e)));
  assert.equal(result.text, "第 2 页讲导数");
  assert.deepEqual(calls, [["read_pages", { pages: [2] }]]);
  const steps = events.filter(e => e.activity).map(e => [e.activity.title, e.activity.state, e.activity.detail]);
  assert.deepEqual(steps, [["读取课件页面", "running", "第 2 页"], ["读取课件页面", "completed", "返回 1 处来源"]]);
  assert.deepEqual(events.find(e => e.sources).sources.map((s: any) => s.id), ["s1"], "sources outside the frozen documents are dropped");
  assert.deepEqual(events.find(e => e.tokenUsage).tokenUsage, { input: 105, output: 25, total: 130 });
  const got = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(got.args.slice(got.args.indexOf("--allowedTools") + 1), ["mcp__lecture_workspace__read_pages"]);
  assert.equal(got.mcp.lecture_workspace.type, "http");
  assert.match(got.mcp.lecture_workspace.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
  assert.match(got.system, /只能使用本轮提供的工具/);
  assert.deepEqual(readdirSync(path.join(dir, "workspace")), [], "prompt and MCP files are removed");
  f.store.db.close();
});

test("worker without a broker starts the read-only course reader only when allowed", async () => {
  const f = await workerFixture();
  await withEnv("ok", () => f.runtime.worker(f.c, { agentTools: true, reader, requestId: "q1" }, f.settings).run("t", "问题", [], () => {}));
  let got = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(got.mcp.lecture_reader.command, process.execPath);
  assert.deepEqual(JSON.parse(got.mcp.lecture_reader.args.at(-1)).documentId, doc);
  assert.equal(got.mcp.lecture_reader.env.LECTURE_TOOL_REQUEST, "q1");
  assert.ok(got.args.includes("mcp__lecture_reader__read_pages"));
  await withEnv("ok", () => f.runtime.worker(f.c, { agentTools: false, reader }, f.settings).run("t", "问题", [], () => {}));
  got = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(got.mcp, null);
  assert.ok(!got.args.includes("--allowedTools"));
  const custom = { ...f.c, models: [...f.c.models, { model: "my-model", displayName: "my-model", isDefault: false, defaultReasoningEffort: "", supportedReasoningEfforts: [], custom: true, capabilities: { vision: true, tools: "unknown" as const, reasoning: false } }] };
  await withEnv("ok", () => f.runtime.worker(custom, { agentTools: true, reader }, { ...f.settings, model: "my-model" }).run("t", "问题", [], () => {}));
  assert.equal(JSON.parse(readFileSync(record, "utf8")).mcp, null, "unconfirmed tool support gets no tools");
  f.store.db.close();
});

test("worker stops on unauthorized tools and on a tool channel that fails to start", async () => {
  const f = await workerFixture();
  await assert.rejects(withEnv("rogue", () => f.runtime.worker(f.c, { agentTools: true, reader }, f.settings).run("t", "问题", [], () => {})), /未授权的工具/);
  await assert.rejects(withEnv("mcpfail", () => f.runtime.worker(f.c, { agentTools: true, reader }, f.settings).run("t", "问题", [], () => {})), /工具通道未能启动/);
  f.store.db.close();
});

test("reading sessions start, continue and fork through the CLI's own session store", async () => {
  const store = new Store(path.join(dir, "session-store"));
  try {
    const worker = new ClaudeSessionWorker(store, connection, { system: "阅读助手", effort: "high", env: env("nosession") });
    const id = await worker.thread("sonnet");
    assert.match(id, /^claude:[0-9a-f-]{36}$/);
    // A session that has never run is not found on resume, so it starts under the same id.
    const first = await worker.run(id, "第一批", [], () => {});
    assert.equal(first.text, "你好，世界"); assert.equal(first.turnId, "assistant-1");
    let got = JSON.parse(readFileSync(record, "utf8"));
    const value = (flag: string) => got.args[got.args.indexOf(flag) + 1];
    assert.equal(value("--session-id"), id.slice(7)); assert.ok(!got.args.includes("--no-session-persistence"));
    assert.equal(got.system, "阅读助手"); assert.equal(value("--effort"), "high");
    const child = await worker.fork("sonnet", id, undefined, "assistant-1");
    await worker.run(child, "本章第一批", [], () => {});
    got = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(value("--resume"), id.slice(7)); assert.equal(value("--session-id"), child.slice(7)); assert.equal(value("--resume-session-at"), "assistant-1");
    assert.ok(got.args.includes("--fork-session"));
    assert.equal(store.get("claudeFork", child), undefined, "fork record is cleared once written");
  } finally { store.close(); }
});

test("an interrupted reading request is found in the session file, then the file is removed with its owner", async () => {
  const config = path.join(dir, "claude-config"), id = "claude:11111111-2222-4333-8444-555555555555";
  mkdirSync(path.join(config, "projects", "workspace"), { recursive: true });
  const lines = [
    { type: "user", message: { content: [{ type: "text", text: "[reading-request:t1] 读第一批" }] } },
    { type: "assistant", uuid: "u-1", message: { content: [{ type: "text", text: "第一批笔记" }] } },
    { type: "user", message: { content: "[reading-request:t2] 读第二批" } },
  ];
  writeFileSync(path.join(config, "projects", "workspace", `${id.slice(7)}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n"));
  const store = new Store(path.join(dir, "recover-store"));
  try {
    const worker = new ClaudeSessionWorker(store, connection, { system: "", env: { CLAUDE_CONFIG_DIR: config } });
    const turns = (await worker.rpc("thread/read", { threadId: id })).thread.turns;
    assert.deepEqual(turns.map((t: any) => [t.id, t.status]), [["u-1", "completed"], ["", "failed"]]);
    assert.equal(turns[0].items.at(-1).text, "第一批笔记");
    deleteClaudeSession(id, { CLAUDE_CONFIG_DIR: config });
    assert.equal(claudeSessionFile(id, { CLAUDE_CONFIG_DIR: config }), undefined);
  } finally { store.close(); }
});
