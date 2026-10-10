import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

test.describe("Chat cursor pagination and scroll anchoring", () => {
  let supabaseAdmin: ReturnType<typeof createClient>;
  let testUserId: string;
  let testThreadId: string;
  let testEmail = "";
  let testPassword = "";
  let createdUser = false;

  test.beforeAll(async () => {
    if (!supabaseUrl || !serviceRoleKey) {
      test.skip(true, "Supabase service role credentials not configured in environment.");
      return;
    }

    supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Prepare user session
    if (process.env.E2E_EMAIL && process.env.E2E_PASSWORD) {
      testEmail = process.env.E2E_EMAIL;
      testPassword = process.env.E2E_PASSWORD;
      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email: testEmail,
        password: testPassword,
      });
      if (error || !data.user) {
        throw new Error(`Failed to sign in test user: ${error?.message}`);
      }
      testUserId = data.user.id;
    } else {
      // Create temporary test user with unique email
      testEmail = `test-e2e-${randomUUID()}@queryvault.test`;
      testPassword = `P@ssword_${randomUUID().slice(0, 8)}!`;
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email: testEmail,
        password: testPassword,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`Failed to create temp user: ${error?.message}`);
      }
      testUserId = data.user.id;
      createdUser = true;
    }

    // 2. Create isolated test thread
    testThreadId = randomUUID();
    const { error: threadError } = await supabaseAdmin.from("threads").insert({
      id: testThreadId,
      user_id: testUserId,
      title: "E2E Pagination Scroll Anchoring Test",
    });
    if (threadError) {
      throw new Error(`Failed to create test thread: ${threadError.message}`);
    }

    // 3. Seed exactly 60 messages with distinct, sequential timestamps
    const now = Date.now();
    const messagesToInsert = Array.from({ length: 60 }).map((_, i) => ({
      id: randomUUID(),
      thread_id: testThreadId,
      user_id: testUserId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message #${i}: Distinct content body for scroll measurement index ${i} with additional padding text to give the message adequate height in DOM.`,
      sources: [],
      created_at: new Date(now - (60 - i) * 1000).toISOString(),
    }));

    const { error: messagesError } = await supabaseAdmin.from("messages").insert(messagesToInsert);
    if (messagesError) {
      throw new Error(`Failed to seed 60 test messages: ${messagesError.message}`);
    }
  });

  test.afterAll(async () => {
    if (!supabaseAdmin) return;
    try {
      if (testThreadId) {
        await supabaseAdmin.from("messages").delete().eq("thread_id", testThreadId);
        await supabaseAdmin.from("threads").delete().eq("id", testThreadId);
      }
      if (createdUser && testUserId) {
        await supabaseAdmin.auth.admin.deleteUser(testUserId);
      }
    } catch (err) {
      console.warn("Cleanup warning:", err);
    }
  });

  test("initial load fetches 50 messages, older messages prepend without viewport jump", async ({
    page,
  }) => {
    // 1. Sign in through the real application authentication interface
    await page.goto("/auth");
    await page.waitForFunction(
      () =>
        (window as unknown as { __QV_PERF_HYDRATION_MS?: number }).__QV_PERF_HYDRATION_MS !==
        undefined,
    );

    await page.locator("#email").fill(testEmail);
    await page.locator("#password").fill(testPassword);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/chat/, { timeout: 15_000 });

    // 2. Navigate directly to the seeded thread
    await page.goto(`/chat/${testThreadId}`);

    // 3. Wait for the conversation container to load initial messages (50 messages)
    const messageLocator = page.locator('[data-testid="chat-message"]');
    await expect(messageLocator).toHaveCount(50, { timeout: 15_000 });

    // 4. Initial 50 loaded are the newest: messages #10 through #59
    // Confirm the newest message (#59) is present
    await expect(page.getByText("Message #59:")).toBeVisible();

    // Confirm the oldest message (#0) is initially ABSENT
    await expect(page.getByText("Message #0:")).not.toBeAttached();

    // 5. Locate "Load older messages" button and scroll it into view
    const loadOlderBtn = page.locator('[data-testid="load-older-messages-button"]');
    await expect(loadOlderBtn).toBeVisible();
    await loadOlderBtn.scrollIntoViewIfNeeded();

    // 6. Pick an anchor message visible in the loaded history near the top (Message #15)
    const anchorMessage = page.getByText("Message #15:").first();
    await expect(anchorMessage).toBeVisible();

    // 7. Measure initial viewport Y position of the anchor message
    const initialBox = await anchorMessage.boundingBox();
    expect(initialBox).not.toBeNull();
    const initialY = initialBox!.y;

    // 8. Trigger loading older messages via cursor pagination
    await loadOlderBtn.click();

    // 9. Wait for older messages to appear (now total 60 messages in DOM)
    await expect(messageLocator).toHaveCount(60, { timeout: 15_000 });

    // Verify Message #0 is now in the DOM
    await expect(page.getByText("Message #0:")).toBeAttached();

    // 10. Measure anchor message viewport Y position again after DOM prepend
    const updatedBox = await anchorMessage.boundingBox();
    expect(updatedBox).not.toBeNull();
    const updatedY = updatedBox!.y;

    // 11. Assert viewport Y coordinate remains effectively unchanged (<= 1-2px tolerance)
    const deltaY = Math.abs(updatedY - initialY);
    expect(deltaY).toBeLessThanOrEqual(2);
  });
});
