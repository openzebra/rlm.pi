/**
 * Root Σ (WS-2) — deterministic root compaction for the Pi harness orchestrator.
 *
 * When the native session compacts, this replaces Pi's LLM prose summarizer with a
 * structural digest: the same no-LLM distillation shape the engine proven-uses at its
 * budget hard-state (core/budget.ts:distillTrajectory), adapted to host AgentMessages.
 * Zero summary tokens; compaction becomes reproducible. Paper framing: the digest is a
 * Σ-style sufficient statistic (§3.1) — sections are ordered by continuity value, and the
 * verbatim tail after `firstKeptEntryId` stays byte-identical (§5.3 observation override:
 * fresh tool results outrank the digest).
 *
 * Cut-point semantics: Pi's preparation already picked `firstKeptEntryId` via its
 * keepRecentTokens walk. We only ever TIGHTEN (move the cut later, shrinking the verbatim
 * tail toward `rootDigestKeepRecentChars`) — never extend — and fold every message the
 * tighter cut displaces into the digest inputs, so nothing is dropped unaccounted. Cuts
 * land on entry boundaries Pi itself treats as safe (the walk is char-budgeted over whole
 * entries, mirroring pi-docs/compaction.md's accumulate-and-cut).
 *
 * Failure semantics: pure function, no model call, no throw paths — the index.ts handler
 * still wraps it fail-soft (host contract: handlers must not throw) and returns undefined
 * so Pi falls back to its own summarizer.
 */

import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RlmConfig } from "./types.ts";
import { DEFAULT_NEXT_STEP, NEXT_STEP_RE, truncateMid } from "./budget.ts";
import { agentMessageText } from "../text/agent-text.ts";
import { isRecord } from "../util/type-guards.ts";
import { ROOT_DIGEST_HEADER, ROOT_DIGEST_SECTIONS } from "../prompts/glossary.ts";

/** Marker persisted on the session's compaction entry — tests and soaks assert on it. */
export interface RootDigestDetails {
  readonly kind: "root-digest";
  readonly version: 1;
}

/** Structural slice of SkillStore the digest needs — tests inject stand-ins without a store. */
export interface DigestFactSource {
  sliceForPrompt(query: string, budgetTokens: number, minScore: number): string;
}

/** `SessionBeforeCompactEvent["preparation"]` slice — indexed on the event shape upstream. */
export interface RootDigestPreparation {
  readonly firstKeptEntryId: string;
  readonly messagesToSummarize: readonly unknown[];
  readonly isSplitTurn: boolean;
  readonly tokensBefore: number;
}

export interface RootDigestArgs {
  readonly preparation: RootDigestPreparation;
  /** Chronological session entries (event.branchEntries) — the tighten walk reads these. */
  readonly branchEntries: readonly SessionEntry[];
  readonly config: Pick<RlmConfig, "rootDigestKeepRecentChars" | "rootDigestMaxChars" | "skillStateMinScore">;
  readonly store: DigestFactSource | undefined;
}

/** Digest section caps — ported from budget.ts distillTrajectory (findings ≤6, states ≤8). */
const FINDINGS_MAX = 6;
const FINDINGS_MIN_CHARS = 20;
const STATE_MAX = 8;
const BULLET_CHARS = 400;
const TASK_FRACTION = 0.3;
const FACTS_FRACTION = 4; // facts budget = maxChars / FACTS_FRACTION, tokens at 4 chars/token

/** AgentMessage-shaped projection of one session entry (host sessionEntryToContextMessages shape). */
function entryMessages(entry: SessionEntry): readonly unknown[] {
  if (!isRecord(entry)) return [];
  if (entry.type === "message" && isRecord(entry.message)) return [entry.message];
  if (entry.type === "custom_message") return [{ role: "custom", content: entry.content }];
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return [{ role: "compactionSummary", summary: entry.summary }];
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return [{ role: "branchSummary", summary: entry.summary }];
  }
  return [];
}

function entryChars(entry: SessionEntry): number {
  let total = 0;
  for (const message of entryMessages(entry)) total += agentMessageText(message).length + 8;
  return total;
}
/**
 * The ONE tighten walk: index of the first entry kept verbatim (≥ piCut). Walks backward
 * accumulating entry chars until the budget is met; when the whole tail fits under the
 * budget, Pi's boundary stands — we never EXTEND the digest span past Pi's cut.
 */
function tightenedCut(entries: readonly SessionEntry[], piCut: number, keepChars: number): number {
  let acc = 0;
  for (let i = entries.length - 1; i >= piCut; i--) {
    acc += entryChars(entries[i]);
    if (acc >= keepChars) return i;
  }
  return piCut;
}

/** [Task] — the LAST user prompt in the span (the ask still in force when compaction hits). */
function taskSection(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isRecord(m) && m.role === "user") {
      const text = agentMessageText(m).trim();
      if (text !== "") return text;
    }
  }
  return "";
}

/** [Findings] — newest-first substantive assistant blobs, capped, then chronological. */
function findingsSection(messages: readonly unknown[]): readonly string[] {
  const findings: string[] = [];
  for (let i = messages.length - 1; i >= 0 && findings.length < FINDINGS_MAX; i--) {
    const m = messages[i];
    if (!isRecord(m) || m.role !== "assistant") continue;
    const text = agentMessageText(m).trim();
    if (text.length > FINDINGS_MIN_CHARS) findings.push(text);
  }
  findings.reverse();
  return findings;
}

/** [State] — newest-first toolResult first-lines (the last observed machinery state). */
function stateSection(messages: readonly unknown[]): readonly string[] {
  const states: string[] = [];
  for (let i = messages.length - 1; i >= 0 && states.length < STATE_MAX; i--) {
    const m = messages[i];
    if (!isRecord(m) || m.role !== "toolResult") continue;
    const text = agentMessageText(m).trim();
    if (text === "") continue;
    const tool = typeof m.toolName === "string" ? m.toolName : "tool";
    states.push(`${tool}: ${text.split("\n", 1)[0] ?? text}`);
  }
  states.reverse();
  return states;
}

/**
 * Build the digest compaction. Returns undefined when Pi should keep its own path:
 * split turns (our flat summary would double-count the turn prefix) or an empty span.
 */
export function buildRootDigestCompaction(
  args: RootDigestArgs,
): { readonly compaction: CompactionResult<RootDigestDetails> } | undefined {
  const prep = args.preparation;
  if (prep.isSplitTurn) return undefined;

  const piCut = args.branchEntries.findIndex((entry) => entry.id === prep.firstKeptEntryId);
  const cut = piCut < 0 ? -1 : tightenedCut(args.branchEntries, piCut, args.config.rootDigestKeepRecentChars);

  const messages: unknown[] = [...prep.messagesToSummarize];
  if (cut > piCut && piCut >= 0) {
    for (let i = piCut; i < cut; i++) messages.push(...entryMessages(args.branchEntries[i]));
  }
  if (messages.length === 0) return undefined;

  const max = Math.max(200, args.config.rootDigestMaxChars);
  const task = truncateMid(taskSection(messages), Math.floor(max * TASK_FRACTION));
  const findings = findingsSection(messages).map((f) => truncateMid(f, BULLET_CHARS));
  const states = stateSection(messages);
  // Next-step probe mirrors distillTrajectory: newest-first scan, chronological render.
  const next = findings.find((f) => NEXT_STEP_RE.test(f)) ?? DEFAULT_NEXT_STEP;
  const facts = args.store === undefined
    ? ""
    : args.store.sliceForPrompt(
        task,
        Math.max(1, Math.floor(max / FACTS_FRACTION / 4)),
        args.config.skillStateMinScore,
      );

  const render = (factsText: string, stateLines: readonly string[], findingLines: readonly string[]): string => {
    const blocks: string[] = [ROOT_DIGEST_HEADER];
    const section = (label: string, body: string): void => {
      if (body.trim() !== "") blocks.push(`[${label}] ${body}`);
    };
    section(ROOT_DIGEST_SECTIONS.task, task);
    section(ROOT_DIGEST_SECTIONS.findings, findingLines.map((f) => `- ${f}`).join("\n"));
    section(ROOT_DIGEST_SECTIONS.state, stateLines.map((s) => `- ${s}`).join("\n"));
    section(ROOT_DIGEST_SECTIONS.next, next);
    section(ROOT_DIGEST_SECTIONS.facts, factsText);
    return blocks.join("\n\n");
  };

  // Over-cap drop order: [Project facts] → [State] → [Findings]; [Task]/[Next] survive to a
  // final truncate — task continuity beats trivia (paper §3.1 sufficient statistic).
  let summary = render(facts, states, findings);
  if (summary.length > max) summary = render("", states, findings);
  if (summary.length > max) summary = render("", [], findings);
  if (summary.length > max) {
    summary = render("", [], findings.slice(0, Math.max(1, Math.floor(findings.length / 2))));
  }
  summary = truncateMid(summary, max);

  const boundary = cut >= 0 ? args.branchEntries[cut] : undefined;
  return {
    compaction: {
      summary,
      firstKeptEntryId: (isRecord(boundary) && typeof boundary.id === "string" ? boundary.id : undefined)
        ?? prep.firstKeptEntryId,
      tokensBefore: prep.tokensBefore,
      details: { kind: "root-digest", version: 1 },
    },
  };
}
