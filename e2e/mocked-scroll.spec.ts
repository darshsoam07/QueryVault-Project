import { test, expect } from "@playwright/test";
/** Real app rendering/scrolling with synthetic HTTP fixtures; no hosted writes. */
test("saved citation mapping and older-message anchoring remain correct", async ({ page }) => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "fixture@example.test",
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  const ref = new URL(
    process.env.VITE_SUPABASE_URL || "https://fixture.supabase.co",
  ).hostname.split(".")[0]!;
  const token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        sub: user.id,
        exp: Math.floor(Date.now() / 1000) + 3600,
        role: "authenticated",
      }),
    ).toString("base64url"),
    "fixture-signature",
  ].join(".");
  await page.addInitScript(
    ({ ref, user, token }) => {
      localStorage.setItem(
        `sb-${ref}-auth-token`,
        JSON.stringify({
          access_token: token,
          refresh_token: "fixture",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
    },
    { ref, user, token },
  );
  const threadId = "33333333-3333-4333-8333-333333333333";
  const source = {
    id: "chunk",
    chunkId: "chunk",
    sourceId: "source_01",
    documentId: "document",
    filename: "evidence.pdf",
    page: 3,
    score: 0.9,
    rerankScore: 0.9,
    snippet: "The notice period is thirty days.",
  };
  const messages = Array.from({ length: 60 }, (_, i) => ({
    id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
    thread_id: threadId,
    user_id: user.id,
    role: i % 2 === 0 ? "user" : "assistant",
    content:
      `Message #${i}: Distinct fixture content with enough words to measure scroll position and preserve paragraph height.` +
      (i === 59 ? " [source_01]." : ""),
    sources: i === 59 ? [source] : [],
    latency_ms: 1,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/auth/v1/")) return json({ user });
    if (url.pathname.includes("/rest/v1/messages")) {
      const cutoff = url.searchParams.get("or")?.match(/created_at\.lt\.([^,]+)/)?.[1];
      return json(
        messages
          .filter((row) => !cutoff || row.created_at < cutoff)
          .slice()
          .reverse()
          .slice(0, 50),
      );
    }
    if (url.pathname.includes("/rest/v1/threads"))
      return json([
        { id: threadId, title: "Fixture history", updated_at: new Date().toISOString() },
      ]);
    if (url.pathname.includes("/rest/v1/")) return json([]);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      return route.fulfill({ status: 204, body: "" });
    return route.continue();
  });
  await page.goto(`/chat/${threadId}`);
  await page.waitForFunction(
    () =>
      (window as unknown as { __QV_PERF_HYDRATION_MS?: number }).__QV_PERF_HYDRATION_MS !==
      undefined,
  );
  await expect(page.locator('[data-testid="chat-message"]')).toHaveCount(50);
  const citation = page.getByRole("link", { name: "source_01", exact: true });
  await citation.click();
  await expect(page.getByText(source.snippet, { exact: true })).toBeVisible();
  await expect(page.getByText("Page 3", { exact: true }).last()).toBeVisible();
  await page.keyboard.press("Escape");
  const button = page.getByTestId("load-older-messages-button");
  await button.scrollIntoViewIfNeeded();
  const anchor = page.getByText("Message #15:", { exact: false }).first();
  const before = await anchor.boundingBox();
  expect(before).not.toBeNull();
  await button.click();
  await expect(page.locator('[data-testid="chat-message"]')).toHaveCount(60);
  const after = await anchor.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
});
