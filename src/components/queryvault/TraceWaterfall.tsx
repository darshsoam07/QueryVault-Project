/**
 * Renders one query trace as a stage waterfall plus per-stage candidate tables.
 * Diagnostic surface for operators — never shown to end users.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fmt(value: unknown, digits = 3): string {
  const n = num(value);
  return n === null ? "—" : n.toFixed(digits);
}

function stageOf(stages: Record<string, unknown>, key: string): Row {
  const value = stages[key];
  return value && typeof value === "object" ? (value as Row) : {};
}

function rowsOf(stage: Row, key = "top"): Row[] {
  const value = stage[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}

export function TraceWaterfall({
  stages,
  totalLatencyMs,
}: {
  stages: Record<string, unknown>;
  totalLatencyMs: number | null;
}) {
  const embedding = stageOf(stages, "embedding");
  const dense = stageOf(stages, "dense");
  const lexical = stageOf(stages, "lexical");
  const fusion = stageOf(stages, "fusion");
  const rerank = stageOf(stages, "rerank");
  const gate = stageOf(stages, "gate");
  const evidence = stageOf(stages, "evidence");

  const bars = [
    { label: "Query expansion", ms: num(embedding["latencyMs"]) ?? 0, tone: "bg-primary/70" },
    { label: "Dense (pgvector)", ms: num(dense["latencyMs"]) ?? 0, tone: "bg-accent/70" },
    { label: "Lexical (tsvector)", ms: num(lexical["latencyMs"]) ?? 0, tone: "bg-accent/40" },
    { label: "Rerank", ms: num(rerank["latencyMs"]) ?? 0, tone: "bg-primary/40" },
  ];
  const span = Math.max(totalLatencyMs ?? 0, ...bars.map((bar) => bar.ms), 1);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Stage timings
        </h4>
        {bars.map((bar) => (
          <div key={bar.label} className="flex items-center gap-3 text-xs">
            <span className="w-36 shrink-0 text-muted-foreground">{bar.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/40">
              <div
                className={cn("h-full rounded-full", bar.tone)}
                style={{ width: `${Math.max((bar.ms / span) * 100, bar.ms > 0 ? 2 : 0)}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right tabular-nums">{Math.round(bar.ms)} ms</span>
          </div>
        ))}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <CandidateTable
          title={`Dense candidates (${num(dense["count"]) ?? 0})`}
          rows={rowsOf(dense)}
          scoreKey="similarity"
          scoreLabel="cosine"
        />
        <CandidateTable
          title={`Lexical candidates (${num(lexical["count"]) ?? 0})`}
          rows={rowsOf(lexical)}
          scoreKey="lexicalRank"
          scoreLabel="ts_rank"
        />
        <CandidateTable
          title={`After RRF fusion (${num(fusion["count"]) ?? 0})`}
          rows={rowsOf(fusion, "rrfTop")}
          scoreKey="fusionScore"
          scoreLabel="rrf"
        />
        <CandidateTable
          title={`After rerank — ${String(rerank["reranker"] ?? "none")}`}
          rows={rowsOf(rerank)}
          scoreKey="rerankScore"
          scoreLabel="score"
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Evidence gate
        </h4>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={gate["grounded"] ? "default" : "destructive"}>
            {gate["grounded"] ? "grounded" : "refused"}
          </Badge>
          <span className="text-muted-foreground">reason: {String(gate["reason"] ?? "—")}</span>
          <span className="text-muted-foreground">
            best cosine {fmt(gate["bestSimilarity"])} · best rerank {fmt(gate["bestRerankScore"])}
          </span>
          <span className="text-muted-foreground">
            {num(evidence["count"]) ?? 0} passages · {num(evidence["contextTokens"]) ?? 0} ctx
            tokens · {num(evidence["droppedDuplicates"]) ?? 0} deduped
          </span>
        </div>
        <div className="space-y-2">
          {rowsOf(evidence, "sources").map((source, index) => (
            <div key={index} className="rounded-lg border border-border/60 bg-card/40 p-3 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted/50 px-1.5 py-0.5">
                  {String(source["sourceId"] ?? "")}
                </code>
                <span className="font-medium">{String(source["filename"] ?? "")}</span>
                <span className="text-muted-foreground">p. {String(source["page"] ?? "?")}</span>
                <span className="text-muted-foreground">
                  cos {fmt(source["similarity"])} · rerank {fmt(source["rerankScore"])}
                </span>
              </div>
              <p className="text-muted-foreground">{String(source["preview"] ?? "")}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CandidateTable({
  title,
  rows,
  scoreKey,
  scoreLabel,
}: {
  title: string;
  rows: Row[];
  scoreKey: string;
  scoreLabel: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/30 p-3">
      <h5 className="mb-2 text-xs font-medium text-foreground">{title}</h5>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No candidates.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-1 text-left font-normal">#</th>
              <th className="pb-1 text-left font-normal">chunk</th>
              <th className="pb-1 text-right font-normal">{scoreLabel}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-border/40">
                <td className="py-1 text-muted-foreground">{index + 1}</td>
                <td className="py-1">
                  <span className="text-foreground">
                    {String(row["filename"] ?? row["chunkId"] ?? "")}
                  </span>
                  {row["page"] !== undefined && (
                    <span className="text-muted-foreground"> · p{String(row["page"])}</span>
                  )}
                </td>
                <td className="py-1 text-right">{fmt(row[scoreKey])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
