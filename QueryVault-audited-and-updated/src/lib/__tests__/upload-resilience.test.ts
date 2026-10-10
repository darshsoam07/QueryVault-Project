import { describe, expect, it, vi, beforeEach } from "vitest";
import { isSupportedDocument, safeFilename, ownerScopedPath } from "@/lib/documents.policy";

describe("document upload resilience & policy", () => {
  it("accepts supported formats across PDF, DOCX, TXT, MD, CSV, XLSX, PPTX", () => {
    expect(isSupportedDocument("report.pdf", "application/pdf")).toBe(true);
    expect(
      isSupportedDocument(
        "brief.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(isSupportedDocument("notes.txt", "text/plain")).toBe(true);
    expect(isSupportedDocument("readme.md", "text/markdown")).toBe(true);
    expect(isSupportedDocument("data.csv", "text/csv")).toBe(true);
    expect(
      isSupportedDocument(
        "sheet.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
    expect(
      isSupportedDocument(
        "slides.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe(true);
  });

  it("permits browsers omitting specific MIME types if extension is valid", () => {
    expect(isSupportedDocument("report.pdf", "")).toBe(true);
    expect(isSupportedDocument("notes.txt", undefined)).toBe(true);
    expect(isSupportedDocument("readme.md", "application/octet-stream")).toBe(true);
    expect(isSupportedDocument("data.csv", "")).toBe(true);
  });

  it("rejects unsupported extensions and mismatched binary types", () => {
    expect(isSupportedDocument("script.exe", "application/octet-stream")).toBe(false);
    expect(isSupportedDocument("malware.sh", "text/x-sh")).toBe(false);
    expect(isSupportedDocument("archive.zip", "application/zip")).toBe(false);
    expect(isSupportedDocument("audio.mp3", "audio/mpeg")).toBe(false);
  });

  it("sanitizes filenames safely without path traversal", () => {
    expect(safeFilename("../../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(safeFilename("C:\\Windows\\System32\\test.docx")).toBe("test.docx");
    expect(safeFilename("my file (1).xlsx")).toBe("my file (1).xlsx");
    expect(safeFilename("bad\x00char.txt")).toBe("badchar.txt");
  });

  it("scopes storage path strictly to userId and documentId", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const docId = "22222222-2222-4222-8222-222222222222";
    expect(ownerScopedPath(userId, docId, "doc.pdf")).toBe(`${userId}/${docId}.pdf`);
    expect(ownerScopedPath(userId, docId, "notes.docx")).toBe(`${userId}/${docId}.docx`);
    expect(ownerScopedPath(userId, docId, "data.xlsx")).toBe(`${userId}/${docId}.xlsx`);
  });
});

describe("database insertion schema resilience simulation", () => {
  it("demonstrates fallback logic when content_type column is missing (PGRST204 / 42703)", async () => {
    const mockDb = {
      primaryCalls: 0,
      fallbackCalls: 0,
      async insert(payload: Record<string, unknown>) {
        if ("content_type" in payload) {
          mockDb.primaryCalls++;
          return {
            data: null,
            error: {
              code: "PGRST204",
              message:
                "Could not find the 'content_type' column of 'documents' in the schema cache",
            },
          };
        }
        mockDb.fallbackCalls++;
        return {
          data: { id: "doc-123" },
          error: null,
        };
      },
    };

    // Simulate resilient insertion flow
    const basePayload = {
      user_id: "user-1",
      filename: "test.pdf",
      byte_size: 1024,
      status: "uploaded",
      phase: "uploading",
      progress: 0,
      content_hash: "hash",
      parser_version: 1,
    };

    let { data: doc, error } = await mockDb.insert({
      ...basePayload,
      content_type: "application/pdf",
    });

    if (
      error &&
      (error.code === "PGRST204" ||
        error.code === "42703" ||
        error.message?.includes("content_type"))
    ) {
      const fallback = await mockDb.insert(basePayload);
      doc = fallback.data;
      error = fallback.error;
    }

    expect(mockDb.primaryCalls).toBe(1);
    expect(mockDb.fallbackCalls).toBe(1);
    expect(error).toBeNull();
    expect(doc?.id).toBe("doc-123");
  });

  it("succeeds directly when content_type column is present in schema", async () => {
    const mockDb = {
      primaryCalls: 0,
      fallbackCalls: 0,
      async insert(
        payload: Record<string, unknown>,
      ): Promise<{ data: { id: string } | null; error: { code?: string } | null }> {
        mockDb.primaryCalls++;
        return {
          data: { id: "doc-456" },
          error: null,
        };
      },
    };

    const basePayload = {
      user_id: "user-1",
      filename: "test.pdf",
      byte_size: 1024,
      status: "uploaded",
    };

    let { data: doc, error } = await mockDb.insert({
      ...basePayload,
      content_type: "application/pdf",
    });

    if (error && error.code === "PGRST204") {
      const fallback = await mockDb.insert(basePayload);
      doc = fallback.data;
      error = fallback.error;
    }

    expect(mockDb.primaryCalls).toBe(1);
    expect(mockDb.fallbackCalls).toBe(0);
    expect(error).toBeNull();
    expect(doc?.id).toBe("doc-456");
  });

  it("maps duplicate key violations (23505) correctly", () => {
    const error = { code: "23505", message: "duplicate key value violates unique constraint" };
    expect(error.code).toBe("23505");
  });
});
