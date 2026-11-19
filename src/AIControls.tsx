import { useState } from "react";
import type { AIModel, AISettings } from "../shared/types.ts";
import { modelKey, profileLabels, selectedModel } from "../shared/ai.ts";
import type { useAIConfig } from "./useAIConfig.ts";

export { selectedModel };
const effortNames: Record<string, string> = { none: "不额外思考", minimal: "极轻量", low: "轻量", medium: "标准", high: "深入", xhigh: "更深入", max: "最高", ultra: "极深" };
export const effortLabel = (effort: string) => effortNames[effort] || effort;
export type AIState = ReturnType<typeof useAIConfig>;
export function ModelList({ models, value, onChange, ai, onDone }: { models: AIModel[]; value: AISettings; onChange: (v: AISettings) => void; ai: AIState; onDone?: () => void }) {
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("all"), [error, setError] = useState("");
  const prefs = ai.config?.preferences;
  const selected = selectedModel(models, value, prefs?.defaultConnectionId);
  const chosenKey = selected && modelKey(selected.connectionId, selected.model);
  const ordered = models.filter(m => {
    const key = modelKey(m.connectionId, m.model);
    return (!search || `${m.displayName} ${m.model} ${m.connectionName} ${prefs?.names[key] || ""}`.toLowerCase().includes(search.toLowerCase())) && (filter === "all" || (filter === "favorite" ? prefs?.favorites : prefs?.recent)?.includes(key));
  }).sort((a, b) => Number(!!prefs?.favorites.includes(modelKey(b.connectionId, b.model))) - Number(!!prefs?.favorites.includes(modelKey(a.connectionId, a.model))));
  const pick = async (m: AIModel) => {
    const key = modelKey(m.connectionId, m.model);
    onChange({ connectionId: m.connectionId || "codex", model: m.model, reasoningEffort: undefined, textOnly: m.capabilities?.vision === false ? true : value.textOnly });
    try { await ai.savePreferences({ recent: [key, ...(prefs?.recent || []).filter(x => x !== key)].slice(0, 30) }); } catch (e) { setError((e as Error).message); }
    onDone?.();
  };
  return <div className="ai-model-list">
    <input className="ai-model-search" aria-label="搜索模型或连接" placeholder="搜索模型或连接…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
    <div className="ai-segments" aria-label="模型分类">{[["all", "全部"], ["favorite", "收藏"], ["recent", "最近"]].map(([key, title]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{title}</button>)}</div>
    <div className="ai-model-options">{ordered.map(m => {
      const key = modelKey(m.connectionId, m.model), cap = m.capabilities;
      return <div className={`ai-model-row ${key === chosenKey ? "selected" : ""}`} key={key}>
        <button className="ai-model-choice" onClick={() => void pick(m)} aria-pressed={key === chosenKey}><strong>{prefs?.names[key] || m.displayName}</strong><small>{m.connectionName} · {m.model}</small><span className="ai-capabilities">{cap?.vision === true ? "图像" : cap?.vision === false ? "文字" : "图像待确认"} · {cap?.tools === true ? "工具" : cap?.tools === false ? "无工具" : "工具待确认"}{cap?.reasoning === true ? " · 推理" : ""}</span></button>
        <button className="ai-favorite" aria-label={`${prefs?.favorites.includes(key) ? "取消收藏" : "收藏"} ${m.displayName}`} aria-pressed={prefs?.favorites.includes(key) || false} onClick={() => void ai.savePreferences({ favorites: prefs?.favorites.includes(key) ? prefs.favorites.filter(x => x !== key) : [...(prefs?.favorites || []), key] }).catch(e => setError(e.message))}>{prefs?.favorites.includes(key) ? "★" : "☆"}</button>
      </div>;
    })}</div>
    {!ordered.length && <p className="muted">{models.length ? "没有匹配的模型" : "先在连接中心配置服务并获取模型。"}</p>}
    {(error || ai.error) && <p role="alert" className="turn-error">{error || ai.error}</p>}
    <button className="ai-manage-link" onClick={() => { onDone?.(); window.dispatchEvent(new CustomEvent("pointer:connect")); }}>管理 AI 连接 ↗</button>
  </div>;
}
export function ModelSelect({ models, value, onChange, ai }: { models: AIModel[]; value: AISettings; onChange: (v: AISettings) => void; ai: AIState }) {
  const selected = selectedModel(models, value, ai.config?.preferences.defaultConnectionId);
  return <select aria-label="模型与连接" value={selected ? modelKey(selected.connectionId, selected.model) : ""} onChange={e => { const m = models.find(m => modelKey(m.connectionId, m.model) === e.target.value); if (m) onChange({ connectionId: m.connectionId || "codex", model: m.model, reasoningEffort: undefined, textOnly: m.capabilities?.vision === false ? true : value.textOnly }); }}><option value="">选择模型</option>{(ai.config?.connections || []).map(c => <optgroup key={c.id} label={c.name}>{models.filter(m => (m.connectionId || "codex") === c.id).map(m => <option key={m.model} value={modelKey(c.id, m.model)}>{ai.config?.preferences.names[modelKey(c.id, m.model)] || m.displayName}{m.capabilities?.vision === false ? "（文字）" : ""}</option>)}</optgroup>)}</select>;
}
export function AssistantSelect({ ai, value, onChange }: { ai: AIState; value: AISettings; onChange: (v: AISettings, scope?: "page" | "nearby" | "full") => void }) {
  return <select aria-label="选择助手" value={value.assistantId || "explain"} onChange={e => { const a = ai.config?.assistants.find(a => a.id === e.target.value); if (a) onChange({ ...a.settings, assistantId: a.id }, a.scope); }}>{(ai.config?.assistants || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>;
}
// Saved presets of model, effort and tools. Unconfigured ones are hidden; with none, offer to set them up.
export function ProfileButtons({ ai, onChange }: { ai: AIState; onChange: (value: AISettings) => void }) {
  const profiles = ai.config?.preferences.profiles;
  if (!profiles) return null;
  const ready = (Object.entries(profileLabels) as [keyof typeof profileLabels, string][]).filter(([key]) => profiles[key].model);
  const describe = (p: AISettings) => [ai.config?.connections.find(c => c.id === p.connectionId)?.models.find(m => m.model === p.model)?.displayName || p.model, p.reasoningEffort && effortLabel(p.reasoningEffort), p.agentTools === false ? "不用课件工具" : "课件工具", p.webSearch && "联网"].filter(Boolean).join(" · ");
  if (!ready.length) return <button className="ai-profile-setup" onClick={() => window.dispatchEvent(new CustomEvent("pointer:connect", { detail: "profiles" }))} title="在 AI 连接中心为快速解释、深入分析、批量整理各存一套模型与参数">设置常用配置，一键切换模型与强度…</button>;
  return <div className="ai-profile-buttons" role="group" aria-label="常用配置"><span>常用配置</span>{ready.map(([key, label]) => <button key={key} onClick={() => onChange(profiles[key])} title={describe(profiles[key])}>{label}</button>)}</div>;
}
