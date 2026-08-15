import { useQuery } from "@tanstack/react-query";

import { useHealth } from "@/hooks/useHealth";
import { api } from "@/lib/api";

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-line py-2.5 last:border-0">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: health } = useHealth();

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-xs text-muted">
        These values are read from the backend configuration. Change them in
        <span className="font-mono"> backend/.env</span> and restart the API.
      </p>

      <div className="mt-6 rounded-xl border border-line bg-panel px-5 py-2">
        <Row label="LLM (Ollama)" value={settings?.ollama_model ?? "-"} />
        <Row label="Embedding model" value={settings?.embedding_model ?? "-"} />
        <Row
          label="Vector store"
          value={`${settings?.vector_store ?? "Chroma"} · ${settings?.collection ?? "-"}`}
        />
        <Row label="Retrieval count (k)" value={settings?.retrieval_k ?? "-"} />
        <Row label="Chunk size" value={settings?.chunk_size ?? "-"} />
        <Row label="Chunk overlap" value={settings?.chunk_overlap ?? "-"} />
        <Row label="Max upload size" value={`${settings?.max_upload_mb ?? "-"} MB`} />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-panel px-5 py-2">
        <Row
          label="Ollama"
          value={health?.ollama_reachable ? "Connected" : "Not reachable"}
        />
        <Row
          label="Model installed"
          value={health?.model_available ? "Yes" : "No — run ollama pull llama3"}
        />
        <Row label="Indexed vectors" value={health?.vector_chunks ?? 0} />
      </div>
    </div>
  );
}
