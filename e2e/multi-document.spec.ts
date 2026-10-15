import { test, expect } from "@playwright/test";
import { fromJSON } from "seroval";
import { randomUUID } from "node:crypto";
/** Entire HTTP boundary is mocked. No hosted Auth/Storage/Postgres/provider writes. */
test("20 document batch overlaps within three slots and survives refresh", async ({ page }) => {
  page.on("pageerror", (error) => console.log("Fixture page error:", error.message));
  page.on("requestfailed", (request) =>
    console.log(
      "Fixture request failed:",
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  );
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
          refresh_token: "fixture-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
    },
    { ref, user, token },
  );
  const documents = new Map<string, Record<string, unknown>>();
  let active = 0,
    peak = 0;
  let releaseUploads!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (result: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
    if (url.pathname.includes("/auth/v1/"))
      return json({
        user,
        access_token: token,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    if (url.pathname.includes("/rest/v1/documents")) return json([...documents.values()]);
    if (url.pathname.includes("/rest/v1/")) return json([]);
    if (url.pathname.startsWith("/__fixture-storage/")) {
      active++;
      peak = Math.max(peak, active);
      await uploadGate;
      active--;
      return json({ Key: url.pathname });
    }
    if (request.headers()["x-tsr-serverfn"]) {
      const payload = fromJSON(JSON.parse(request.postData() || "{}"), { plugins: [] }) as {
        data: Record<string, unknown>;
      };
      const data = payload.data;
      if (data["filename"]) {
        const id = randomUUID();
        documents.set(id, {
          id,
          filename: data["filename"],
          status: "uploaded",
          phase: "uploading",
          progress: 0,
          chunk_count: 0,
          page_count: 0,
          byte_size: data["byteSize"],
          error_message: null,
          failure_message: null,
        });
        return json({
          result: {
            documentId: id,
            filename: data["filename"],
            storagePath: `${user.id}/${id}.txt`,
            signedToken: "fixture-token",
            signedUrl: `http://localhost:5173/__fixture-storage/${id}`,
          },
          context: {},
        });
      }
      const id = String(data["documentId"]),
        doc = documents.get(id)!;
      if (doc["phase"] === "uploading") {
        Object.assign(doc, { status: "processing", phase: "queued", progress: 5 });
        return json({ result: { documentId: id, jobId: id, status: "queued" }, context: {} });
      }
      Object.assign(doc, {
        status: "ready",
        phase: "ready",
        progress: 100,
        chunk_count: 1,
        page_count: 1,
      });
      return json({
        result: {
          document: doc,
          job: { id, status: "succeeded", attempt_count: 1, error_message: null },
        },
        context: {},
      });
    }
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      return route.fulfill({ status: 204, body: "" });
    return route.continue();
  });
  await page.goto("/chat");
  await page.waitForFunction(
    () =>
      (window as unknown as { __QV_PERF_HYDRATION_MS?: number }).__QV_PERF_HYDRATION_MS !==
      undefined,
  );
  const picker = page.getByLabel("Choose documents to upload", { exact: true });
  await expect(picker).toBeAttached();
  const files = Array.from({ length: 20 }, (_, i) => ({
    name: i < 2 ? "same-name.txt" : `document-${i}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(
      `Document ${i}. ` + "Readable fixture text for the authorized corpus. ".repeat(8),
    ),
  }));
  await picker.setInputFiles(files.slice(0, 10));
  await expect.poll(() => active).toBeGreaterThan(0);
  await picker.setInputFiles([
    ...files.slice(10),
    {
      name: "unsupported.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("Unsupported binary fixture"),
    },
  ]);
  releaseUploads();
  await expect(page.getByText(/21 files.*20 ready.*1 failed/)).toBeVisible({ timeout: 20000 });
  expect(peak).toBe(3);
  expect(documents.size).toBe(20);
  await page.reload();
  await expect(page.getByText("same-name.txt", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(20);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Upload documents", exact: true }).focus();
  await expect(page.getByRole("button", { name: "Upload documents", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
