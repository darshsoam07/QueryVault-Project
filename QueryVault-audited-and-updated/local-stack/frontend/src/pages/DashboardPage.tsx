import { motion } from "framer-motion";
import { Link } from "react-router-dom";

import { useHealth, useStats } from "@/hooks/useHealth";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-4">
      <p className="font-mono text-[11px] uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

export default function DashboardPage() {
  const { data: stats } = useStats();
  const { data: health } = useHealth();

  return (
    <div className="mx-auto max-w-4xl px-6 py-12 md:py-16">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Ask your knowledge base.
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">
          Upload documents. Retrieve evidence. Get grounded answers.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/documents"
            className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-void hover:opacity-90"
          >
            Upload documents
          </Link>
          <Link
            to="/chat"
            className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink hover:bg-elevated"
          >
            Start asking questions
          </Link>
        </div>
      </motion.div>

      <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Documents" value={stats?.documents ?? 0} />
        <Stat label="Indexed chunks" value={stats?.chunks ?? 0} />
        <Stat label="Conversations" value={stats?.conversations ?? 0} />
        <Stat label="Messages" value={stats?.messages ?? 0} />
      </div>

      <div className="mt-6 rounded-xl border border-line bg-panel px-5 py-4">
        <p className="font-mono text-[11px] uppercase tracking-widest text-muted">System status</p>
        <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Ollama</dt>
            <dd>{health?.ollama_reachable ? "Connected" : "Not reachable"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Model</dt>
            <dd className="font-mono text-xs">
              {health?.model ?? "-"} {health?.model_available ? "" : "(not installed)"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Embeddings</dt>
            <dd className="font-mono text-xs">{health?.embedding_model ?? "-"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Vector store</dt>
            <dd className="font-mono text-xs">Chroma · {health?.vector_chunks ?? 0} vectors</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
