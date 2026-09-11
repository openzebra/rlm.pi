/**
 * Trajectory compaction (port of rlm/core/rlm.py `_compact_history`).
 *
 * When the root history grows past a fraction of the model's context window, replace the middle
 * of the conversation with a single running summary — a bounded-memory recap (the linear-space
 * idea from DP sequence alignment). Keeps the system message + a fresh "continue" instruction.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import type { RetryPolicy } from "../util/retry.ts";
import { estimateMessageTokens } from "../text/tokens.ts";
import type { RunState } from "../core/run-state.ts";
import { compactJSON } from "../core/run-state.ts";
import { COMPACTION_CEILING_TOKENS } from "./limits.ts";

const SUMMARY_REQUEST =
  "Summarize your progress so far. Include: (1) which sub-tasks are done and which remain; " +
  "(2) any concrete intermediate results — numbers, values, variable names — preserved exactly; " +
  "(3) your next action. Be concise (1–3 paragraphs) but preserve all key results.";

interface CompactionDeps {
  readonly model: Model<Api>;
  readonly registry: ModelRegistry;
  readonly contextWindow?: number;
  readonly signal?: AbortSignal;
  /** v5.1 retry policy for modelComplete; defaults apply when omitted. */
  readonly retry?: RetryPolicy;
}

/**
 * True if the history is at/over the compaction threshold — the ABSOLUTE
 * COMPACTION_CEILING_TOKENS (LO rule 2025-09-09): windows ≤ 256k never compact; larger
 * windows compact exactly at 256k. `contextWindow`/`thresholdPct` percentage math is gone.
 */
export function shouldCompact(history: ChatMsg[]): boolean {
  return estimateMessageTokens(history) >= COMPACTION_CEILING_TOKENS;
}

/**
 * P3.2 (plan §3.4): never elide an ANSWER FRAME — `answer['content'] = …` is the run's only
 * durable output, and dropping it from history is how a finished run still reports empty.
 */
const ANSWER_FRAME_RE = /answer\[\s*['"](?:content|ready)['"]\s*\]|answers\s*\.\s*update\s*\(/;

/** Identifier shape used by the last-reference scan (`counter_a`, `rows_by_label`, …). */
const REF_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
/** Bounds: per-payload ids and the growing "future" set stay tiny (O(T·N) with small N). */
const PAYLOAD_TOKEN_CAP = 64;
const REF_TOKEN_CAP = 512;

/** Whitespace-collapsed body skeleton — two identical page dumps share it even when the
 *  turn banner differs (P3.2 "按内容签名去重"). Exact text, NOT digit-normalised: two
 *  `counter_a=875` / `counter_a=499` payloads are different conclusions and must not collapse. */
function payloadSignature(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 400) + "#" + content.length;
}

function payloadTokens(content: string, into: Set<string>): void {
  let n = 0;
  REF_TOKEN_RE.lastIndex = 0;
  for (let m = REF_TOKEN_RE.exec(content); m !== null; m = REF_TOKEN_RE.exec(content)) {
    into.add(m[0]);
    if (++n >= PAYLOAD_TOKEN_CAP) return;
  }
}

/**
 * v5 G1: elide old tool/repl payload bodies, keep the head (system) and the working-set tail
 * intact. Runs BEFORE `shouldCompact` — v3 measured −97% tokens on coding tasks with this
 * alone, often avoiding the summarizer entirely. Head-ONLY elision was a measured v3 bug
 * (turns grew 3→8): the tail carries the current working set, so the last `keepTurns` turns
 * are never touched.
 *
 * P3.2 adds a whitelist on top of the volume rule (which stays as the floor — dedup and
 * exemptions only ever REMOVE bytes, never add them back):
 *  - answer frames and payloads whose identifiers a later turn still mentions are kept verbatim;
 *  - a payload byte-identical to an earlier one collapses to a one-line stub.
 */
export function elideOldToolPayloads(
  history: ChatMsg[],
  keepTurns = 2,
  toolChars = 1_500,
): ChatMsg[] {
  if (history.length === 0) return history;
  // Find the assistant message that starts the keepTurns-th-from-last turn; everything from
  // there on is the protected tail.
  let tailStart = 0;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      seen++;
      if (seen >= keepTurns) {
        tailStart = i;
        break;
      }
    }
  }
  if (tailStart === 0) return history; // fewer turns than keepTurns — nothing to elide

  // Last-reference scan (descending): `future` holds the identifiers mentioned by everything
  // AFTER the message we are looking at — the working set the model still has in hand.
  const future = new Set<string>();
  const referenced = new Array<boolean>(history.length).fill(false);
  const ids = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") {
      if (future.size < REF_TOKEN_CAP) payloadTokens(m.content, future);
      continue;
    }
    if (m.role !== "user" || i >= tailStart || m.content.length <= toolChars) continue;
    if (ANSWER_FRAME_RE.test(m.content)) continue; // answer frames are kept anyway
    ids.clear();
    payloadTokens(m.content.slice(0, 2_000), ids);
    for (const id of ids) {
      if (future.has(id)) {
        referenced[i] = true;
        break;
      }
    }
  }

  let changed = false;
  const marker =
    "\n…[elided v5-G1 — your repl sandbox is INTACT: variables/answers persist; re-run or " +
    "print(answers) in the next repl to re-derive this content]…";
  const dupMarker =
    "\n…[dup v5-G1 — byte-identical payload already in this history; sandbox INTACT: " +
    "print(<expr>) to inspect it again]…";
  const signatures = new Set<string>();
  const out: ChatMsg[] = new Array<ChatMsg>(history.length); // pre-allocated
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (i < tailStart && m.role === "user" && m.content.length > toolChars) {
      if (ANSWER_FRAME_RE.test(m.content)) {
        out[i] = m; // never touch the answer frame
        continue;
      }
      const sig = payloadSignature(m.content);
      if (signatures.has(sig)) {
        out[i] = { role: "user", content: dupMarker.trimStart() };
        changed = true;
        continue;
      }
      signatures.add(sig);
      if (referenced[i]) {
        out[i] = m; // a later turn still names what this payload produced
        continue;
      }
      // Elided message is capped at exactly toolChars total (§5.3 preview + marker).
      const body = m.content.slice(0, Math.max(0, toolChars - marker.length));
      out[i] = { role: "user", content: body + marker };
      changed = true;
    } else {
      out[i] = m;
    }
  }
  return changed ? out : history;
}

/**
 * Summarize the trajectory and return a compacted history: [system, summary(assistant),
 * continue(user)]. The caller continues appending turns from there.
 */
export async function compactHistory(
  history: ChatMsg[],
  deps: CompactionDeps,
  count = 1,
  onUsage?: (u: Usage) => void,
): Promise<ChatMsg[]> {
  const { text: summary, usage } = await modelComplete([...history, { role: "user", content: SUMMARY_REQUEST }], {
    model: deps.model,
    registry: deps.registry,
    signal: deps.signal,
    retry: deps.retry,
  });
  onUsage?.(usage);
  const system = history.find((m) => m.role === "system");
  const head: ChatMsg[] = system ? [system] : [];
  return [
    ...head,
    { role: "assistant", content: summary },
    {
      role: "user",
      content:
        `Your conversation has been compacted ${count} time(s). Continue from the summary above. ` +
        "Do NOT repeat completed work. Use SHOW_VARS() to see existing REPL variables. Your next action:",
    },
  ];
}

/** Same protected-tail rule as elideOldToolPayloads: the working set survives verbatim. */
const REBASE_KEEP_TURNS = 2;

/**
 * Workstream A: structural rebase — the SKILL.state replacement for the LLM summary path.
 *
 *   history := [ P , user("[Σ] …") , window(O) ]
 *
 * Everything older than the protected tail is superseded by the EXACT execution state — no
 * model call is made at all (the summarizer LLM call disappears by design; the `compactions`
 * counter still moves so telemetry stays comparable). Failure semantics: pure function, no
 * fallible operations — the degraded path keeps `compactHistory` for as-built runs.
 */
export function rebaseWithState(history: ChatMsg[], state: RunState, count = 1): ChatMsg[] {
  const system = history.find((m) => m.role === "system");
  const head: ChatMsg[] = system ? [system] : [];
  let tailStart = history.length;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      seen += 1;
      if (seen >= REBASE_KEEP_TURNS) {
        tailStart = i;
        break;
      }
    }
  }
  // Token-bounded tail (LO rule 2025-09-09): the kept turns must also fit under the absolute
  // ceiling; walk tailStart forward until the tail does. Σ carries everything dropped turns held.
  const sizes: number[] = new Array<number>(history.length);
  for (let i = 0; i < history.length; i++) sizes[i] = estimateMessageTokens([history[i]]);
  let tailTokens = 0;
  for (let i = tailStart; i < history.length; i++) tailTokens += sizes[i];
  while (tailStart < history.length && tailTokens > COMPACTION_CEILING_TOKENS) {
    tailTokens -= sizes[tailStart];
    tailStart += 1;
  }
  const window: ChatMsg[] = tailStart < history.length ? history.slice(tailStart) : [];
  return [
    ...head,
    {
      role: "user",
      content:
        `Your conversation was structurally rebased ${count} time(s): older turns are superseded ` +
        `by the exact execution state below — do NOT repeat completed work; fresh tool results ` +
        `outrank Σ when they disagree.\n[Σ] ${compactJSON(state)}`,
    },
    ...window,
  ];
}
