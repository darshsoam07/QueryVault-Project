// @vitest-environment jsdom
/**
 * Primary user flows in the knowledge panel, exercised through the DOM.
 *
 * This is the document side of the product: upload a PDF, watch it index, scope
 * a query to it, delete it. Those are the flows a user actually performs, so
 * they are tested by rendering the real component and clicking real buttons —
 * not by calling its helpers.
 *
 * The environment is declared per-file rather than globally: every other test in
 * this suite is pure Node, and paying for a jsdom document in all of them to
 * serve one file would be a poor trade.
 *
 * Network and server boundaries are mocked (Supabase, the server functions, the
 * ingest helpers). The component under test is real, including its react-query
 * wiring. What this cannot cover: styling, and the fact that the drop zone is
 * `display: none` by Tailwind class — jsdom does not apply the stylesheet.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Boundary mocks
// ---------------------------------------------------------------------------

const order = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ select: () => ({ order: (...a: unknown[]) => order(...a) }) }),
  },
}));

const deleteDocument = vi.fn();
const reindexDocument = vi.fn();
const runIngestionWorker = vi.fn();
vi.mock("@/lib/documents.functions", () => ({
  deleteDocument: (...a: unknown[]) => deleteDocument(...a),
  reindexDocument: (...a: unknown[]) => reindexDocument(...a),
  runIngestionWorker: (...a: unknown[]) => runIngestionWorker(...a),
}));

const uploadAndEnqueue = vi.fn();
const pollIngestion = vi.fn();
vi.mock("@/lib/ingest", () => ({
  uploadAndEnqueue: (...a: unknown[]) => uploadAndEnqueue(...a),
  pollIngestion: (...a: unknown[]) => pollIngestion(...a),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { KnowledgePanel, type DocumentRow } from "@/components/queryvault/KnowledgePanel";

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";

function doc(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc-ready",
    filename: "annual-report.pdf",
    status: "ready",
    phase: "indexed",
    progress: 100,
    chunk_count: 42,
    page_count: 18,
    byte_size: 2 * 1024 * 1024,
    error_message: null,
    failure_message: null,
    ...overrides,
  };
}

function renderPanel(rows: DocumentRow[], onToggleSelected = vi.fn(), selected: string[] = []) {
  order.mockResolvedValue({ data: rows, error: null });
  const client = new QueryClient({
    // Retries would make a failed-path assertion wait on backoff timers.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <KnowledgePanel userId={USER} selected={selected} onToggleSelected={onToggleSelected} />
    </QueryClientProvider>,
  );
  return { ...utils, onToggleSelected };
}

function pdf(name = "report.pdf", size = 1024, type = "application/pdf") {
  const file = new File(["%PDF-1.7"], name, { type });
  // File size is read-only; the component checks it, so it has to be set.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function fileInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input!;
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadAndEnqueue.mockResolvedValue({ documentId: "doc-new", jobId: "job-1" });
  pollIngestion.mockResolvedValue({ failed: false, label: "Indexed", step: 6, totalSteps: 6 });
  deleteDocument.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Viewing the knowledge base
// ---------------------------------------------------------------------------

describe("knowledge base list", () => {
  it("guides the user when there are no documents yet", async () => {
    renderPanel([]);
    expect(await screen.findByText(/No documents yet/i)).toBeTruthy();
  });

  it("shows an indexed document with its real chunk and page counts", async () => {
    renderPanel([doc()]);

    expect(await screen.findByText("annual-report.pdf")).toBeTruthy();
    // Counts come from the row, not from a placeholder.
    expect(screen.getByText(/42 chunks · 18p · 2\.0 MB/)).toBeTruthy();
  });

  it("shows honest phase progress while a document is still indexing", async () => {
    renderPanel([doc({ id: "doc-mid", status: "processing", phase: "embedding" })]);

    // A step counter, not an invented percentage.
    expect(await screen.findByText(/step \d+\/\d+/)).toBeTruthy();
  });

  it("surfaces the failure reason on a failed document", async () => {
    renderPanel([
      doc({
        id: "doc-bad",
        status: "failed",
        failure_message: "That PDF has no extractable text.",
      }),
    ]);

    expect(await screen.findByText("That PDF has no extractable text.")).toBeTruthy();
    // A failed document is the one case where retry is offered.
    expect(screen.getByLabelText(/^Retry /)).toBeTruthy();
  });

  it("offers no retry control for a healthy document", async () => {
    renderPanel([doc()]);
    await screen.findByText("annual-report.pdf");
    expect(screen.queryByLabelText(/^Retry /)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scoping a query to selected documents
// ---------------------------------------------------------------------------

describe("scoping a query", () => {
  it("selects a ready document", async () => {
    const { onToggleSelected } = renderPanel([doc()]);

    fireEvent.click(await screen.findByText("annual-report.pdf"));
    expect(onToggleSelected).toHaveBeenCalledWith("doc-ready");
  });

  it("refuses to scope a query to a document that is not indexed yet", async () => {
    const { onToggleSelected } = renderPanel([
      doc({ id: "doc-mid", filename: "draft.pdf", status: "processing", phase: "chunking" }),
    ]);

    fireEvent.click(await screen.findByText("draft.pdf"));
    // Retrieval over a partially-indexed document would silently return an
    // incomplete corpus, which is worse than not offering the option.
    expect(onToggleSelected).not.toHaveBeenCalled();
  });

  it("reports how many documents the query is scoped to", async () => {
    renderPanel([doc()], vi.fn(), ["doc-ready", "doc-two"]);
    expect(await screen.findByText(/Scoped to 2 documents/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

describe("upload flow", () => {
  it("uploads a PDF and reports success once indexing finishes", async () => {
    const { container } = renderPanel([]);
    await screen.findByText(/No documents yet/i);

    const file = pdf();
    fireEvent.change(fileInput(container), { target: { files: [file] } });

    await waitFor(() => expect(uploadAndEnqueue).toHaveBeenCalledOnce());
    expect(uploadAndEnqueue.mock.calls[0]?.[0]).toBe(file);
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Document indexed and ready to query"),
    );
  });

  it("rejects a non-PDF before it reaches the network", async () => {
    const { container } = renderPanel([]);
    await screen.findByText(/No documents yet/i);

    fireEvent.change(fileInput(container), {
      target: { files: [pdf("notes.txt", 1024, "text/plain")] },
    });

    expect(toastError).toHaveBeenCalledWith("Only PDF files are supported today.");
    expect(uploadAndEnqueue).not.toHaveBeenCalled();
  });

  it("rejects an oversized PDF before it reaches the network", async () => {
    const { container } = renderPanel([]);
    await screen.findByText(/No documents yet/i);

    fireEvent.change(fileInput(container), {
      target: { files: [pdf("huge.pdf", 26 * 1024 * 1024)] },
    });

    expect(toastError).toHaveBeenCalledWith("PDFs must be under 25 MB.");
    expect(uploadAndEnqueue).not.toHaveBeenCalled();
  });

  it("reports a server-side ingestion failure instead of claiming success", async () => {
    pollIngestion.mockResolvedValue({
      failed: true,
      label: "Failed",
      reason: "That PDF is encrypted.",
      step: 3,
      totalSteps: 6,
    });
    const { container } = renderPanel([]);
    await screen.findByText(/No documents yet/i);

    fireEvent.change(fileInput(container), { target: { files: [pdf()] } });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That PDF is encrypted."));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe("deletion flow", () => {
  it("deletes exactly the document whose control was clicked", async () => {
    renderPanel([doc(), doc({ id: "doc-other", filename: "other.pdf" })]);

    fireEvent.click(await screen.findByLabelText("Delete other.pdf"));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledOnce());
    expect(deleteDocument).toHaveBeenCalledWith({ data: { documentId: "doc-other" } });
  });

  it("confirms removal to the user", async () => {
    renderPanel([doc()]);
    fireEvent.click(await screen.findByLabelText("Delete annual-report.pdf"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Document removed"));
  });

  it("redacts a raw Postgres error instead of rendering it", async () => {
    // The realistic leak: a PostgREST error object reaching a toast handler.
    // 42501 is an RLS denial, and its raw text names the policy and the table.
    deleteDocument.mockRejectedValue({
      code: "42501",
      message: "permission denied for table document_chunks",
      details: 'policy "document_chunks_own" blocked this row',
      hint: null,
    });
    renderPanel([doc()]);

    fireEvent.click(await screen.findByLabelText("Delete annual-report.pdf"));

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    const message = String(toastError.mock.calls[0]?.[0]);
    expect(message).toBe("You do not have access to that.");
    // The schema stays server-side.
    expect(message).not.toContain("document_chunks");
    expect(message).not.toContain("policy");
    expect(message).not.toMatch(/permission denied/i);
  });

  it("passes a curated server message through unchanged", async () => {
    // Server functions throw `ApiError` with product-language text. Replacing it
    // with the generic fallback would lose information the user needs.
    deleteDocument.mockRejectedValue(new Error("That document no longer exists."));
    renderPanel([doc()]);

    fireEvent.click(await screen.findByLabelText("Delete annual-report.pdf"));

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError.mock.calls[0]?.[0]).toBe("That document no longer exists.");
  });

  it("falls back to product language when the failure carries no message", async () => {
    deleteDocument.mockRejectedValue(new Error(""));
    renderPanel([doc()]);

    fireEvent.click(await screen.findByLabelText("Delete annual-report.pdf"));

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError.mock.calls[0]?.[0]).toBe("Could not remove that document.");
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry flow", () => {
  it("queues a reindex and drains the worker for the failed document", async () => {
    renderPanel([doc({ id: "doc-bad", status: "failed", failure_message: "Timed out." })]);

    fireEvent.click(await screen.findByLabelText("Retry annual-report.pdf"));

    await waitFor(() => expect(reindexDocument).toHaveBeenCalledOnce());
    expect(reindexDocument).toHaveBeenCalledWith({ data: { documentId: "doc-bad" } });
    // Queueing alone would leave the job waiting for the next drain tick.
    await waitFor(() => expect(runIngestionWorker).toHaveBeenCalledOnce());
  });
});
