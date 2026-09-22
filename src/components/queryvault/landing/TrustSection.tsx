import React, { useState } from "react";
import { Activity, Check, Copy, Terminal } from "lucide-react";

interface Metric {
  label: string;
  value: string;
  target: string;
  status: "passed" | "nominal";
}

const METRICS: Metric[] = [
  { label: "Recall @ 5", value: "1.00", target: "≥ 0.95", status: "passed" },
  { label: "Recall @ 10", value: "1.00", target: "≥ 0.98", status: "passed" },
  { label: "MRR", value: "0.925", target: "≥ 0.90", status: "passed" },
  { label: "NDCG @ 10", value: "0.95", target: "≥ 0.90", status: "passed" },
  { label: "Citation Validity", value: "1.00", target: "1.00", status: "passed" },
  { label: "Refusal Accuracy", value: "1.00", target: "≥ 0.98", status: "passed" },
  { label: "False Refusal Rate", value: "0.00", target: "≤ 0.02", status: "passed" },
  { label: "Injection Defense", value: "1.00", target: "1.00", status: "passed" },
];

export function TrustSection() {
  const [copied, setCopied] = useState(false);

  const copyCommand = () => {
    navigator.clipboard.writeText("npm run eval:gate");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="border-b border-white/[0.06] bg-[#09090b] py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-6 sm:px-8">
        {/* Section Header with Reproduction Command */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-zinc-400">
              <Activity className="h-3.5 w-3.5 text-zinc-400" />
              Empirical Benchmarks
            </div>
            <h2 className="mt-3 text-2xl font-medium tracking-tight text-zinc-100 sm:text-3xl">
              Measured, not asserted.
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              Offline evaluation fixture across factual lookup, semantic paraphrase, and
              prompt-injection cases.
            </p>
          </div>

          {/* Copyable Evaluator Command */}
          <button
            onClick={copyCommand}
            className="inline-flex h-8 items-center gap-2 self-start rounded-md border border-white/[0.08] bg-zinc-900/60 px-3 font-mono text-xs text-zinc-300 transition-colors hover:border-white/[0.16] hover:text-white"
          >
            <Terminal className="h-3.5 w-3.5 text-zinc-500" />
            <span>npm run eval:gate</span>
            {copied ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3 text-zinc-500" />
            )}
          </button>
        </div>

        {/* Dense Telemetry Matrix Grid */}
        <div className="mt-8 grid grid-cols-2 divide-x divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-zinc-900/20 sm:grid-cols-4 sm:divide-y-0">
          {METRICS.map((metric) => (
            <div key={metric.label} className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  {metric.label}
                </span>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_6px_rgba(52,211,153,0.4)]" />
              </div>

              <div className="mt-3 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-medium tracking-tight text-zinc-100 tabular-nums">
                  {metric.value}
                </span>
                <span className="font-mono text-[10px] text-zinc-500">target {metric.target}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Footer Note */}
        <p className="mt-4 text-[11px] font-mono text-zinc-500">
          * Measured against a 13-case golden fixture set. Fails exit code non-zero if any metric
          falls below threshold.
        </p>
      </div>
    </section>
  );
}
