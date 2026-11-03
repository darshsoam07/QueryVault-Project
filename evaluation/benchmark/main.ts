// Remove inherited configuration before modules evaluate their settings.
// The package script also uses Bun --no-env-file to prevent .env loading.
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|VITE_|AI_|GEMINI_|OPENAI_|LOVABLE_|QV_|INGESTION_)/.test(key))
    delete process.env[key];
}
await import("./cli");
export {};
