import {
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";

// Prepare only: no CLI install, image downloads, start, reset, link or push.
const root = resolve(".verification/supabase-zero-cost");
if (existsSync(root))
  throw new Error("Prepared local workspace already exists; inspect it rather than overwriting.");
mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
mkdirSync(join(root, "supabase", "templates"), { recursive: true });
let config = readFileSync("supabase/config.toml", "utf8");
config = config.replace(/^project_id\s*=.*$/m, 'project_id = "queryvault-zero-cost"');
config = config.replaceAll("http://localhost:3000", "http://127.0.0.1:5173");
config += "\n# Local-only profile: external analytics disabled.\n[analytics]\nenabled = false\n";
writeFileSync(join(root, "supabase", "config.toml"), config);
for (const name of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")))
  copyFileSync(join("supabase/migrations", name), join(root, "supabase", "migrations", name));
copyFileSync(
  "supabase/templates/confirmation.html",
  join(root, "supabase", "templates", "confirmation.html"),
);
writeFileSync(
  join(root, "README.txt"),
  "Prepared only. CLI and images absent; owner has not approved downloads. Do not link a hosted project. Leave Vault worker URLs unset. After explicit download approval and CLI installation, run supabase start --workdir <this directory>, verify loopback bindings, and use ONLY local credentials. No hosted db push/reset.\n",
);
console.log(
  `Prepared separate local Supabase workspace at ${root}. Repository settings unchanged; no resources started.`,
);
