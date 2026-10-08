export type DocumentStatus =
  "uploading" | "parsing" | "chunking" | "embedding" | "indexing" | "ready" | "error";

export interface DocumentRecord {
  id: string;
  filename: string;
  file_size: number;
  file_type: string;
  upload_time: string;
  status: DocumentStatus;
  page_count: number;
  chunk_count: number;
  error_message: string | null;
}

export interface Source {
  document_id: string;
  document_name: string;
  page_number: number;
  chunk_id: string;
  relevance_score: number;
  snippet: string;
}

export interface ChatResponse {
  conversation_id: string;
  answer: string;
  sources: Source[];
  retrieved_chunks: Source[];
  grounded: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  created_at: string;
}

export interface Health {
  backend: string;
  ollama_reachable: boolean;
  ollama_base_url: string;
  model: string;
  model_available: boolean;
  embedding_model: string;
  embedding_loaded: boolean;
  vector_store: string;
  vector_chunks: number;
  documents: number;
}

export interface Stats {
  documents: number;
  ready_documents: number;
  chunks: number;
  conversations: number;
  messages: number;
}

export interface BackendSettings {
  ollama_model: string;
  embedding_model: string;
  vector_store: string;
  collection: string;
  retrieval_k: number;
  chunk_size: number;
  chunk_overlap: number;
  max_upload_mb: number;
}
