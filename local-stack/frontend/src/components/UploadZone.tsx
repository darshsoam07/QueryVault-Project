import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function UploadZone() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadDocument(file);
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleFiles = (list: FileList | null) => {
    if (!list?.length) return;
    upload.mutate(Array.from(list));
  };

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "cursor-pointer rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-cyan bg-elevated" : "border-line hover:border-muted/60",
        )}
      >
        <UploadCloud className="mx-auto mb-3 text-muted" size={22} />
        <p className="text-sm text-ink">Drop your documents here</p>
        <p className="mt-1 text-xs text-muted">
          {upload.isPending ? "Uploading and indexing..." : "PDF only — click to browse"}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(event) => handleFiles(event.target.files)}
        />
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
