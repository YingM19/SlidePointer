import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AIConnection } from "../shared/ai.ts";
import type { Store } from "./store.ts";
import type { RuntimeEvent } from "./ai-runtime.ts";
import { MissingClaudeSession, claudeContent, runClaude, type ClaudeRun } from "./claude-code.ts";

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

export const newClaudeSession = () => PREFIX + randomUUID();
// The fork is written on the first request; recording it keeps the parent across restarts.
export function forkClaudeSession(store: Store, parent: string, at?: string) {
  const id = newClaudeSession();
  store.put<Fork>("claudeFork", { id, parent, at });
  return id;
}
// Starts, continues or forks the session behind threadId. A session that never got its first
// request is started under the same id; a fork whose parent is gone is an error, not a fresh start.
export async function runClaudeSession(store: Store, connection: AIConnection, threadId: string, run: Omit<ClaudeRun, "session">, env?: NodeJS.ProcessEnv) {
  const fork = store.get<Fork>("claudeFork", threadId);
  // A fork not yet accepted whose file exists is left over from an attempt that failed (e.g. at the
  // usage limit); the CLI would refuse the id as "already in use", so fork again from the parent.
  if (fork && claudeSessionFile(threadId, env)) deleteClaudeSession(threadId, env);
  const call =(session: ClaudeRun["session"]) => runClaude(connection, { ...run, session }, { env });
  let result;
  try { result = await call(fork ? { id: uuid(threadId), resume: uuid(fork.parent), at: fork.at } : { id: uuid(threadId), resume: uuid(threadId) }); }
  catch (e) {
    if (!(e instanceof MissingClaudeSession)) throw e;
    if (fork) throw Error("上级会话已不在 Claude Code 中，无法继承之前的上下文；请新建会话或重新分析本章");
    result = await call({ id: uuid(threadId) });
  }
  if (fork) store.remove("claudeFork", threadId);
  return result;
}
// Turns in the session file, shaped like Codex thread turns so recovery code reads both alike.
export function readClaudeSession(threadId: string, env?: NodeJS.ProcessEnv) {
  const file = claudeSessionFile(threadId, env);
  const turns: any[] = [];
  for (const line of file ? readFileSync(file, "utf8").split("\n") : []) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry.message?.content;
    if (entry.type === "user" && !(Array.isArray(blocks) && blocks.some((b: any) => b?.type === "tool_result")))
      turns.push({ id: "", status: "failed", items: [{ type: "userMessage", text: text(blocks) }] });
    else if (entry.type === "assistant" && turns.length) {
      const turn = turns.at(-1);
      turn.id = entry.uuid;
      if (text(blocks)) { turn.status = "completed"; turn.items.push({ type: "agentMessage", phase: "final_answer", text: text(blocks) }); }
    }
  }
  return turns;
}

export class ClaudeSessionWorker {
  private model = "";
  constructor(private store: Store, private connection: AIConnection, private options: { effort?: string; system: string; env?: NodeJS.ProcessEnv }) {}
  async thread(model: string, threadId?: string) { this.model = model; return threadId || newClaudeSession(); }
  async fork(model: string, parent: string, _before?: string, at?: string) { this.model = model; return forkClaudeSession(this.store, parent, at); }
  async run(threadId: string, prompt: string, images: string[], onEvent: RuntimeEvent, signal = new AbortController().signal, options: { effort?: string } = {}) {
    const pictures = images.map(f => `data:image/png;base64,${readFileSync(f).toString("base64")}`);
    const content = claudeContent({ messages: [{ role: "user", text: prompt, images: pictures }] });
    const result = await runClaudeSession(this.store, this.connection, threadId, { model: this.model, system: this.options.system, content, effort: options.effort ?? this.options.effort, signal }, this.options.env);
    onEvent({ turnId: result.turnId, tokenUsage: result.usage } as any);
    return { status: "completed", text: result.text, turnId: result.turnId };
  }
  // Answers the one question the reading runtime asks after an interruption: did that request finish?
  async rpc(method: string, params: { threadId: string }) {
    if (method !== "thread/read") throw Error(`Claude Code 会话不支持 ${method}`);
    return { thread: { id: params.threadId, turns: readClaudeSession(params.threadId, this.options.env) } };
  }
  async shutdown() {}
}
