import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { GROUNDED_REFUSAL } from "../src/lib/chat.schema";

// Real browser/UI, mocked Auth/Postgres/chat boundaries. Never a model-quality test.
test("demo document scope, streamed citations, refusal and request failure", async ({ page }) => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "demo@example.test",
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
  };
  const threadId = "33333333-3333-4333-8333-333333333333";
  const docs = ["harbor-guide.txt", "harbor-travel.txt", "meadow-guide.txt"].map((filename, i) => ({
    id: `22222222-2222-4222-8222-22222222222${i}`,
    filename,
    status: "ready",
    phase: "ready",
    progress: 100,
    chunk_count: 1,
    page_count: 1,
    byte_size: readFileSync(`demo/documents/${filename}`).length,
    error_message: null,
    failure_message: null,
    parser_version: 2,
  }));
  const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
  await page.addInitScript(
    ({ user, token }) =>
      localStorage.setItem(
        "sb-127-auth-token",
        JSON.stringify({
          access_token: token,
          refresh_token: "fixture",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      ),
    { user, token },
  );
  const requests: Array<{ documentIds: string[] | null }> = [];
  let mode: "answer" | "refusal" | "error" = "answer";
  let release!: () => void;
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sources = docs.slice(0, 2).map((doc, i) => ({
    id: `chunk-${i}`,
    chunkId: `chunk-${i}`,
    sourceId: `source_0${i + 1}`,
    documentId: doc.id,
    filename: doc.filename,
    page: 1,
    score: 0.9,
    rerankScore: 0.9,
    snippet: i === 0 ? "Doors open at 09:30." : "Use the east entrance for step-free access.",
  }));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/auth/v1/")) return json({ user });
    if (url.pathname.includes("/rest/v1/documents")) return json(docs);
    if (url.pathname.includes("/rest/v1/threads"))
      return json([
        { id: threadId, title: "Demo rehearsal", updated_at: new Date().toISOString() },
      ]);
    if (url.pathname.includes("/rest/v1/")) return json([]);
    if (url.pathname === "/api/chat") {
      requests.push(req.postDataJSON());
      await waiting;
      if (mode === "error")
        return json(
          { error: { code: "AI_UNAVAILABLE", message: "Demo request failed. Try again." } },
          503,
        );
      const answer =
        mode === "refusal"
          ? GROUNDED_REFUSAL
          : "Doors open at 09:30 [source_01]. Use the east entrance for step-free access [source_02].";
      const chunks = [
        { type: "start", messageId: `demo-${requests.length}` },
        { type: "data-sources", id: "sources", data: mode === "refusal" ? [] : sources },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: answer },
        { type: "text-end", id: "answer" },
        { type: "finish" },
      ];
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
        body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
      });
    }
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.goto(`/chat/${threadId}`);
  const first = page.getByRole("button", { name: /^harbor-guide\.txt/ });
  await expect(first).toBeVisible();
  await first.click();
  await page.getByRole("button", { name: /^harbor-travel\.txt/ }).click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^meadow-guide\.txt/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const input = page.getByPlaceholder("Ask anything about your documents…");
  await input.fill("When do Harbor doors open and which entrance is step-free?");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText("Searching your documents…", { exact: true })).toBeVisible();
  expect(requests[0]!.documentIds).toEqual(docs.slice(0, 2).map((d) => d.id));
  expect(requests[0]!.documentIds).not.toContain(docs[2]!.id);
  release();
  await expect(page.getByRole("link", { name: "source_02", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "source_02", exact: true }).click();
  await expect(page.getByText(sources[1]!.snippet, { exact: true }).last()).toBeVisible();
  await page.keyboard.press("Escape");
  mode = "refusal";
  waiting = Promise.resolve();
  await input.fill("What is the ticket price?");
  await input.press("Enter");
  await expect(page.getByText(GROUNDED_REFUSAL, { exact: true })).toBeVisible();
  mode = "error";
  await input.fill("Simulate an unavailable request");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(3);
  await expect(
    page.getByText(/Demo request failed|Something went wrong|unavailable/i).first(),
  ).toBeVisible();
  await page.screenshot({ path: ".verification/demo-chat.png", fullPage: true });
});
