import { GROUNDED_REFUSAL } from "@/lib/chat.schema";
import type { EvidenceSource } from "./types";

/**
 * AUTHORITATIVE citation contract for QueryVault answers.
 *
 * Trust/correctness workstream A — this is the single validator every
 * generated answer must pass before it is rendered or stored. It is
 * fail-closed: any substantive block without a valid citation, any unknown
 * citation, any citation outside the request's evidence set, or any malformed
 * citation marker REJECTS the entire answer. Callers must discard the
 * candidate and deliver the controlled grounded refusal instead.
 *
 * This supersedes the old strip-only approach (see citations.ts, kept for
 * backwards-compatible helpers). Unknown ids are never silently removed;
 * the answer is rejected wholesale.
 *
 * Failure-reason taxonomy:
 * - `no_citations` — answer with substantive content but zero citation
 *   markers, or empty/whitespace-only output (nothing to cite).
 *   NOTE: there is no refusal exemption — model-generated text that is
 *   byte-identical to the fixed grounded refusal is validated here like any
 *   other candidate and rejected (see validateCitedAnswer's trust-boundary
 *   note). The fixed refusal is emitted only by trusted server code paths.
 * - `uncited_substantive_block` — a paragraph, bullet/numbered item,
 *   blockquote, or substantive table row with no valid citation.
 * - `unknown_citation` — a citation-shaped marker whose id cannot exist in
 *   this request (e.g. `[source_999]`, or a well-formed id that appears
 *   nowhere the request could know about).
 * - `malformed_citation` — citation-intent marker with non-canonical syntax
 *   (`[SOURCE_01]`, `[ source_01 ]`, `[source_abc]`, `[source_01, source_02]`).
 *   Only `[source_NN]` (canonical) and `[source_N]` (normalizable to
 *   canonical) are accepted — no arbitrary syntax. Any other bracketed run
 *   carrying the `source_` id prefix is treated as a broken citation
 *   attempt, because rendering it would show the user a citation-looking
 *   marker that references nothing.
 * - `citation_outside_evidence_set` — well-formed id that exists in the
 *   caller-supplied `knownSourceIds` superset but was NOT in this request's
 *   allowed evidence set. Callers that have no genuine superset omit it, and
 *   such ids are reported as `unknown_citation` instead.
 */

/**
 * Citation-contract version stamped on validation telemetry. This identifies
 * the VALIDATOR LOGIC that ran — it is not the deployment release. The
 * deployment release is carried separately as `release` on the telemetry
 * payload (see buildValidationTelemetry).
 */
export const CITATION_CONTRACT_VERSION = "citation-contract/v1";

/**
 * @deprecated Use CITATION_CONTRACT_VERSION. The old name conflated the
 * validator contract version with the deployment release; telemetry now
 * carries them as separate `contractVersion` / `release` fields.
 */
export const CITATION_CONTRACT_RELEASE = CITATION_CONTRACT_VERSION;

/** Size of the post-validation emission chunks (characters, word-boundary). */
export const EMISSION_CHUNK_SIZE = 240;

export type CitationFailureReason =
  | "no_citations"
  | "uncited_substantive_block"
  | "unknown_citation"
  | "malformed_citation"
  | "citation_outside_evidence_set";

export type CitationValidationResult = {
  /** True only when every substantive block cites a valid evidence source. */
  valid: boolean;
  /**
   * The answer with citation markers normalized to canonical ids
   * (`[source_1]` -> `[source_01]`). Empty string when invalid — the
   * candidate must never be delivered or stored.
   */
  normalizedAnswer: string;
  /** Cited source ids in order of first appearance. Empty when invalid. */
  citedSourceIds: string[];
  /** Unique cited source ids, sorted. Empty when invalid. */
  deduplicatedSourceIds: string[];
  failureReason: CitationFailureReason | null;
  /** 0-based index into the substantive-block sequence, when applicable. */
  offendingBlockIndex: number | null;
  /** Offending canonical id (or raw marker for malformed), when applicable. */
  offendingCitationId: string | null;
};

export type ValidateCitedAnswerOptions = {
  /**
   * Ids known to exist for this request but NOT admitted to the validated
   * evidence set (a strict superset of the evidence ids). Citing one is
   * `citation_outside_evidence_set`. Omit when the pipeline has no genuine
   * superset — then any non-allowed id is `unknown_citation`.
   */
  knownSourceIds?: string[];
};

// ---------------------------------------------------------------------------
// Citation marker shapes
// ---------------------------------------------------------------------------

/**
 * The only accepted marker syntax: `[source_01]` (canonical) or
 * `[source_1]` (normalizable). Lowercase, no interior whitespace, 1-2 digits.
 * This request's evidence ids are always `source_01` … `source_NN`
 * (see formatSourceId), so 1-2 digits is the complete id space.
 */
const STRICT_MARKER_SOURCE = String.raw`\[source_(\d{1,2})\]`;

/** Three-or-more-digit id: can never be a real evidence id. */
const LONG_DIGIT_MARKER_SOURCE = String.raw`\[\s*source_\s*(\d{3,})\s*\]`;

/**
 * Any other bracketed run carrying the `source_` id prefix: a broken
 * citation attempt (wrong case, stray spaces, non-numeric id, extra
 * content). Bounded so long prose brackets stay untouched.
 */
const SOURCE_PREFIXED_BRACKET_SOURCE = String.raw`\[\s*source_[^\][\n]{0,40}\]`;

/** Any bracketed run we bother to classify (bounded, no nesting). */
const ANY_BRACKET_RUN_SOURCE = String.raw`\[[^\][\n]{1,48}\]`;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A source id is canonical when it matches the evidence id space. */
export function isCanonicalSourceId(id: string): boolean {
  return /^source_\d{2}$/.test(id);
}

/**
 * Normalize every accepted citation marker to its canonical form:
 * `[source_1]` -> `[source_01]`, `[source_01]` unchanged. Markers with
 * non-accepted syntax are left alone (the validator rejects them instead).
 * Unrelated bracketed content (`[1]`, `[link]`, `[foo]`) is never touched.
 */
export function normalizeCitationMarkers(text: string): string {
  return text.replace(new RegExp(STRICT_MARKER_SOURCE, "g"), (_match, digits: string) => {
    return `[source_${digits.padStart(2, "0")}]`;
  });
}

/** All canonical citation ids present in the text, in order of appearance. */
export function extractCanonicalCitations(text: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(STRICT_MARKER_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found.push(`source_${match[1]!.padStart(2, "0")}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Fenced-code segmentation — markers inside code fences are unrelated
// content: never normalized, never validated, never required.
// ---------------------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

type Segment = { code: boolean; text: string };

function splitFencedSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let current: string[] = [];
  let inCode = false;
  const flush = (code: boolean) => {
    if (current.length > 0) {
      segments.push({ code, text: current.join("\n") });
      current = [];
    }
  };
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (inCode) {
        current.push(line);
        flush(true);
        inCode = false;
      } else {
        flush(false);
        current = [line];
        inCode = true;
      }
      continue;
    }
    current.push(line);
  }
  flush(inCode);
  return segments;
}

// ---------------------------------------------------------------------------
// Markdown-aware block parsing (deterministic, no model judgment)
// ---------------------------------------------------------------------------

export type BlockKind =
  | "code" // pure fenced code — exempt
  | "heading" // markdown heading — exempt
  | "rule" // horizontal rule — exempt
  | "citation-only" // line(s) of only citation markers — exempt
  | "table-header" // table header / separator row — exempt
  | "list-item" // bullet / numbered item — substantive
  | "blockquote" // blockquote run — substantive
  | "table-row" // substantive table data row — substantive
  | "paragraph"; // prose paragraph — substantive

export type Block = { kind: BlockKind; text: string };

const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const HR = /^\s{0,3}(?:\*(\s*\*){2,}|-(\s*-){2,}|_(\s*_){2,})\s*$/;
const LIST_START = /^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+\S/;
const BLOCKQUOTE = /^\s{0,3}>/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?[\s|:-]*\|[\s|:-]*$/;
const BLANK = /^\s*$/;
const INDENTED = /^\s+\S/;

function isCitationOnlyLine(line: string): boolean {
  const withoutMarkers = line.replace(new RegExp(STRICT_MARKER_SOURCE, "g"), "").trim();
  return withoutMarkers === "" && new RegExp(STRICT_MARKER_SOURCE).test(line);
}

/**
 * Split an answer into blocks. Substantive blocks (paragraph, list-item,
 * blockquote, table-row) require at least one valid citation each. Exempt:
 * headings, horizontal rules, citation-only lines, pure fenced code blocks,
 * and table header/separator rows. Prose explaining a code block is NOT
 * exempt — it is parsed as an ordinary paragraph and must be cited.
 */
export function splitAnswerBlocks(answer: string): Block[] {
  const lines = answer.split("\n");
  const blocks: Block[] = [];
  let inFence = false;

  // Pre-scan: table separator rows, and the header row immediately above a
  // separator (structural, exempt).
  const separatorLines = new Set<number>();
  lines.forEach((line, i) => {
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(line)) separatorLines.add(i);
  });
  const headerLines = new Set<number>();
  for (const sep of separatorLines) {
    const above = sep - 1;
    if (above >= 0 && TABLE_ROW.test(lines[above]!) && !separatorLines.has(above)) {
      headerLines.add(above);
    }
  }

  let current: { kind: BlockKind; lines: string[] } | null = null;
  const flush = () => {
    if (current && current.lines.length > 0) {
      blocks.push({ kind: current.kind, text: current.lines.join("\n") });
    }
    current = null;
  };
  const push = (kind: BlockKind, line: string) => {
    if (current?.kind === kind) current.lines.push(line);
    else {
      flush();
      current = { kind, lines: [line] };
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      blocks.push({ kind: "code", text: line });
      continue;
    }
    if (inFence) {
      blocks.push({ kind: "code", text: line });
      continue;
    }
    if (BLANK.test(line)) {
      flush();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      blocks.push({ kind: "heading", text: line });
      continue;
    }
    if (HR.test(line)) {
      flush();
      blocks.push({ kind: "rule", text: line });
      continue;
    }
    if (isCitationOnlyLine(line)) {
      flush();
      blocks.push({ kind: "citation-only", text: line });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flush();
      if (separatorLines.has(i) || headerLines.has(i)) {
        blocks.push({ kind: "table-header", text: line });
      } else {
        blocks.push({ kind: "table-row", text: line });
      }
      continue;
    }
    if (BLOCKQUOTE.test(line)) {
      push("blockquote", line);
      continue;
    }
    if (LIST_START.test(line)) {
      // Each bullet/numbered item is its own block: every item must carry
      // its own citation. Only indented continuation lines join the item.
      flush();
      current = { kind: "list-item", lines: [line] };
      continue;
    }
    // Indented continuation line belongs to the preceding list item or
    // blockquote; otherwise it starts/joins a paragraph.
    if (
      INDENTED.test(line) &&
      current &&
      (current.kind === "list-item" || current.kind === "blockquote")
    ) {
      current.lines.push(line);
      continue;
    }
    push("paragraph", line);
  }
  flush();
  return blocks;
}

const SUBSTANTIVE_KINDS: ReadonlySet<BlockKind> = new Set([
  "paragraph",
  "list-item",
  "blockquote",
  "table-row",
]);

/**
 * A block is substantive when it carries real content. There is deliberately
 * no length threshold — short factual claims must not escape the citation
 * requirement. Formatting-only residue (bare markers, pipes, emphasis) with
 * no word characters is not substantive.
 */
function isSubstantive(block: Block): boolean {
  if (!SUBSTANTIVE_KINDS.has(block.kind)) return false;
  const residue = block.text
    .replace(new RegExp(STRICT_MARKER_SOURCE, "g"), "")
    .replace(/[*_`~#>|\-+:]/g, "");
  return WORD_CHAR.test(residue);
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

function invalid(
  reason: CitationFailureReason,
  blockIndex: number | null = null,
  citationId: string | null = null,
): CitationValidationResult {
  return {
    valid: false,
    normalizedAnswer: "",
    citedSourceIds: [],
    deduplicatedSourceIds: [],
    failureReason: reason,
    offendingBlockIndex: blockIndex,
    offendingCitationId: citationId,
  };
}

type MarkerScan = { ok: true } | { ok: false; reason: CitationFailureReason; citationId: string };

/**
 * Classify every bracketed run in a prose (non-code) segment. Fails fast on
 * the first malformed, unknown, or out-of-set marker. Well-formed markers
 * that are not in the allowed set are `citation_outside_evidence_set` when
 * they appear in the caller-supplied known superset, otherwise
 * `unknown_citation`.
 */
function scanSegmentMarkers(
  segment: string,
  allowedIds: Set<string>,
  knownIds: Set<string>,
): MarkerScan {
  const bracketRuns = segment.match(new RegExp(ANY_BRACKET_RUN_SOURCE, "g")) ?? [];
  const strict = new RegExp(`^${STRICT_MARKER_SOURCE}$`);
  const longDigit = new RegExp(`^${LONG_DIGIT_MARKER_SOURCE}$`, "i");
  const sourcePrefixed = new RegExp(`^${SOURCE_PREFIXED_BRACKET_SOURCE}$`, "i");

  for (const run of bracketRuns) {
    const strictMatch = strict.exec(run);
    if (strictMatch) {
      const id = `source_${strictMatch[1]!.padStart(2, "0")}`;
      if (allowedIds.has(id)) continue;
      if (knownIds.has(id)) {
        return { ok: false, reason: "citation_outside_evidence_set", citationId: id };
      }
      return { ok: false, reason: "unknown_citation", citationId: id };
    }
    const longMatch = longDigit.exec(run);
    if (longMatch) {
      // Can never be a real evidence id (formatSourceId pads to 2 digits).
      return { ok: false, reason: "unknown_citation", citationId: `source_${longMatch[1]}` };
    }
    if (sourcePrefixed.test(run)) {
      // Citation-intent marker with non-canonical syntax: no arbitrary
      // syntax is accepted, so the answer is rejected rather than cleaned.
      return { ok: false, reason: "malformed_citation", citationId: run.trim() };
    }
    // Unrelated bracketed content — untouched, not a citation.
  }
  return { ok: true };
}

/**
 * Validate a complete generated answer against the request's evidence set.
 *
 * TRUST BOUNDARY: this function treats ALL of its input as UNTRUSTED
 * MODEL-GENERATED TEXT. Model output ALWAYS goes through strict
 * block-by-block validation here — there is no string-equality exemption,
 * even for text byte-identical to the fixed grounded refusal (a model could
 * use the refusal sentence to bypass the citation contract; such text fails
 * here as uncited prose, and the server-selected refusal is delivered
 * instead). The ONLY trusted refusals are produced by server code itself:
 *   (a) the evidence-gate refusal before generation (the route never calls
 *       this function on that path), and
 *   (b) planDelivery substituting the fixed refusal when validation fails.
 * Those server-selected refusal plans make no claims and carry no model
 * text, so they are citation-exempt BY CONSTRUCTION — they never enter
 * this function as candidates. The exemption therefore applies to
 * server-selected refusal plans, never to this function's input
 * classification.
 *
 * 1. Empty or whitespace-only output is rejected fail-closed.
 * 2. Every citation-shaped marker outside fenced code is classified:
 *    malformed, unknown, or outside the allowed evidence set -> reject.
 * 3. Markers are normalized (`[source_1]` -> `[source_01]`).
 * 4. Every substantive block (paragraph, list item, blockquote, substantive
 *    table row) must contain at least one valid citation -> else reject.
 *
 * On ANY failure the whole answer is rejected: `normalizedAnswer` is empty
 * and the caller must deliver the fixed grounded refusal instead. Unknown
 * ids are never stripped; the candidate is discarded wholesale.
 */
export function validateCitedAnswer(
  answer: string,
  evidence: EvidenceSource[],
  options: ValidateCitedAnswerOptions = {},
): CitationValidationResult {
  const allowedIds = new Set(evidence.map((source) => source.sourceId));
  const knownIds = new Set([...allowedIds, ...(options.knownSourceIds ?? [])]);
  const trimmed = answer.trim();

  // Fail closed on empty / whitespace-only model output: there is nothing
  // to cite, so it can never be a valid answer. (Previously such input
  // passed vacuously; it must not be deliverable or persistable.)
  if (trimmed === "") {
    return invalid("no_citations", 0, null);
  }

  // 1-3. Classify markers and normalize, skipping fenced code (unrelated
  //    content there is never normalized or validated).
  const normalizedSegments: string[] = [];
  const normalizedProseSegments: string[] = [];
  for (const segment of splitFencedSegments(answer)) {
    if (segment.code) {
      normalizedSegments.push(segment.text);
      continue;
    }
    const scan = scanSegmentMarkers(segment.text, allowedIds, knownIds);
    if (!scan.ok) {
      return invalid(scan.reason, null, scan.citationId);
    }
    const normalizedSegment = normalizeCitationMarkers(segment.text);
    normalizedSegments.push(normalizedSegment);
    normalizedProseSegments.push(normalizedSegment);
  }
  const normalized = normalizedSegments.join("\n").trim();
  // Citation presence is measured on prose only: a marker inside a fenced
  // code example is not a citation of anything.
  const normalizedProse = normalizedProseSegments.join("\n");

  // 4. Block-by-block citation presence, in document order.
  const blocks = splitAnswerBlocks(normalized);
  const substantive = blocks.filter(isSubstantive);

  const totalMarkers = extractCanonicalCitations(normalizedProse).length;
  if (totalMarkers === 0 && substantive.length > 0) {
    return invalid("no_citations", 0, null);
  }

  let substantiveIndex = 0;
  for (const block of blocks) {
    if (!isSubstantive(block)) continue;
    const blockIndex = substantiveIndex;
    substantiveIndex += 1;

    const cited = extractCanonicalCitations(block.text);
    // Belt-and-braces: the global scan above already rejected any marker
    // outside the allowed set.
    const validCited = cited.filter((id) => allowedIds.has(id));
    if (validCited.length === 0) {
      return invalid("uncited_substantive_block", blockIndex, null);
    }
  }

  // 5. Valid: collect cited ids in first-appearance order (prose only).
  const appearances = extractCanonicalCitations(normalizedProse).filter((id) => allowedIds.has(id));
  const firstAppearance: string[] = [];
  const seen = new Set<string>();
  for (const id of appearances) {
    if (!seen.has(id)) {
      seen.add(id);
      firstAppearance.push(id);
    }
  }

  return {
    valid: true,
    normalizedAnswer: normalized,
    citedSourceIds: firstAppearance,
    deduplicatedSourceIds: [...seen].sort(),
    failureReason: null,
    offendingBlockIndex: null,
    offendingCitationId: null,
  };
}

// ---------------------------------------------------------------------------
// Delivery decision (pure): what the route emits AND persists
// ---------------------------------------------------------------------------

export type DeliveryPlan = {
  /**
   * The single text that is delivered to the client and persisted to the
   * messages table. Delivered text and persisted text are IDENTICAL by
   * construction — the route uses this one value for both.
   */
  text: string;
  refused: boolean;
  /** Cited source ids in first-appearance order. Never a fallback list. */
  citedIds: string[];
  citationCount: number;
};

/**
 * Decide what leaves the server. A valid answer is released with its cited
 * sources only; an invalid candidate is discarded entirely and replaced by
 * the fixed grounded refusal with NO source list. The invalid candidate text
 * never appears in the plan, so it can never reach emitted chunks.
 *
 * TRUST BOUNDARY: this refusal substitution is a SERVER-SELECTED plan —
 * the refusal text is produced by trusted server code (alongside the
 * evidence-gate refusal before generation), not by the model, so it makes
 * no claims and needs no citations. This exemption applies to
 * server-selected refusal plans ONLY: validateCitedAnswer never grants it
 * to its input, and every model candidate must pass strict validation
 * before the route may deliver this plan.
 */
export function planDelivery(result: CitationValidationResult): DeliveryPlan {
  if (result.valid) {
    return {
      text: result.normalizedAnswer,
      refused: false,
      citedIds: result.citedSourceIds,
      citationCount: result.citedSourceIds.length,
    };
  }
  return {
    text: GROUNDED_REFUSAL,
    refused: true,
    citedIds: [],
    citationCount: 0,
  };
}

/**
 * The request's evidence sources filtered to the cited ids, in first-appearance
 * order. Returns [] when nothing valid was cited — never all retrieved sources.
 */
export function orderCitedSources(sources: EvidenceSource[], citedIds: string[]): EvidenceSource[] {
  const rank = new Map(citedIds.map((id, i) => [id, i] as const));
  return sources
    .filter((source) => rank.has(source.sourceId))
    .sort((a, b) => rank.get(a.sourceId)! - rank.get(b.sourceId)!);
}

/**
 * Split a validated answer into emission chunks. The chunks are produced
 * AFTER validation from the already-validated text — this is validated-answer
 * emission for a client protocol that expects streaming, not raw
 * model-token streaming. No artificial delays are added. Joining the chunks
 * reproduces the input text exactly.
 */
export function chunkAnswerForEmission(
  text: string,
  chunkSize: number = EMISSION_CHUNK_SIZE,
): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  const words = text.split(/(\s+)/);
  let current = "";
  for (const word of words) {
    if ((current + word).length > chunkSize && current.length > 0) {
      chunks.push(current);
      current = "";
    }
    current += word;
    if (current.length >= chunkSize) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Safe telemetry — never carries prompt, answer, evidence, or secrets
// ---------------------------------------------------------------------------

export type CitationValidationTelemetry = {
  requestId: string;
  success: boolean;
  failureReason: CitationFailureReason | null;
  blockIndex: number | null;
  citationCount: number;
  allowedSourceCount: number;
  generationAttempts: number;
  /**
   * Citation-contract version — the validator logic that ran
   * (CITATION_CONTRACT_VERSION). Distinct from the deployment release.
   */
  contractVersion: string;
  /**
   * Deployment release the code ran under, from QV_RELEASE. Null when
   * QV_RELEASE is unset — no value is invented. There is no pre-existing
   * per-event release envelope on telemetry events (logEvent adds none;
   * only the health endpoint carries a `version` field), so this payload
   * owns the field rather than duplicating an envelope.
   */
  release: string | null;
};

/**
 * Resolve the deployment release for telemetry. Reads QV_RELEASE (the
 * project's documented release identifier, per .env.example); returns null
 * when it is unset or blank — a missing release is reported as missing,
 * never fabricated.
 */
function resolveTelemetryRelease(override?: string | null): string | null {
  if (override !== undefined) return override;
  const fromEnv = typeof process !== "undefined" ? process.env["QV_RELEASE"] : undefined;
  const trimmed = fromEnv?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build the validation telemetry payload. Only the permitted fields are
 * included: request id, success/failure, failure reason, block index,
 * citation count, allowed-source count, generation-attempt count, the
 * citation-contract version, and the deployment release. No prompt, answer,
 * evidence, or secret material.
 */
export function buildValidationTelemetry(input: {
  requestId: string;
  result: CitationValidationResult;
  allowedSourceCount: number;
  generationAttempts: number;
  /**
   * Optional explicit release override (tests, unusual hosts). When omitted,
   * the release resolves from QV_RELEASE, or null when unavailable.
   */
  release?: string | null;
}): CitationValidationTelemetry {
  return {
    requestId: input.requestId,
    success: input.result.valid,
    failureReason: input.result.failureReason,
    blockIndex: input.result.offendingBlockIndex,
    citationCount: input.result.citedSourceIds.length,
    allowedSourceCount: input.allowedSourceCount,
    generationAttempts: input.generationAttempts,
    contractVersion: CITATION_CONTRACT_VERSION,
    release: resolveTelemetryRelease(input.release),
  };
}
