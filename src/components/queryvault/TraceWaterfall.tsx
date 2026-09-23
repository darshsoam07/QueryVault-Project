/**
 * Renders an interactive query trace waterfall, stage latencies, RRF rank shifts,
 * evidence gate meters, and citation delivery details for operator diagnostics.
 */
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileText, XCircle } from "lucide-react";
import { useState } from "react";

type Row = Record<string, unknown>;

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fmt(value: unknown, digits = 3): string {
  const n = num(value);
  return n === null ? "—" : n.toFixed(digits);
}

export function stageOf(stages: Record<string, unknown> | null | undefined, key: string): Row {
  if (!stages || typeof stages !== "object") return {};
  const value = stages[key];
  return value && typeof value === "object" ? (value as Row) : {};
}

export function rowsOf(stage: Row, key = "top"): Row[] {
  const value = stage[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}

export type TraceWaterfallProps = {
  stages?: Record<string, unknown> | null;
  totalLatencyMs?: number | null;
  citations?: string[] | null;
  refused?: boolean | null;
  gateReason?: string | null;
  retrievalLatencyMs?: number | null;
  generationLatencyMs?: number | null;
  question?: string | null;
};

export function TraceWaterfall({
  stages = {},
  totalLatencyMs,
  citations = [],
  refused = false,
  gateReason,
  retrievalLatencyMs,
  generationLatencyMs,
}: TraceWaterfallProps) {
  const [showTables, setShowTables] = useState(true);
  const [showRrfMatrix, setShowRrfMatrix] = useState(true);

  const safeStages = stages ?? {};
  const safeCitations = citations ?? [];
  const embedding = stageOf(safeStages, "embedding");
  const dense = stageOf(safeStages, "dense");
  const lexical = stageOf(safeStages, "lexical");
  const fusion = stageOf(safeStages, "fusion");
  const rerank = stageOf(safeStages, "rerank");
  const gate = stageOf(safeStages, "gate");
  const evidence = stageOf(safeStages, "evidence");
  const validation = stageOf(safeStages, "validation");

  const rerankFallback = (rerank["fallback"] as string | null) ?? null;
  const isGrounded = gate["grounded"] === true && !refused;

  // Latency segments
  const stageTimings = [
    {
      id: "embedding",
      label: "Query Expansion",
      ms: num(embedding["latencyMs"]) ?? 0,
      color: "bg-blue-500",
      textColor: "text-blue-400",
    },
    {
      id: "dense",
      label: "Dense Retrieval (pgvector)",
      ms: num(dense["latencyMs"]) ?? 0,
      color: "bg-emerald-500",
      textColor: "text-emerald-400",
    },
    {
      id: "lexical",
      label: "Lexical Search (tsvector)",
      ms: num(lexical["latencyMs"]) ?? 0,
      color: "bg-amber-500",
      textColor: "text-amber-400",
    },
    {
      id: "rerank",
      label: "Reranking",
      ms: num(rerank["latencyMs"]) ?? 0,
      color: "bg-violet-500",
      textColor: "text-violet-400",
    },
    {
      id: "generation",
      label: "Generation & Validation",
      ms: num(validation["latencyMs"]) ?? num(generationLatencyMs) ?? 0,
      color: "bg-pink-500",
      textColor: "text-pink-400",
    },
  ];

  const sumStageMs = stageTimings.reduce((acc, s) => acc + s.ms, 0);
  const effectiveTotalMs = Math.max(totalLatencyMs ?? 0, sumStageMs, 1);

  return (
    <div className="space-y-6" data-testid="trace-waterfall">
      {/* 1. Diagnostic Warning & Refusal Callouts */}
      {rerankFallback && (
        <div
          data-testid="reranker-fallback-alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <span className="font-semibold text-amber-300">
              Reranker Fallback Active: {rerankFallback}
            </span>
            <p className="mt-0.5 text-amber-300/80">
              {rerankFallback === "timeout"
                ? "LLM reranker exceeded the 5000ms wall-clock ceiling. Pipeline safely fell back to reciprocal rank heuristic scoring."
                : "Reranker provider encountered an upstream error. Heuristic fusion scores preserved."}
            </p>
          </div>
        </div>
      )}

      {(!isGrounded || gateReason) && (
        <div
          data-testid="evidence-gate-refusal-alert"
          className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground"
        >
          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
          <div>
            <span className="font-semibold text-destructive">
              Grounded Refusal Triggered (Evidence Gated)
            </span>
            <p className="mt-0.5 text-muted-foreground">
              Reason: <code className="text-foreground">{String(gateReason ?? gate["reason"] ?? "insufficient_evidence")}</code>
            </p>
          </div>
        </div>
      )}

      {/* 2. Timeline Gantt & Stage Relative Latency */}
      <Card className="border-border/60 bg-card/40 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Stage Latency Breakdown
          </h4>
          <span className="text-xs text-muted-foreground">
            Total Pipeline Duration:{" "}
            <strong className="text-foreground tabular-nums">
              {Math.round(totalLatencyMs ?? sumStageMs)} ms
            </strong>
          </span>
        </div>

        {/* Proportional Multi-Segment Gantt Bar */}
        <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-muted/40" data-testid="gantt-bar">
          {stageTimings.map((stage) => {
            const pctVal = effectiveTotalMs > 0 ? (stage.ms / effectiveTotalMs) * 100 : 0;
            if (pctVal <= 0) return null;
            return (
              <div
                key={stage.id}
                title={`${stage.label}: ${Math.round(stage.ms)}ms (${pctVal.toFixed(1)}%)`}
                className={cn("h-full transition-all", stage.color)}
                style={{ width: `${pctVal}%` }}
              />
            );
          })}
        </div>

        {/* Individual Stage Metrics */}
        <div className="space-y-2">
          {stageTimings.map((stage) => {
            const pctVal = effectiveTotalMs > 0 ? (stage.ms / effectiveTotalMs) * 100 : 0;
            return (
              <div key={stage.id} className="flex items-center gap-3 text-xs">
                <span className="flex w-44 shrink-0 items-center gap-1.5 font-medium text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", stage.color)} />
                  {stage.label}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/30">
                  <div
                    className={cn("h-full rounded-full", stage.color)}
                    style={{ width: `${Math.max(pctVal, stage.ms > 0 ? 2 : 0)}%` }}
                  />
                </div>
                <span className="w-14 text-right tabular-nums text-muted-foreground">
                  {pctVal.toFixed(1)}%
                </span>
                <span className="w-16 text-right font-mono tabular-nums text-foreground">
                  {Math.round(stage.ms)} ms
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 3. Evidence Gate Threshold Meter */}
      <Card className="border-border/60 bg-card/40 p-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Evidence Gate & Score Floors
        </h4>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border/40 bg-card/20 p-2.5">
            <span className="text-[11px] text-muted-foreground">Gate Verdict</span>
            <div className="mt-1 flex items-center gap-1.5">
              {isGrounded ? (
                <Badge variant="default" className="gap-1 bg-emerald-600/80 text-white hover:bg-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> Grounded
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" /> Refused
                </Badge>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-card/20 p-2.5">
            <span className="text-[11px] text-muted-foreground">Rerank Score (Floor: 0.35)</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {fmt(gate["bestRerankScore"])}
              </span>
              {(num(gate["bestRerankScore"]) ?? 0) >= 0.35 ? (
                <span className="text-[10px] text-emerald-400">✓ PASS</span>
              ) : (
                <span className="text-[10px] text-destructive">✗ BELOW FLOOR</span>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-card/20 p-2.5">
            <span className="text-[11px] text-muted-foreground">Cosine Similarity (Floor: 0.30)</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {fmt(gate["bestSimilarity"])}
              </span>
              {(num(gate["bestSimilarity"]) ?? 0) >= 0.3 ? (
                <span className="text-[10px] text-emerald-400">✓ PASS</span>
              ) : (
                <span className="text-[10px] text-destructive">✗ BELOW FLOOR</span>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-card/20 p-2.5">
            <span className="text-[11px] text-muted-foreground">Evidence Context</span>
            <div className="mt-1 text-xs text-muted-foreground">
              <strong className="text-foreground">{num(evidence["count"]) ?? 0}</strong> passages ·{" "}
              <strong className="text-foreground">{num(evidence["contextTokens"]) ?? 0}</strong> tokens
            </div>
          </div>
        </div>
      </Card>

      {/* 4. RRF Rank Shift Matrix */}
      <Card className="border-border/60 bg-card/40 p-4">
        <button
          type="button"
          onClick={() => setShowRrfMatrix((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            {showRrfMatrix ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              RRF Rank Shift Matrix (Top Candidates)
            </h4>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {rowsOf(fusion, "rrfTop").length} candidates
          </Badge>
        </button>

        {showRrfMatrix && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="rrf-matrix-table">
              <thead className="border-b border-border/40 text-[11px] text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">RRF Rank</th>
                  <th className="pb-2 font-medium">Chunk / Filename</th>
                  <th className="pb-2 font-medium text-center">Dense Pos</th>
                  <th className="pb-2 font-medium text-center">Lexical Pos</th>
                  <th className="pb-2 text-right font-medium">RRF Score</th>
                  <th className="pb-2 text-right font-medium">Rerank Score</th>
                  <th className="pb-2 text-center font-medium">Rank Shift</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20 tabular-nums">
                {rowsOf(fusion, "rrfTop").map((row, index) => {
                  const densePos = num(row["densePosition"]);
                  const lexicalPos = num(row["lexicalPosition"]);
                  const bestOriginal =
                    densePos !== null && lexicalPos !== null
                      ? Math.min(densePos, lexicalPos)
                      : (densePos ?? lexicalPos ?? index);

                  const delta = bestOriginal - index; // positive = promoted, negative = demoted

                  return (
                    <tr key={index} className="hover:bg-muted/20">
                      <td className="py-1.5 font-mono font-medium text-foreground">#{index + 1}</td>
                      <td className="py-1.5">
                        <span className="font-medium text-foreground">
                          {String(row["filename"] ?? row["chunkId"] ?? "")}
                        </span>
                        {row["page"] !== undefined && (
                          <span className="text-muted-foreground"> · p.{String(row["page"])}</span>
                        )}
                      </td>
                      <td className="py-1.5 text-center text-muted-foreground">
                        {densePos !== null ? `#${densePos + 1}` : "—"}
                      </td>
                      <td className="py-1.5 text-center text-muted-foreground">
                        {lexicalPos !== null ? `#${lexicalPos + 1}` : "—"}
                      </td>
                      <td className="py-1.5 text-right font-mono text-muted-foreground">
                        {fmt(row["fusionScore"], 4)}
                      </td>
                      <td className="py-1.5 text-right font-mono text-foreground font-semibold">
                        {fmt(row["rerankScore"])}
                      </td>
                      <td className="py-1.5 text-center">
                        {delta > 0 ? (
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                            ↑ +{delta}
                          </span>
                        ) : delta < 0 ? (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                            ↓ {delta}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 5. Hybrid Retrieval Split (Dense vs. Lexical) */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setShowTables((v) => !v)}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {showTables ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Hybrid Retrieval Candidate Tables
        </button>

        {showTables && (
          <div className="grid gap-4 sm:grid-cols-2">
            <CandidateTable
              title={`Dense Candidates (${num(dense["count"]) ?? 0})`}
              rows={rowsOf(dense)}
              scoreKey="similarity"
              scoreLabel="Cosine"
            />
            <CandidateTable
              title={`Lexical Candidates (${num(lexical["count"]) ?? 0})`}
              rows={rowsOf(lexical)}
              scoreKey="lexicalRank"
              scoreLabel="ts_rank"
            />
          </div>
        )}
      </div>

      {/* 6. Citations & Delivery Stage */}
      <Card className="border-border/60 bg-card/40 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Citation Verification & Delivery
            </h4>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {String(validation["contractVersion"] ?? "citation-contract/v1")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Cited: <strong className="text-foreground">{safeCitations.length}</strong> sources
            </span>
          </div>
        </div>

        {safeCitations.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5" data-testid="citations-list">
            {safeCitations.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-xs">
                [{c}]
              </Badge>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {rowsOf(evidence, "sources").map((source, index) => (
            <div
              key={index}
              className="rounded-lg border border-border/40 bg-card/20 p-2.5 text-xs transition-colors hover:border-border/80"
            >
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                    {String(source["sourceId"] ?? `source_${String(index + 1).padStart(2, "0")}`)}
                  </code>
                  <span className="font-medium text-foreground">{String(source["filename"] ?? "")}</span>
                  <span className="text-muted-foreground">p. {String(source["page"] ?? "?")}</span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  cosine {fmt(source["similarity"])} · rerank {fmt(source["rerankScore"])}
                </div>
              </div>
              <p className="line-clamp-2 text-muted-foreground">
                {String(source["preview"] ?? source["snippet"] ?? "")}
              </p>
            </div>
          ))}
          {rowsOf(evidence, "sources").length === 0 && (
            <p className="py-2 text-center text-xs text-muted-foreground">No evidence sources delivered.</p>
          )}
        </div>
      </Card>
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
      <h5 className="mb-2 text-xs font-semibold text-foreground">{title}</h5>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No candidates retrieved.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border/30 text-[11px] text-muted-foreground">
              <tr>
                <th className="pb-1 text-left font-normal">#</th>
                <th className="pb-1 text-left font-normal">Chunk</th>
                <th className="pb-1 text-right font-normal">{scoreLabel}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row, index) => (
                <tr key={index} className="border-t border-border/20">
                  <td className="py-1 text-muted-foreground">{index + 1}</td>
                  <td className="py-1">
                    <span className="text-foreground">
                      {String(row["filename"] ?? row["chunkId"] ?? "")}
                    </span>
                    {row["page"] !== undefined && (
                      <span className="text-muted-foreground"> · p.{String(row["page"])}</span>
                    )}
                  </td>
                  <td className="py-1 text-right font-mono">{fmt(row[scoreKey])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
