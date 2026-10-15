/** Report filenames/rule names only, never secret values. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const secrets = [];
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && /(?:SECRET(?:_KEY)?|SERVICE_ROLE(?:_KEY)?|API_KEY)$/.test(match[1])) {
      const value = match[2].trim().replace(/^['"]|['"]$/g, "");
      if (value.length >= 24) secrets.push({ name: match[1], value });
    }
  }
} catch {
  /* environment may be injected instead */
}
for (const [name, value] of Object.entries(process.env))
  if (
    value &&
    value.length >= 24 &&
    /(?:SECRET(?:_KEY)?|SERVICE_ROLE(?:_KEY)?|API_KEY)$/.test(name)
  )
    secrets.push({ name, value });
const violations = [];
function walk(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|mjs|map|html|json)$/.test(path)) {
      const content = readFileSync(path, "utf8");
      for (const secret of secrets)
        if (content.includes(secret.value)) violations.push({ file: path, rule: secret.name });
    }
  }
}
walk(".output/public");
console.log(
  JSON.stringify({ checkedSecretNames: [...new Set(secrets.map((s) => s.name))], violations }),
);
if (violations.length) process.exit(1);
