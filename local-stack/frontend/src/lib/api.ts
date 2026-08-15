import type {
  BackendSettings,
  ChatResponse,
  Conversation,
  DocumentRecord,
  Health,
  Message,
  Stats,
} from "@/types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(
      "Can't reach the backend. Start it with: uvicorn app.main:app --reload --port 8000",
    );
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>("/health"),
  stats: () => request<Stats>("/stats"),
  settings: () => request<BackendSettings>("/settings"),

  listDocuments: () => request<DocumentRecord[]>("/documents"),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<DocumentRecord>("/documents/upload", { method: "POST", body: form });
  },
  deleteDocument: (id: string) =>
    request<void>(`/documents/${id}`, { method: "DELETE" }),
  reindexDocument: (id: string) =>
    request<DocumentRecord>(`/documents/${id}/reindex`, { method: "POST" }),

  chat: (body: {
    question: string;
    conversation_id?: string | null;
    document_ids?: string[] | null;
  }) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  listConversations: () => request<Conversation[]>("/conversations"),
  listMessages: (id: string) => request<Message[]>(`/conversations/${id}/messages`),
  deleteConversation: (id: string) =>
    request<void>(`/conversations/${id}`, { method: "DELETE" }),
};
