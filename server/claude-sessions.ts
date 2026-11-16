import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AIConnection } from "../shared/ai.ts";
import type { Store } from "./store.ts";
import type { RuntimeEvent } from "./ai-runtime.ts";
import { MissingClaudeSession, claudeContent, runClaude } from "./claude-code.ts";

// Reading sessions kept by Claude Code itself, so each batch sends only its own pages, like a Codex thread.
// Ids carry a prefix so cleanup knows these live in Claude Code's session files, not in Codex.
const PREFIX = "claude:";
export const isClaudeSession = (threadId: string) => threadId.startsWith(PREFIX);
const uuid = (threadId: string) => threadId.slice(PREFIX.length);

export function claudeSessionFile(threadId: string, env: NodeJS.ProcessEnv = process.env) {
  const id = uuid(threadId);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return;
  for (const folder of readdirSync(projects)) {
    const file = path.join(projects, folder, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
}
export function deleteClaudeSession(threadId: string, env?: NodeJS.ProcessEnv) {
  const file = claudeSessionFile(threadId, env);
  if (file) unlinkSync(file);
}

type Fork = { id: string; parent: string; at?: string };
const text = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";

export class ClaudeSessionWorker {
  private model = "";
  constructor(private store: Store, private connection: AIConnection, private options: { effort?: string; system: string; env?: NodeJS.ProcessEnv }) {}
  async thread(model: string, threadId?: string) { this.model = model; return threadId || PREFIX + randomUUID(); }
  // The fork is written on the first request; recording it keeps the parent across restarts.
  async fork(model: string, parent: string, _before?: string, at?: string) {
    this.model = model;
    const id = PREFIX + randomUUID();
    this.store.put<Fork>("claudeFork", { id, parent, at });
    return id;
  }
  async run(threadId: string, prompt: string, images: string[], onEvent: RuntimeEvent, signal = new AbortController().signal, options: { effort?: string } = {}) {
    const pictures = images.map(f => `data:image/png;base64,${readFileSync(f).toString("base64")}`);
    const content = claudeContent({ messages: [{ role: "user", text: prompt, images: pictures }] });
    const fork = this.store.get<Fork>("claudeFork", threadId);
    const call = (session: { id: string; resume?: string; at?: string }) => runClaude(this.connection, { model: this.model, system: this.options.system, content, effort: options.effort ?? this.options.effort, signal, session }, { env: this.options.env });
    let result;
    try { result = await call(fork ? { id: uuid(threadId), resume: uuid(fork.parent), at: fork.at } : { id: uuid(threadId), resume: uuid(threadId) }); }
    catch (e) {
      if (!(e instanceof MissingClaudeSession)) throw e;
      // The parent of a fork is gone: say so rather than silently reading without it.
      if (fork) throw Error("上级阅读会话已不在 Claude Code 中，请重新分析本章");
      result = await call({ id: uuid(threadId) });
    }
    if (fork) this.store.remove("claudeFork", threadId);
    onEvent({ turnId: result.turnId, tokenUsage: result.usage } as any);
    return { status: "completed", text: result.text, turnId: result.turnId };
  }
  // Answers the one question the reading runtime asks after an interruption: did that request finish?
  async rpc(method: string, params: { threadId: string }) {
    if (method !== "thread/read") throw Error(`Claude Code 会话不支持 ${method}`);
    const file = claudeSessionFile(params.threadId, this.options.env);
    const turns: any[] = [];
    for (const line of file ? readFileSync(file, "utf8").split("\n") : []) {
      let entry: any; try { entry = JSON.parse(line); } catch { continue; }
      const blocks = entry.message?.content;
      if (entry.type === "user" && !(Array.isArray(blocks) && blocks.some((b: any) => b?.type === "tool_result")))
        turns.push({ id: "", status: "failed", items: [{ type: "userMessage", text: text(blocks) }] });
      else if (entry.type === "assistant" && turns.length && text(blocks)) {
        const turn = turns.at(-1);
        turn.id = entry.uuid; turn.status = "completed";
        turn.items.push({ type: "agentMessage", phase: "final_answer", text: text(blocks) });
      }
    }
    return { thread: { id: params.threadId, turns } };
  }
  async shutdown() {}
}
