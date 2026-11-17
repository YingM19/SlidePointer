import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PDFDocument } from "pdf-lib";
import { Store } from "../server/store.ts";
import { CourseService } from "../server/courses.ts";
import { ContinuousKnowledgeReader, parseSections, readingBatches, sectionBatches } from "../server/knowledge-reader.ts";
import { PersistentKnowledgeRuntime, type ReadInput, type KnowledgeEngine } from "../server/knowledge-runtime.ts";
import { checkpoint, createReadingSession, readingHistory, resolveReadingSeed } from "../server/knowledge-sessions.ts";
import { ReadingService } from "../server/reading.ts";
import { Lifecycle } from "../server/lifecycle.ts";
import { captureKnowledge } from "../server/learning-context.ts";
import { Scheduler } from "../server/scheduler.ts";
import type { AIConfig } from "../server/ai-config.ts";
import type { ImportManager } from "../server/imports.ts";
import { Codex } from "../server/codex.ts";
import type { ContextSnapshot, Document, KnowledgeReadSession, KnowledgeReadTurn, KnowledgeRevision } from "../shared/types.ts";

function fixture(counts = [12, 6]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reading-v4-"));
  const store = new Store(dir); mkdirSync(path.join(dir, "attachments"));
  const docs = counts.map((pages, i) => ({ id: String.fromCharCode(97 + i).repeat(64), name: `${i + 1}.pdf`, pages, indexedPages: pages, indexStatus: "ready", page: 1, rotation: 0, zoom: 1, createdAt: new Date().toISOString() } as Document));
  for (const d of docs) { store.put("document", d); for (let p = 1; p <= d.pages; p++) store.page(d.id, p, `page ${p}`); }
  const courses = new CourseService(store, {} as ImportManager, () => {}), course = courses.create("测试课程", docs.map(d => d.id));
  const calls: { sessionId: string; input: ReadInput }[] = [];
  let before: (s: KnowledgeReadSession, input: ReadInput) => void = () => {};
  let after: (s: KnowledgeReadSession, input: ReadInput) => void = () => {};
  let closes = 0;
  const factory = (): KnowledgeEngine => ({
    outline: async () => "课程目录",
    close: async () => { closes++; },
    read: async (sid, input, signal) => {
      signal.throwIfAborted();
      const s = store.get<KnowledgeReadSession>("knowledgeSession", sid)!;
      const done = s.turns.find(t => t.key === input.key && t.state === "completed"); if (done) return done;
      calls.push({ sessionId: sid, input: structuredClone(input) }); before(s, input);
      const sources = input.sources || s.turns.flatMap(t => t.sources);
      const answer = input.pages?.length ? input.pages.map(p => `### 第${p}页\n[page ${p}](source:${sources.find(s => s.page === p)?.id})`).join("\n") : `成果 ${input.key}\n` + sources.slice(0, 2).map(s => `[page ${s.page}](source:${s.id})`).join("\n");
      const t: KnowledgeReadTurn = { id: randomUUID(), key: input.key, prompt: input.prompt, answer, sources, pages: input.pages || [], images: [], state: "completed", runtimeTurnId: randomUUID() };
      s.turns.push(t); s.threadId ||= `thread-${s.id}`;
      s.completedPages = [...new Set([...s.completedPages, ...(input.completePages || [])])];
      s.checkpoint = checkpoint(s, "fork"); store.put("knowledgeSession", s); after(s, input); return t;
    },
  });
  const revision = (documentIds = docs.map(d => d.id)) => store.put<KnowledgeRevision>("knowledge", { id: randomUUID(), courseId: course.id, documentIds, courseDocumentIds: docs.map(d => d.id), state: "building", settings: { connectionId: "codex", model: "test", reasoningEffort: "low" }, chapters: documentIds.map(documentId => ({ documentId, summary: "", state: "queued", total: store.document(documentId)!.pages })), pages: [], summary: "", total: documentIds.reduce((n, d) => n + store.document(d)!.pages, 0), createdAt: new Date().toISOString(), cacheVersion: "reading-v4" });
  const reader = new ContinuousKnowledgeReader(store, courses, factory, r => store.put("knowledge", r));
  return { dir, store, docs, course, courses, calls, revision, reader, factory, setBefore(fn: typeof before) { before = fn; }, setAfter(fn: typeof after) { after = fn; }, closes: () => closes, close() { courses.close(); store.close(); assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(), "reading-v4-"))); rmSync(dir, { recursive: true, force: true }); } };
}

test("60页图文完整覆盖，仅10批读取；后一章从前面章节成果写入课程后的检查点开始", async () => {
  const f = fixture([60, 6]);
  try {
    const r = f.revision(); await f.reader.run(r.id, new AbortController().signal);
    const result = f.store.get<KnowledgeRevision>("knowledge", r.id)!;
    assert.equal(result.state, "completed"); assert.equal(result.pages.length, 66);
    const reads = f.calls.filter(c => c.input.key.startsWith("batch:"));
    const first = reads.filter(c => c.input.sources?.[0].documentId === f.docs[0].id);
    assert.equal(first.length, 10); assert.ok(first.every(c => c.input.sources?.every(s => s.image)));
    assert.deepEqual(first.flatMap(c => c.input.pages), Array.from({ length: 60 }, (_, i) => i + 1));
    const children = result.chapters.map(c => f.store.get<KnowledgeReadSession>("knowledgeSession", c.sessionId!)!);
    assert.equal(children[0].parent!.through, result.baseCheckpoint!.through, "第一章从课程框架开始");
    assert.ok(children[1].parent!.through > children[0].parent!.through);
    assert.ok(readingHistory(f.store, children[1].parent).some(h => h.prompt.includes(`《${f.docs[0].name}》章节成果`)), "第二章继承第一章成果");
    assert.equal(new Set(first.map(c => c.sessionId)).size, 1);
    const integrations = f.calls.filter(c => c.input.key.startsWith("integrate:"));
    assert.equal(integrations.length, 2);
    // The second update carries the first summary and must cover both chapters, not just the newest.
    assert.match(integrations[1].input.prompt, new RegExp(`必须覆盖以下全部已整理章节，按课程顺序：《${f.docs[0].name}》、《${f.docs[1].name}》`));
    assert.ok(integrations[1].input.prompt.includes(`当前课程汇总（需在此基础上更新，保留其他章节内容）：
成果 integrate:${r.id}:${f.docs[0].id}`)); assert.ok(integrations.every(c => c.sessionId === result.courseSessionId && c.input.sources?.every(s => !s.image)));
    assert.equal(result.checkpoint?.completed, 66); assert.equal(f.closes(), 1);
    const frozen = structuredClone(children[0].parent!);
    assert.ok(readingHistory(f.store, frozen).every(h => !h.prompt.includes("更新整门课程的课程汇总")));
  } finally { f.close(); }
});

test("长页面分段不截断、完成最后一段才计入覆盖", () => {
  const text = "甲".repeat(50001), batches = readingBatches([{ page: 1, text }, { page: 2, text: "图表" }]);
  assert.equal(batches.flat().filter(p => p.page === 1).map(p => p.text).join(""), text);
  assert.ok(batches.every(b => b.reduce((n, p) => n + p.text.length, 0) <= 24000 && b.length <= 6));
  assert.deepEqual(batches.flat().filter(p => p.part === p.parts - 1).map(p => p.page), [1, 2]);
});

test("取消发生在模型结果保存后，恢复补存进度且不重复批次", async () => {
  const f = fixture([12]); const controller = new AbortController();
  try {
    f.setAfter((_s, i) => { if (i.key === "batch:0") controller.abort(); });
    const r = f.revision(); await f.reader.run(r.id, controller.signal);
    assert.equal(f.store.get<KnowledgeRevision>("knowledge", r.id)?.state, "paused");
    const seed = resolveReadingSeed(f.store, f.course.id, f.docs[0].id)!;
    assert.equal(seed.completed, 6);
    f.setAfter(() => {}); await f.reader.run(r.id, new AbortController().signal);
    const result = f.store.get<KnowledgeRevision>("knowledge", r.id)!;
    assert.equal(result.state, "completed"); assert.equal(result.pages.length, 12);
    assert.equal(f.calls.filter(c => c.input.key === "batch:0").length, 1);
    assert.equal(seed.completed, 6); assert.equal(seed.through, 2, "本章规划与第一批");
    assert.equal(f.closes(), 2);
  } finally { f.close(); }
});

test("普通失败停在当前章，后续章节继续；只重试未完成批次", async () => {
  const f = fixture();
  try {
    let fail = true;
    f.setBefore((s, i) => { if (fail && s.documentId === f.docs[0].id && i.key === "batch:1") throw Error("连接中断"); });
    const r = f.revision(); await f.reader.run(r.id, new AbortController().signal);
    const partial = f.store.get<KnowledgeRevision>("knowledge", r.id)!;
    assert.equal(partial.state, "partial"); assert.equal(partial.chapters[0].completed, 6); assert.equal(partial.chapters[1].state, "completed");
    fail = false; await f.reader.run(r.id, new AbortController().signal);
    assert.equal(f.store.get<KnowledgeRevision>("knowledge", r.id)?.state, "completed");
    assert.equal(f.calls.filter(c => c.input.key === "batch:0").length, 2, "每章第一批只调用一次");
    assert.equal(f.calls.filter(c => c.input.key.startsWith("integrate:") && c.input.key.endsWith(f.docs[1].id)).length, 1);
  } finally { f.close(); }
});

test("输入过大拆分计划持久化，重启不会重新发送已失败的大批次", async () => {
  const f = fixture([6]); const controller = new AbortController();
  try {
    f.setBefore((_s, i) => { if ((i.pages?.length || 0) > 3) throw Error("input too large"); });
    f.setAfter((_s, i) => { if (i.key === "batch:0:a") controller.abort(); });
    const r = f.revision(); await f.reader.run(r.id, controller.signal);
    f.setAfter(() => {}); await f.reader.run(r.id, new AbortController().signal);
    assert.equal(f.store.get<KnowledgeRevision>("knowledge", r.id)?.pages.length, 6);
    assert.equal(f.calls.filter(c => c.input.key === "batch:0").length, 1);
    assert.equal(f.calls.filter(c => c.input.key === "batch:0:a").length, 1);
  } finally { f.close(); }
});

test("默认优先章节，未读章回退课程；来源移除后拒绝旧线程", async () => {
  const f = fixture();
  try {
    const r = f.revision([f.docs[0].id]); await f.reader.run(r.id, new AbortController().signal);
    assert.equal(resolveReadingSeed(f.store, f.course.id, f.docs[0].id)?.title, f.docs[0].name);
    assert.match(resolveReadingSeed(f.store, f.course.id, f.docs[1].id)!.title, /课程总览/);
    f.courses.save({ ...f.courses.get(f.course.id), selectedDocumentIds: [f.docs[0].id] });
    assert.equal(resolveReadingSeed(f.store, f.course.id, f.docs[0].id), undefined);
    assert.equal(captureKnowledge(f.store, f.course.id, [f.docs[0].id]).summary, "");
  } finally { f.close(); }
});

test("复用完整章节不重复生成，课程成果保留其他章节；模型变化建立新版本", async () => {
  const f = fixture([6, 6]);
  try {
    const first = f.revision(); await f.reader.run(first.id, new AbortController().signal);
    const calls = f.calls.length, original = f.store.get<KnowledgeRevision>("knowledge", first.id)!;
    const reused = f.revision([f.docs[0].id]); await f.reader.run(reused.id, new AbortController().signal);
    const result = f.store.get<KnowledgeRevision>("knowledge", reused.id)!;
    assert.equal(f.calls.length, calls); assert.equal(result.reused, 6);
    assert.equal(result.summary, original.summary); assert.equal(result.overviewChapters?.length, 2); assert.equal(result.checkpoint?.completed, 12);
    const changed = f.revision([f.docs[0].id]); changed.settings.model = "another-model"; f.store.put("knowledge", changed);
    await f.reader.run(changed.id, new AbortController().signal);
    assert.notEqual(f.store.get<KnowledgeRevision>("knowledge", changed.id)?.courseSessionId, result.courseSessionId);
  } finally { f.close(); }
});

test("仅汇总时跳过尚未整理的章节，覆盖率不把预览算作已读", async () => {
  const f = fixture([6, 6]);
  try {
    const first = f.revision([f.docs[0].id]); await f.reader.run(first.id, new AbortController().signal);
    const overview = f.revision(); overview.mode = "overview"; overview.chapters = f.store.get<KnowledgeRevision>("knowledge", first.id)!.chapters; f.store.put("knowledge", overview);
    await f.reader.run(overview.id, new AbortController().signal);
    const result = f.store.get<KnowledgeRevision>("knowledge", overview.id)!;
    assert.equal(result.state, "completed"); assert.equal(result.checkpoint?.completed, 6); assert.equal(result.checkpoint?.total, 12);
    assert.equal(f.calls.filter(c => c.input.key.startsWith("batch:")).length, 1);
  } finally { f.close(); }
});

test("解释窗冻结章节起点，子窗及转为正式对话保留该起点", async () => {
  const f = fixture([6]);
  try {
    const r = f.revision(); await f.reader.run(r.id, new AbortController().signal);
    const reading = new ReadingService(f.store, async () => {}, () => {}, () => {}, () => {});
    const input = { id: randomUUID(), courseId: f.course.id, selection: { id: randomUUID(), kind: "text" as const, documentId: f.docs[0].id, page: 1, rotation: 0, text: "概念" }, settings: {}, layout: { x: 0, y: 0, width: 400, height: 400, minimized: false } };
    const parent = reading.create(input), child = reading.create({ ...input, id: randomUUID(), parentId: parent.id });
    assert.deepEqual(child.readingSeed, parent.readingSeed);
    assert.deepEqual(f.store.get<ContextSnapshot>("context", child.contextId)?.readingSeed, parent.readingSeed);
    assert.deepEqual(reading.promote(child.id).readingSeed, parent.readingSeed);
  } finally { f.close(); }
});

test("已有历史与分支引用保留阅读线程及附件，无引用时才清理", async () => {
  const f = fixture([6]);
  try {
    const r = f.revision(); await f.reader.run(r.id, new AbortController().signal);
    const seed = resolveReadingSeed(f.store, f.course.id, f.docs[0].id)!;
    const s = f.store.get<KnowledgeReadSession>("knowledgeSession", seed.sessionId)!;
    const image = `${randomUUID()}-0.png`; writeFileSync(path.join(f.dir, "attachments", image), "image");
    s.turns[0].images.push(image); f.store.put("knowledgeSession", s);
    f.store.put("ownedThread", { id: s.threadId!, ownerId: s.id });
    const c = f.store.put("conversation", { id: randomUUID(), documentId: f.docs[0].id, title: "分支", createdAt: new Date().toISOString(), readingSeed: seed });
    const lifecycle = new Lifecycle(f.store, {} as Codex, () => {}, () => {});
    f.store.remove("knowledge", r.id); lifecycle.collect();
    assert.ok(existsSync(path.join(f.dir, "attachments", image))); assert.equal(lifecycle.pendingCleanup().length, 0);
    f.store.remove("conversation", c.id); lifecycle.collect();
    assert.equal(existsSync(path.join(f.dir, "attachments", image)), false); assert.equal(lifecycle.pendingCleanup().length, 1);
  } finally { f.close(); }
});

function config(protocol = "codex", contextWindow = 32000): AIConfig {
  return { resolve: async (settings: object) => ({ settings: { ...settings, model: "test", connectionId: protocol }, connection: { id: protocol, protocol }, model: { model: "test", contextWindow } }), usage: () => {}, vault: { get: async () => "" } } as unknown as AIConfig;
}

test("fork直接读取完成边界，不恢复仍由阅读进程持有的源线程", async t => {
  const f = fixture([1]); const methods: string[] = [];
  t.mock.method(Codex.prototype, "connect", async () => {});
  t.mock.method(Codex.prototype, "thread", async () => { throw Error("源线程已有活动写入者"); });
  t.mock.method(Codex.prototype, "rpc", async (method: string, params: any) => {
    methods.push(method);
    if (method === "thread/fork") { assert.equal(params.threadId, "source"); assert.equal(params.lastTurnId, "completed-turn"); return { thread: { id: "child" } }; }
    return {};
  });
  try { assert.equal(await new Codex(f.dir).fork("test", "source", undefined, "completed-turn"), "child"); assert.deepEqual(methods, ["thread/fork", "thread/unsubscribe"]); }
  finally { f.close(); }
});

test("源轮次仍进行中时保留待核对状态，不发送第二次请求", async () => {
  const f = fixture([1]); let sends = 0;
  const worker = { thread: async () => "remote", shutdown: async () => {}, rpc: async () => ({ thread: { turns: [{ id: "pending", status: "inProgress" }] } }), run: async () => { sends++; throw Error("should not run"); } } as unknown as Codex;
  const engine = new PersistentKnowledgeRuntime(f.store, config(), new Scheduler(), { worker: () => worker });
  try {
    const s = createReadingSession(f.store, f.course.id, [f.docs[0].id], { model: "test" }, "章节", 1, f.docs[0].id);
    s.threadId = "remote"; s.turns.push({ id: randomUUID(), key: "batch:0", prompt: "读取", answer: "", images: [], sources: [], pages: [1], state: "pending", runtimeTurnId: "pending" }); f.store.put("knowledgeSession", s);
    await assert.rejects(engine.read(s.id, { key: "batch:0", prompt: "读取", completePages: [1] }, new AbortController().signal), /仍在模型端处理/);
    assert.equal(sends, 0); assert.equal(f.store.get<KnowledgeReadSession>("knowledgeSession", s.id)?.checkpoint, undefined);
  } finally { await engine.close(); f.close(); }
});

for (const notifyStart of [true, false]) test(`模型完成后连接丢失：${notifyStart ? "按轮次" : "按请求标识"}核对，不重复推理`, async () => {
  const f = fixture([1]);
  let calls = 0; let prompt = "";
  const worker = {
    thread: async (_m: string, id?: string) => id || "remote-thread",
    fork: async () => "fork", shutdown: async () => {},
    run: async (_id: string, text: string, _images: string[], event: (e: { turnId: string }) => void) => { calls++; prompt = text; if (notifyStart) event({ turnId: "remote-turn" }); throw Error("connection lost after completion"); },
    rpc: async () => ({ thread: { turns: [{ id: "remote-turn", status: "completed", items: [{ type: "userMessage", text: prompt }, { type: "agentMessage", phase: "final_answer", text: "远端已完成" }] }] } }),
  } as unknown as Codex;
  const engine = new PersistentKnowledgeRuntime(f.store, config(), new Scheduler(), { worker: () => worker });
  try {
    const session = createReadingSession(f.store, f.course.id, [f.docs[0].id], { model: "test" }, "章节", 1, f.docs[0].id);
    const input = { key: "batch:0", prompt: "读取", pages: [1], completePages: [1] };
    await assert.rejects(engine.read(session.id, input, new AbortController().signal), /connection lost/);
    assert.equal(f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)?.checkpoint, undefined);
    await engine.close();
    const resumed = new PersistentKnowledgeRuntime(f.store, config(), new Scheduler(), { worker: () => worker });
    try {
      const result = await resumed.read(session.id, input, new AbortController().signal);
      assert.equal(result.answer, "远端已完成"); assert.equal(calls, 1);
      assert.equal(f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)?.checkpoint?.completed, 1);
    } finally { await resumed.close(); }
  } finally { await engine.close(); f.close(); }
});

test("API连接重放文字历史、只发送当前批图像，超过预算时保存压缩检查点", async () => {
  const f = fixture([1]); const requests: any[] = [];
  const engine = new PersistentKnowledgeRuntime(f.store, config("openai", 5000), new Scheduler(), { invoke: async (_connection, _key, input) => { requests.push(structuredClone(input.messages)); return { text: input.messages[0].text.includes("压缩") ? "压缩记忆 [依据](source:page-one)" : "已读 [依据](source:page-one)", toolCalls: [] }; } });
  try {
    const session = createReadingSession(f.store, f.course.id, [f.docs[0].id], { connectionId: "openai", model: "test" }, "章节", 1, f.docs[0].id);
    mkdirSync(path.join(f.dir, "pdfs"));
    const pdf = await PDFDocument.create(); pdf.addPage([400, 300]).drawText("VISUAL PAGE ONE", { x: 20, y: 200 });
    writeFileSync(path.join(f.dir, "pdfs", `${f.docs[0].id}.pdf`), await pdf.save());
    await engine.read(session.id, { key: "one", prompt: "第一批", sources: [{ id: "page-one", documentId: f.docs[0].id, page: 1, text: "原文信息", image: true }] }, new AbortController().signal);
    await engine.read(session.id, { key: "two", prompt: "第二批" }, new AbortController().signal);
    assert.ok(JSON.stringify(requests[1]).includes("原文信息")); assert.equal(requests[1][1].role, "assistant");
    assert.match(requests[0][0].images[0], /^data:image\/png;base64,/);
    assert.equal(requests[1][0].images, undefined, "旧批次不重复上传图像");
    assert.match(requests[1][0].text, /只保留文字与笔记/);
    const s = f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)!;
    s.turns[0].prompt = "长历史".repeat(4000); f.store.put("knowledgeSession", s);
    await engine.read(session.id, { key: "three", prompt: "第三批" }, new AbortController().signal);
    assert.ok(requests.some(messages => messages[0].text.includes("压缩为可继续阅读")));
    const done = f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)!;
    assert.equal(done.checkpoint?.mode, "context"); assert.equal(done.checkpoint?.compressed, true);
    assert.ok(done.turns[0].prompt.length > 10000, "原始记录仍完整保留");
  } finally { await engine.close(); f.close(); }
});

test("未声明上下文长度的 Claude API 模型按 200k 计算，读完长章节也不压缩", async () => {
  const f = fixture([1]); let compactions = 0, calls = 0;
  const claude = { resolve: async (settings: object) => ({ settings: { ...settings, model: "sonnet", connectionId: "claude" }, connection: { id: "claude", protocol: "anthropic" }, model: { model: "claude-sonnet-4-5" } }), usage: () => {}, vault: { get: async () => "" } } as unknown as AIConfig;
  const engine = new PersistentKnowledgeRuntime(f.store, claude, new Scheduler(), { invoke: async (_c, _k, input) => { calls++; if (input.messages[0].text.includes("压缩为可继续阅读")) compactions++; return { text: "本批笔记".repeat(300), toolCalls: [] }; } });
  try {
    const session = createReadingSession(f.store, f.course.id, [f.docs[0].id], { connectionId: "claude", model: "sonnet" }, "章节", 114, f.docs[0].id);
    // 19 batches of six pages, each with a full page of text, is a 100+ page chapter.
    for (let b = 0; b < 19; b++) await engine.read(session.id, { key: `batch:${b}`, prompt: `第${b + 1}批`, sources: Array.from({ length: 6 }, (_, i) => ({ id: `p${b * 6 + i + 1}`, documentId: f.docs[0].id, page: b * 6 + i + 1, text: "页面原文".repeat(150) })) }, new AbortController().signal);
    assert.equal(calls, 19); assert.equal(compactions, 0);
    assert.equal(f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)?.portableMemory, undefined);
  } finally { await engine.close(); f.close(); }
});

test("Claude Code 连接按原生会话阅读：每批只发本批，检查点可分叉", async () => {
  const f = fixture([1]); const runs: { thread: string; text: string }[] = []; let invoked = 0;
  const worker = { thread: async (_m: string, id?: string) => id || "claude:session", fork: async () => "claude:child", shutdown: async () => {}, rpc: async () => ({ thread: { turns: [] } }),
    run: async (thread: string, text: string) => { runs.push({ thread, text }); return { status: "completed", text: `笔记${runs.length}`, turnId: `turn-${runs.length}` }; } };
  const engine = new PersistentKnowledgeRuntime(f.store, config("claude-code"), new Scheduler(), { claude: () => worker, invoke: async () => { invoked++; return { text: "", toolCalls: [] }; } });
  try {
    const session = createReadingSession(f.store, f.course.id, [f.docs[0].id], { connectionId: "claude-code", model: "test" }, "章节", 2, f.docs[0].id);
    await engine.read(session.id, { key: "one", prompt: "第一批内容", completePages: [1] }, new AbortController().signal);
    await engine.read(session.id, { key: "two", prompt: "第二批内容", completePages: [2] }, new AbortController().signal);
    assert.equal(invoked, 0, "不走重放和压缩");
    assert.deepEqual(runs.map(r => r.thread), ["claude:session", "claude:session"]);
    assert.ok(!runs[1].text.includes("第一批内容"), "第二批不重发第一批");
    const done = f.store.get<KnowledgeReadSession>("knowledgeSession", session.id)!;
    assert.equal(done.checkpoint?.mode, "fork"); assert.equal(done.checkpoint?.threadId, "claude:session"); assert.equal(done.checkpoint?.turnId, "turn-2");
  } finally { await engine.close(); f.close(); }
});

test("本章先规划小节：页码连续不遗漏，长节均分、相邻短节合并", () => {
  const answer = "本章分四节。\n```json\n[{\"title\":\"2.2 光栅化\",\"start\":10,\"end\":30},{\"title\":\"2.1 显示\",\"start\":2,\"end\":9},{\"title\":\"2.3 小结\",\"start\":31,\"end\":31},{\"title\":\"2.4 习题\",\"start\":32,\"end\":33},{\"title\":\"越界\",\"start\":99}]\n```";
  const sections = parseSections(answer, 33)!;
  assert.deepEqual(sections, [{ title: "2.1 显示", start: 1, end: 9 }, { title: "2.2 光栅化", start: 10, end: 30 }, { title: "2.3 小结", start: 31, end: 31 }, { title: "2.4 习题", start: 32, end: 33 }]);
  assert.equal(parseSections("没有结构", 33), undefined);
  const pages = Array.from({ length: 33 }, (_, i) => ({ page: i + 1, text: `p${i + 1}` }));
  const { batches, labels } = sectionBatches(pages, sections);
  assert.deepEqual(batches.map(b => b.map(p => p.page)).flat(), pages.map(p => p.page), "每页恰好读一次");
  assert.deepEqual(batches.map(b => b.length), [5, 4, 7, 7, 7, 3]);
  assert.deepEqual(labels, ["2.1 显示（本节第1/2部分）", "2.1 显示（本节第2/2部分）", "2.2 光栅化（本节第1/3部分）", "2.2 光栅化（本节第2/3部分）", "2.2 光栅化（本节第3/3部分）", "2.3 小结、2.4 习题"]);
});

test("规划结果决定批次，提示中带小节名；规划无法解析时回退为固定分批", async () => {
  const f = fixture([20]);
  try {
    f.setBefore((_s, input) => { if (input.key === "plan") assert.ok(input.sources?.every(s => !s.image && s.text.length <= 200)); });
    const engine = f.factory;
    const reader = new ContinuousKnowledgeReader(f.store, f.courses, () => {
      const e = engine();
      return { ...e, read: async (sid, input, signal) => { const t = await e.read(sid, input, signal); if (input.key === "plan") t.answer = '```json\n[{"title":"1.1 引言","start":1,"end":8},{"title":"1.2 方法","start":9,"end":20}]\n```'; return t; } };
    }, r => f.store.put("knowledge", r));
    const r = f.revision(); await reader.run(r.id, new AbortController().signal);
    const batches = f.calls.filter(c => c.input.key.startsWith("batch:"));
    assert.deepEqual(batches.map(c => c.input.pages), [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14], [15, 16, 17, 18, 19, 20]]);
    assert.match(batches[1].input.prompt, /小节「1\.2 方法（本节第1\/2部分）」/);
    assert.equal(f.store.get<KnowledgeRevision>("knowledge", r.id)?.state, "completed");
  } finally { f.close(); }
});
