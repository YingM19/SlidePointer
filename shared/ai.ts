import type { AIModel, AISettings, SelectionRef, Source } from "./types.ts";

export const DEFAULT_CONNECTION = "codex";
export type AIProtocol = "codex" | "claude-code" | "openai" | "compatible" | "anthropic" | "gemini";
export interface AIConnection {
  id: string;
  name: string;
  protocol: AIProtocol;
  preset?: string;
  baseUrl: string;
  enabled: boolean;
  models: AIModel[];
  defaultModel?: string;
  codexPath?: string;
  claudePath?: string;
  hasKey?: boolean;
  checkedAt?: string;
  status?: "ready" | "unconfigured" | "error";
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConnectionStatus {
  id: string;
  authenticated: boolean;
  error?: string;
  version?: string;
  plan?: string | null;
  limits?: { name: string; usedPercent: number; resetsAt?: number }[];
  limitMessage?: string;
}
export interface ModelRef { connectionId: string; modelId: string }
export type AssistantTool = "course" | "notes" | "web" | "artifacts";
export interface AssistantProfile {
  id: string;
  name: string;
  description: string;
  prompt: string;
  style: string;
  settings: AISettings;
  scope: "page" | "nearby" | "full";
  tools: AssistantTool[];
  mcpToolIds: string[];
  builtin?: boolean;
  updatedAt: string;
}
export interface AIUserPreferences {
  id: "preferences";
  defaultConnectionId: string;
  favorites: string[];
  recent: string[];
  names: Record<string, string>;
  profiles: Record<"quick" | "deep" | "batch", AISettings>;
}
export interface AIMemory {
  id: string;
  courseId?: string;
  kind: "preference" | "glossary" | "goal";
  title: string;
  text: string;
  updatedAt: string;
}
export interface AIContext {
  capturedAt: string;
  documentIds: string[];
  sources: Source[];
  notes: { id: string; title: string; text: string }[];
  memories: AIMemory[];
  history: { id: string; question: string; answer: string }[];
  compressed: boolean;
}
export interface AIUsage {
  id: string;
  connectionId: string;
  model: string;
  taskId?: string;
  taskKind: "chat" | "reading" | "knowledge" | "mindmap" | "research" | "comparison" | "test";
  input?: number;
  output?: number;
  total?: number;
  durationMs: number;
  state: "completed" | "failed" | "stopped";
  error?: string;
  createdAt: string;
}
export interface AgentStep {
  id: string;
  title: string;
  detail?: string;
  state: "running" | "completed" | "failed";
  tool?: string;
  createdAt: string;
}
export interface ResearchMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }[];
  toolCallId?: string;
  images?: string[];
  providerData?: { protocol: string; content: any[] };
}
export interface ResearchRun {
  id: string;
  courseId?: string;
  documentId: string;
  title: string;
  goal: string;
  page: number;
  scope: "page" | "nearby" | "full";
  settings: AISettings;
  assistant: AssistantProfile;
  context: AIContext;
  selection?: SelectionRef;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "stopped" | "unknown";
  mode: "research" | "compare" | "review";
  compareSettings?: AISettings;
  comparison?: { settings: AISettings; answer: string; sources: Source[]; state: string; error?: string }[];
  steps: AgentStep[];
  messages: ResearchMessage[];
  answer: string;
  sources: Source[];
  artifactIds: string[];
  calls: number;
  callLimit: number;
  elapsedMs: number;
  startedAt?: string;
  timeLimitMs: number;
  checkpoint?: string;
  error?: string;
  pendingTool?: { id: string; name: string; arguments: Record<string, unknown> };
  pauseRequested?: boolean;
  webSources?: { url: string; title: string; text: string }[];
  searchService?: string;
  citationWarnings?: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ResearchArtifact {
  id: string;
  runId: string;
  courseId?: string;
  documentId: string;
  title: string;
  kind: "report" | "table" | "outline" | "quiz";
  text: string;
  sources: Source[];
  version: number;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ArtifactVersion extends Omit<ResearchArtifact, "id"> { id: string; artifactId: string }
export interface ExternalTool {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  readOnly: boolean;
}
export interface MCPConnection {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  hasKey?: boolean;
  tools: ExternalTool[];
  checkedAt?: string;
  error?: string;
}
type ModelChoice = { connectionId?: string; model?: string };
export function selectedModel(models: AIModel[], value: ModelChoice, defaultConnection = DEFAULT_CONNECTION) {
  const id = value.connectionId || defaultConnection;
  const available = models.filter(m => (m.connectionId || DEFAULT_CONNECTION) === id);
  return available.find(m => m.model === value.model) || (!value.model ? available.find(m => m.isDefault) || available[0] : undefined);
}
// The model the composer shows; explanation windows must spend on this same model.
export function currentModel(models: AIModel[], draft: ModelChoice, conversation: ModelChoice | undefined, defaultConnection?: string) {
  return selectedModel(models, {
    connectionId: draft.connectionId || conversation?.connectionId || defaultConnection,
    model: draft.model || (!draft.connectionId || draft.connectionId === conversation?.connectionId ? conversation?.model : undefined),
  }, defaultConnection);
}
type EffortModel = Pick<AIModel, "defaultReasoningEffort" | "supportedReasoningEfforts" | "capabilities">;
// The configured default is always selectable; it must not be rejected for missing from the list.
export function modelEfforts(model?: EffortModel) {
  if (!model || model.capabilities?.reasoning === false) return [];
  return [...new Set([...model.supportedReasoningEfforts.map(e => e.reasoningEffort.trim()), model.defaultReasoningEffort?.trim()])].filter(Boolean) as string[];
}
export function defaultEffort(model?: EffortModel) {
  const effort = model?.defaultReasoningEffort?.trim() || "";
  return modelEfforts(model).includes(effort) ? effort : "";
}
// Services rarely report context length; known families get their documented window so reading
// replays whole chapters instead of compacting at the conservative 32k default.
const knownWindows: [RegExp, number][] = [
  [/deepseek-v4/i, 1000000], [/deepseek/i, 128000],
  [/claude|^(sonnet|opus|haiku)$/i, 200000],
  [/gemini-(1\.5|2|3)/i, 1000000],
  [/gpt-4\.1/i, 1000000], [/gpt-5/i, 400000], [/gpt-4o|^o\d/i, 128000],
  [/qwen/i, 128000], [/kimi|moonshot/i, 128000], [/glm-4/i, 128000],
];
export function contextWindowFor(model: { model: string; contextWindow?: number }) {
  return model.contextWindow || knownWindows.find(([pattern]) => pattern.test(model.model))?.[1];
}
export const connectionPresets: { id: string; name: string; protocol: AIProtocol; baseUrl: string; reasoningEfforts?: string[]; defaultReasoningEffort?: string }[] = [
  { id: "claude-code", name: "Claude Code 订阅", protocol: "claude-code", baseUrl: "" },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "gemini", name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "deepseek", name: "DeepSeek", protocol: "compatible", baseUrl: "https://api.deepseek.com/v1", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" },
  { id: "qwen", name: "通义千问", protocol: "compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "openrouter", name: "OpenRouter", protocol: "compatible", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", name: "Ollama", protocol: "compatible", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", protocol: "compatible", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "custom", name: "自定义服务", protocol: "compatible", baseUrl: "" },
];
// Documented capabilities for known model IDs fill in only what is still "unknown"; a user's choice wins.
const knownCapabilities: [RegExp, { vision: boolean; tools: boolean; reasoning: boolean }][] = [
  [/^deepseek-v4.*vision/i, { vision: true, tools: true, reasoning: true }],
  [/^deepseek-v4/i, { vision: false, tools: true, reasoning: true }],
];
export function withKnownCapabilities<T extends AIConnection>(connection: T): T {
  return { ...connection, models: connection.models.map(m => {
    const known = knownCapabilities.find(([pattern]) => pattern.test(m.model))?.[1];
    if (!known) return m;
    const current = { vision: "unknown", tools: "unknown", reasoning: "unknown", ...m.capabilities } as const;
    const pick = (key: keyof typeof known) => current[key] === "unknown" ? known[key] : current[key];
    return { ...m, capabilities: { vision: pick("vision"), tools: pick("tools"), reasoning: pick("reasoning") } };
  }) };
}
// A confirmed reasoning model with no list of its own uses the service's documented efforts.
export function withPresetEfforts<T extends AIConnection>(connection: T): T {
  const preset = connectionPresets.find(p => p.id === connection.preset);
  if (!preset?.reasoningEfforts) return connection;
  return { ...connection, models: connection.models.map(m => m.capabilities?.reasoning === true && !m.supportedReasoningEfforts.length ? { ...m, supportedReasoningEfforts: preset.reasoningEfforts!.map(reasoningEffort => ({ reasoningEffort, description: "" })), defaultReasoningEffort: m.defaultReasoningEffort || preset.defaultReasoningEffort || "" } : m) };
}
// Subscription connections run a local official CLI and never use a base URL or API key.
export const localCli = (protocol: AIProtocol) => protocol === "codex" || protocol === "claude-code";
export const modelKey = (connectionId: string | undefined, model: string) => `${connectionId || DEFAULT_CONNECTION}::${model}`;
export const profileLabels = { quick: "快速解释", deep: "深入分析", batch: "批量整理" };
export function builtinAssistants(): AssistantProfile[] {
  return [
    ["explain", "课程讲解", "把概念讲清楚，联系原文与例子。", "先直接回答，再按需要补充解释和一个恰当例子。区分原文与补充，不机械套用长篇模板。"],
    ["verify", "推导核查", "检查条件、步骤和结论的依据。", "核对前提、符号、每一步推导及适用范围。指出缺失条件和反例；没有充分依据时明确未确认。"],
    ["research", "跨资料研究", "比较资料、核对来源，形成研究成果。", "把目标拆成必要子问题，使用不同关键词查阅相关资料及邻页，比较观点和证据，形成有来源的研究成果。"],
    ["practice", "复习出题", "根据已选资料出题，帮助主动回忆。", "围绕资料中的核心概念与易错点设计题目，标注依据。先呈现题目，再给参考答案与解释，避免只考记忆。"],
  ].map(([id, name, description, prompt]) => ({ id, name, description, prompt, style: "中文，简洁清楚；公式使用 LaTeX，引用真实来源。", settings: {}, scope: "full", tools: ["course", "notes", "web", "artifacts"], mcpToolIds: [], builtin: true, updatedAt: "2026-10-23T00:00:00.000Z" }));
}
