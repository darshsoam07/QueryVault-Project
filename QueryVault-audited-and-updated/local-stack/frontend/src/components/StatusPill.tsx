import { useHealth } from "@/hooks/useHealth";
import { cn } from "@/lib/utils";

export default function StatusPill() {
  const { data, isError, isLoading } = useHealth();

  const ok = Boolean(data?.ollama_reachable && data?.model_available);
  const label = isLoading
    ? "Checking..."
    : isError
      ? "Backend offline"
      : !data?.ollama_reachable
        ? "Ollama not running"
        : !data?.model_available
          ? `${data.model} not installed`
          : "System ready";

  return (
    <div className="glass flex items-center gap-2 rounded-full px-3 py-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-400" : isLoading ? "bg-muted" : "bg-amber-400",
        )}
      />
      <span className="font-mono text-[11px] text-muted">{label}</span>
    </div>
  );
}
