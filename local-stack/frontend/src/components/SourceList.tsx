import { ChevronDown, Copy, FileText } from "lucide-react";
import { useState } from "react";

import type { Source } from "@/types";

export default function SourceList({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(true);
  if (!sources.length) return null;

  return (
    <div className="mt-3 rounded-lg border border-line bg-panel">
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
          Sources ({sources.length})
        </span>
        <ChevronDown
          size={14}
          className={`text-muted transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {sources.map((source) => (
            <div key={source.chunk_id} className="text-xs">
              <div className="flex items-center gap-2">
                <FileText size={13} className="text-amethyst" />
                <span className="font-medium text-ink">{source.document_name}</span>
                <span className="font-mono text-[11px] text-muted">
                  Page {source.page_number}
                </span>
                <span className="font-mono text-[11px] text-cyan">
                  {(source.relevance_score * 100).toFixed(0)}%
                </span>
                <button
                  className="ml-auto text-muted hover:text-ink"
                  aria-label="Copy citation"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${source.document_name}, page ${source.page_number}`,
                    )
                  }
                >
                  <Copy size={12} />
                </button>
              </div>
              <p className="mt-1 pl-5 leading-relaxed text-muted">"{source.snippet}"</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
