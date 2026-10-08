import type { ReactNode } from "react";

export default function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1.5 text-xs text-muted">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
