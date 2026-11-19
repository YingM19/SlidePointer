import type { Conversation, QuestionSnapshot, Source, Turn } from "./types.ts";

// A course-wide question asked while merely browsing a page is not about that page: send it only when
// the user pinned the page, selected something on it, or the scope is local.
export function anchoredPage(s: Pick<QuestionSnapshot, "scope" | "courseId" | "rect" | "selectedText" | "pagePinned" | "selections">) {
  return !(s.scope === "full" && !!s.courseId && !s.rect && !s.selectedText && !s.pagePinned && !s.selections?.length);
}

export function sourceMap(turns: Turn[], documentId?: string) {
  return new Map(
    turns
      .flatMap((t) => [...t.snapshot.sources, ...(t.toolSources || [])])
      .filter((s) => !documentId || s.documentId === documentId)
      .map((s) => [s.id, s]),
  );
}
export function citedSources(answer: string, sources: Map<string, Source>) {
  const ids = [...answer.matchAll(/\[[^\]]*\]\(source:([^\s)]+)\)/g)].map(
    (m) => m[1],
  );
  return [...new Set(ids)]
    .map((id) => sources.get(id))
    .filter((s): s is Source => !!s);
}
export function portableAnswer(
  answer: string,
  sources: Map<string, Source>,
  name: string,
) {
  return answer.replace(
    /\[([^\]]*)\]\(source:([^\s)]+)\)/g,
    (_m, label, id) => {
      const s = sources.get(id);
      return s
        ? `${label}（${s.documentName || name}，第 ${s.page} 页${s.deleted ? "，来源已删除" : ""}）`
        : label;
    },
  );
}
export function deletedSources(
  conversations: Pick<Conversation, "documentId" | "documentName">[],
  documents: { id: string }[],
) {
  const deleted = new Map<string, string>();
  for (const c of conversations)
    if (!documents.some((d) => d.id === c.documentId))
      deleted.set(c.documentId, c.documentName || deleted.get(c.documentId) || "未命名课件");
  return [...deleted].map(([id, name]) => ({ id, name }));
}
export function autoTitle(question: string) {
  return question.replace(/\s+/g, " ").trim().slice(0, 26) || "新会话";
}
