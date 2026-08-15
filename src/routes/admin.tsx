/**
 * Operator diagnostics. Gated twice: the UI hides itself for non-operators and
 * every server function re-checks the caller's role against `user_roles`.
 */
import { VaultMark } from "@/components/queryvault/brand";
import { TraceWaterfall } from "@/components/queryvault/TraceWaterfall";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import {
  getObservabilitySummary,
  getOperatorStatus,
  getQueryTrace,
  listQueryTraces,
  listRecentEvents,
} from "@/lib/admin.functions";
import { pct } from "@/lib/observability/metrics";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Activity, ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Diagnostics — QueryVault" },
      {
        name: "description",
        content:
          "Operator diagnostics for QueryVault: API latency, retrieval quality, ingestion health and per-query pipeline traces.",
      },
      { property: "og:title", content: "QueryVault Diagnostics" },
      {
        property: "og:description",
        content: "Latency, groundedness, refusal rate, ingestion health and query trajectories.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

const WINDOWS = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
];

function AdminPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const status = useServerFn(getOperatorStatus);
  const [windowMinutes, setWindowMinutes] = useState(60);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  const access = useQuery({
    queryKey: ["operator-status", user?.id],
    queryFn: () => status({}),
    enabled: Boolean(user),
  });

  if (loading || !user || access.isLoading) {
    return (
      <div className="grid-void flex h-screen items-center justify-center">
        <VaultMark className="h-10 w-10 animate-pulse" />
      </div>
    );
  }

  if (!access.data?.isOperator) {
    return (
      <div className="grid-void flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <VaultMark className="h-10 w-10 opacity-60" />
        <h1 className="text-lg font-medium">Diagnostics are restricted</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This area is limited to accounts with the operator or admin role. Ask a workspace admin to
          grant access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/chat">Back to workspace</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid-void min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
          <Link to="/chat" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Activity className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-medium tracking-tight">Diagnostics</h1>
          <div className="ml-auto flex items-center gap-1">
            {WINDOWS.map((option) => (
              <Button
                key={option.minutes}
                size="sm"
                variant={windowMinutes === option.minutes ? "secondary" : "ghost"}
                onClick={() => setWindowMinutes(option.minutes)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        <Tabs defaultValue="metrics">
          <TabsList>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="traces">Query traces</TabsTrigger>
            <TabsTrigger value="events">Event stream</TabsTrigger>
          </TabsList>
          <TabsContent value="metrics" className="mt-6">
            <MetricsPanel windowMinutes={windowMinutes} />
          </TabsContent>
          <TabsContent value="traces" className="mt-6">
            <TracesPanel />
          </TabsContent>
          <TabsContent value="events" className="mt-6">
            <EventsPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

function ms(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "—";
}

function MetricsPanel({ windowMinutes }: { windowMinutes: number }) {
  const load = useServerFn(getObservabilitySummary);
  const query = useQuery({
    queryKey: ["observability-summary", windowMinutes],
    queryFn: () => load({ data: { windowMinutes } }),
    refetchInterval: 30_000,
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading metrics…</p>;
  if (query.isError) return <p className="text-sm text-destructive">Metrics unavailable.</p>;

  const s = query.data!;
  const answered = s.rag.answers || 0;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          API
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Requests" value={String(s.api.requests)} />
          <Metric
            label="Error rate"
            value={pct(s.api.error_rate)}
            hint={`${s.api.errors} failed`}
          />
          <Metric label="p95 latency" value={ms(s.api.p95_ms)} hint={`p50 ${ms(s.api.p50_ms)}`} />
          <Metric label="p99 latency" value={ms(s.api.p99_ms)} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Retrieval quality
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Grounded rate"
            value={answered ? pct(s.rag.grounded / answered) : "—"}
            hint={`${s.rag.grounded}/${answered} answered`}
          />
          <Metric
            label="Refusal rate"
            value={answered ? pct(s.rag.refusals / answered) : "—"}
            hint={`${s.rag.refusals} refusals`}
          />
          <Metric
            label="Retrieval p95"
            value={ms(s.rag.retrieval_p95_ms)}
            hint={`p50 ${ms(s.rag.retrieval_p50_ms)}`}
          />
          <Metric
            label="Generation p95"
            value={ms(s.rag.generation_p95_ms)}
            hint={`p50 ${ms(s.rag.generation_p50_ms)}`}
          />
          <Metric label="Avg passages used" value={(s.rag.avg_hits ?? 0).toFixed(1)} />
          <Metric label="Avg best cosine" value={(s.rag.avg_best_similarity ?? 0).toFixed(3)} />
          <Metric label="Avg best rerank" value={(s.rag.avg_best_rerank ?? 0).toFixed(3)} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Ingestion
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Succeeded" value={String(s.ingestion.succeeded)} />
          <Metric
            label="Failed"
            value={String(s.ingestion.failed)}
            hint={`${s.ingestion.retries} retries`}
          />
          <Metric
            label="In flight"
            value={String(s.ingestion.queued + s.ingestion.running + s.ingestion.retrying)}
            hint={`${s.ingestion.queued} queued · ${s.ingestion.running} running`}
          />
          <Metric label="Avg duration" value={ms(s.ingestion.avg_duration_ms)} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          AI usage
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Embedding calls"
            value={String(s.cost.embedding_calls)}
            hint={`${s.cost.embedded_texts} texts`}
          />
          <Metric label="Generations" value={String(s.cost.generation_calls)} />
          <Metric label="Context tokens" value={String(s.cost.context_tokens)} />
          <Metric
            label="Model tokens"
            value={String(s.cost.prompt_tokens + s.cost.completion_tokens)}
            hint={`${s.cost.prompt_tokens} in · ${s.cost.completion_tokens} out`}
          />
        </div>
      </section>
    </div>
  );
}

function TracesPanel() {
  const list = useServerFn(listQueryTraces);
  const detail = useServerFn(getQueryTrace);
  const [onlyRefused, setOnlyRefused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const traces = useQuery({
    queryKey: ["query-traces", onlyRefused],
    queryFn: () => list({ data: { limit: 40, onlyRefused } }),
    refetchInterval: 30_000,
  });

  const trace = useQuery({
    queryKey: ["query-trace", selected],
    queryFn: () => detail({ data: { traceId: selected! } }),
    enabled: Boolean(selected),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Card className="border-border/60 bg-card/40 p-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Button
            size="sm"
            variant={onlyRefused ? "secondary" : "ghost"}
            onClick={() => setOnlyRefused((value) => !value)}
          >
            Refusals only
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void traces.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <ScrollArea className="h-[60vh]">
          <ul className="divide-y divide-border/50">
            {(traces.data ?? []).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelected(row.id)}
                  className={`w-full px-3 py-2 text-left text-xs hover:bg-muted/30 ${
                    selected === row.id ? "bg-muted/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={row.refused ? "destructive" : "secondary"}>
                      {row.refused ? "refused" : "grounded"}
                    </Badge>
                    <span className="text-muted-foreground tabular-nums">
                      {ms(row.total_latency_ms)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-foreground">{row.question}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {new Date(row.created_at).toLocaleTimeString()} · {row.reranker ?? "no rerank"}
                  </p>
                </button>
              </li>
            ))}
            {(traces.data ?? []).length === 0 && !traces.isLoading ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                No traces recorded yet.
              </li>
            ) : null}
          </ul>
        </ScrollArea>
      </Card>

      <Card className="border-border/60 bg-card/40 p-4">
        {!selected ? (
          <p className="text-sm text-muted-foreground">
            Select a query to inspect its full trajectory.
          </p>
        ) : trace.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading trace…</p>
        ) : trace.isError || !trace.data ? (
          <p className="text-sm text-destructive">That trace is unavailable.</p>
        ) : (
          <div className="space-y-5">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Question</p>
              <p className="mt-1 text-sm">{trace.data.question}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                request {trace.data.request_id} · total {ms(trace.data.total_latency_ms)} ·
                retrieval {ms(trace.data.retrieval_latency_ms)} · generation{" "}
                {ms(trace.data.generation_latency_ms)}
              </p>
            </div>
            <TraceWaterfall
              stages={(trace.data.stages ?? {}) as Record<string, unknown>}
              totalLatencyMs={trace.data.total_latency_ms}
            />
            {trace.data.answer_preview ? (
              <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground">
                  Answer (truncated)
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {trace.data.answer_preview}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function EventsPanel() {
  const load = useServerFn(listRecentEvents);
  const events = useQuery({
    queryKey: ["telemetry-events"],
    queryFn: () => load({ data: { limit: 80 } }),
    refetchInterval: 15_000,
  });

  return (
    <Card className="border-border/60 bg-card/40 p-0">
      <ScrollArea className="h-[65vh]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card/90 text-muted-foreground backdrop-blur">
            <tr>
              <th className="px-3 py-2 text-left font-normal">time</th>
              <th className="px-3 py-2 text-left font-normal">event</th>
              <th className="px-3 py-2 text-left font-normal">status</th>
              <th className="px-3 py-2 text-left font-normal">request</th>
              <th className="px-3 py-2 text-right font-normal">latency</th>
            </tr>
          </thead>
          <tbody>
            {(events.data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-border/40">
                <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                  {new Date(row.created_at).toLocaleTimeString()}
                </td>
                <td className="px-3 py-1.5">{row.event}</td>
                <td className="px-3 py-1.5">
                  <Badge
                    variant={
                      row.status === "error"
                        ? "destructive"
                        : row.status === "refused"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {row.status}
                    {row.error_code ? ` · ${row.error_code}` : ""}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                  {row.request_id}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{ms(row.latency_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(events.data ?? []).length === 0 && !events.isLoading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">No events yet.</p>
        ) : null}
      </ScrollArea>
    </Card>
  );
}
