import { describe, expect, it } from "vitest";
import { validateSupabaseConfig } from "../config/validate";
import { collectBootFindings } from "../config/boot.server";
const local = {
  QV_LOCAL_ONLY: "1",
  VITE_QV_LOCAL_ONLY: "1",
  SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PROJECT_ID: "queryvault-zero-cost",
  VITE_SUPABASE_PROJECT_ID: "queryvault-zero-cost",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_fixture",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline_fixture",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_offline_fixture",
};
const errors = (value: typeof local) =>
  validateSupabaseConfig(value).filter((f) => f.severity === "error");
describe("explicit local-only boot configuration", () => {
  it("accepts loopback without weakening required credentials", () => {
    expect(errors(local)).toEqual([]);
    expect(collectBootFindings(local).filter((f) => f.severity === "error")).toEqual([]);
    expect(errors({ ...local, SUPABASE_SERVICE_ROLE_KEY: "" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_MISSING" })]),
    );
  });
  it("rejects loopback when local mode is absent", () => {
    expect(errors({ ...local, QV_LOCAL_ONLY: "0", VITE_QV_LOCAL_ONLY: "0" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_URL_INVALID" })]),
    );
  });
  it.each([
    "https://fultpxfredyqvcrwmcyx.supabase.co",
    "http://127.0.0.1.evil.test",
    "http://user:pass@localhost:54321",
    "http://192.168.1.2:54321",
  ])("rejects non-local or credential-bearing URL %s", (url) => {
    expect(errors({ ...local, SUPABASE_URL: url, VITE_SUPABASE_URL: url })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_URL_INVALID" })]),
    );
  });
  it("still rejects a service-role secret in browser config", () => {
    expect(
      errors({ ...local, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_offline_fixture" }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_SECRET_IN_PUBLIC" })]),
    );
  });
  it("still rejects an anon key as the service role", () => {
    expect(
      errors({ ...local, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_offline_fixture" }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_KEY_ROLE_INVALID" })]),
    );
  });
  it("still rejects differing server/browser project IDs", () => {
    expect(errors({ ...local, VITE_SUPABASE_PROJECT_ID: "another-local-project" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CONFIG_MIRROR_MISMATCH" })]),
    );
  });
});
