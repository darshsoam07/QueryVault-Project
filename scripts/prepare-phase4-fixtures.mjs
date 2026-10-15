import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Synthetic fixture preparation only. No network, credentials or DB writes.
const root = resolve(".verification/phase4-corpus");
mkdirSync(root, { recursive: true });
const facts = [
  "Aster policy A: The notice period is thirty days. Exact policy wording: Notice must be delivered in writing.",
  "Aster policy B: The notice period is sixty days. Policy B conflicts with policy A; neither is declared authoritative.",
  "Aster budget: The approved budget is 12000 credits. The budget owner is Mira Vale.",
  "Aster launch: The launch date is 2027-02-18. The launch coordinator is Leon Hart.",
  "Aster support: Support operates Monday through Friday. The response target is four hours.",
  ...Array.from(
    { length: 15 },
    (_, i) =>
      `Archive ${i + 6}: The synthetic archive code is ASTER-${String(i + 6).padStart(2, "0")}. This archive makes no statement about Aster notice periods, budgets, launch or support.`,
  ),
];
const documents = facts.map((fact, i) => {
  const filename = `aster-${String(i + 1).padStart(2, "0")}.txt`;
  const text = `SYNTHETIC ACCEPTANCE DOCUMENT ${i + 1}\n${fact}\n`;
  writeFileSync(resolve(root, filename), text);
  return {
    filename,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    facts: fact,
  };
});
const questions = [
  {
    id: "single",
    question: "What is the notice period in policy A?",
    selected: ["aster-01.txt"],
    expected: "thirty days",
    sources: ["aster-01.txt"],
  },
  {
    id: "multi",
    minimumBatch: 5,
    question: "Who owns the budget and who coordinates launch?",
    expected: ["Mira Vale", "Leon Hart"],
    sources: ["aster-03.txt", "aster-04.txt"],
  },
  {
    id: "conflict",
    minimumBatch: 5,
    question: "Compare the notice periods in policies A and B.",
    expected: ["thirty days", "sixty days", "disagreement; do not choose authority"],
    sources: ["aster-01.txt", "aster-02.txt"],
  },
  {
    id: "absent",
    question: "What is the Aster insurance provider?",
    expected: "grounded refusal",
    sources: [],
  },
  {
    id: "selected",
    minimumBatch: 5,
    question: "What is the launch date?",
    selected: ["aster-03.txt"],
    expected: "grounded refusal; launch document outside selection",
    sources: [],
  },
  {
    id: "quote",
    question: "Quote the exact written-notice requirement in policy A.",
    expected: "Notice must be delivered in writing.",
    sources: ["aster-01.txt"],
  },
];
writeFileSync(
  resolve(root, "manifest.json"),
  JSON.stringify(
    {
      synthetic: true,
      uploaded: false,
      batches: [1, 5, 10, 20].map((count) => ({
        count,
        filenames: documents.slice(0, count).map((d) => d.filename),
      })),
      documents,
      questions,
      measurements: null,
    },
    null,
    2,
  ),
);
console.log(
  `Prepared ${documents.length} synthetic UTF-8 documents and ground truth at ${root}. No uploads performed.`,
);
