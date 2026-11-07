import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractDocumentPages } from "../ingestion/document-parser.server";
import { preparePageChunks } from "../chunking";

describe("self-authored demo files through production extraction and chunking", () => {
  it.each([
    ["harbor-guide.txt", "09:30", "HBR-204"],
    ["harbor-travel.txt", "east entrance", "09:15"],
    ["meadow-guide.txt", "13:00", "MDW-909"],
  ])("preserves facts and page provenance in %s", async (file, fact, code) => {
    const pages = await extractDocumentPages(
      new Uint8Array(await readFile(`demo/documents/${file}`)),
      file!,
    );
    const chunks = preparePageChunks(pages);
    expect(pages).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.content).join("\n")).toContain(fact);
    expect(chunks.map((c) => c.content).join("\n")).toContain(code);
    expect(chunks.every((c) => c.page === 1)).toBe(true);
  });
});

it("excludes root dotenv values from the isolated browser build", async () => {
  const root = await mkdtemp(join(tmpdir(), "qv-demo-config-"));
  const dotenv = join(root, ".env");
  await writeFile(dotenv, "VITE_DEMO_SENTINEL=must-never-enter-the-browser\n");
  try {
    // Resolve the real config from a temporary working directory with its own
    // sentinel. Both Vite and the Lovable wrapper have dotenv loading paths.
    const config = new URL("../../../vite.config.ts", import.meta.url).href;
    await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const { default: buildConfig } = await import(process.argv[1]);
      const config = await buildConfig({ command: 'build', mode: 'production' });
      assert.equal(config.envDir, false);
      assert.equal(config.define?.['import.meta.env.VITE_DEMO_SENTINEL'], undefined);
    `,
        config,
      ],
      {
        cwd: root,
        env: { ...process.env, QV_LOCAL_ONLY: "1", QV_VERIFY_WITHOUT_DOTENV: "0" },
        timeout: 25000,
      },
    );
  } finally {
    await unlink(dotenv);
    await rmdir(root);
  }
}, 30000);
