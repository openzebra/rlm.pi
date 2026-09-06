/**
 * Root Σ (WS-3) — per-LLM-call A_t assembly for the native Pi session, via the `context`
 * event (which feeds Pi's transformContext → applied on EVERY provider call).
 *
 * Pi hands handlers a structuredClone of the outgoing messages; the LAST returned array
 * wins and the disk transcript is never touched — context is the query channel, the
 * session log stays the archive (LLM-memory-survey thesis). Both transforms mutate the
 * clone in place (new message objects land in the same array slots; splice uses the same
 * array) to honor the zero-extra-allocations rule.
 *
 * - `elideStalePayloads` — discard semantics (paper §5.3): tool payloads older than the
 *   keep window become head+tail previews; the full bytes remain in the session log.
 * - `spliceSigmaSnapshot` — the fresh Σ snapshot rides immediately before the last user
 *   message, exactly one instance (previous ones are removed — idempotent per call).
 *
 * Both are pure with respect to the transcript and never throw on weird shapes.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { RunState } from "./run-state.ts";
import { runStateRootBlock } from "./run-state.ts";
import { truncateOutput } from "../text/parsing.ts";
import { textContentOf } from "../text/agent-text.ts";

/** The message union Pi passes through the context event (indexed — host evolution safe). */
export type RootMessage = ContextEvent["messages"][number];

export interface ElideOptions {
  readonly keepTurns: number;
  readonly elideChars: number;
}

const ELIDE_MARK = "chars elided — full result in session log";

/**
 * WS-3a: elide stale tool payloads. The newest `keepTurns` assistant turns and the final
 * user message stay verbatim; older toolResult content over `elideChars` becomes a
 * head+tail preview (same truncation shape as repl stdout). `role:"custom"` messages with
 * `customType: "rlm-sigma"` are immune (WS-3b owns them). Mutates the array in place;
 * returns the number of messages elided (telemetry), for zero-cost counters at the seam.
 */
export function elideStalePayloads(messages: RootMessage[], opts: ElideOptions): number {
  const keepTurns = Math.max(0, Math.floor(opts.keepTurns));
  if (keepTurns === 0 || messages.length === 0) return 0;

  // Index of the assistant message that opens the keepTurns-th-from-last turn — everything
  // from there on is the protected tail (same walk as core/compaction.ts elideOldToolPayloads).
  let tailStart = -1;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      seen += 1;
      if (seen >= keepTurns) {
        tailStart = i;
        break;
      }
    }
  }
  if (tailStart <= 0) return 0; // fewer turns than the window — nothing to elide

  const lastUser = lastIndexOfRole(messages, "user");
  let elided = 0;
  for (let i = 0; i < tailStart; i++) {
    const m = messages[i];
    if (m === undefined || m.role !== "toolResult") continue;
    if (i === lastUser) continue; // paranoia: the final user message is never touched
    const total = totalTextLength(m);
    if (total <= opts.elideChars) continue;
    messages[i] = {
      ...m,
      content: [{ type: "text", text: previewToolText(m, opts.elideChars) }],
    } as RootMessage;
    elided += 1;
  }
  return elided;
}

/** WS-3b: exactly one live Σ snapshot, immediately before the LAST user message. */
export function spliceSigmaSnapshot(
  messages: RootMessage[],
  state: RunState,
  rectifyHint: string | undefined,
): void {
  const block = runStateRootBlock(state);
  const text = rectifyHint === undefined ? block : `${block}\n${rectifyHint}`;
  // Remove any previous instance (only one lives at a time — idempotent across calls).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isSigmaSnapshot(m)) messages.splice(i, 1);
  }
  const at = lastIndexOfRole(messages, "user");
  const sigma: RootMessage = {
    role: "custom",
    customType: "rlm-sigma",
    content: text,
    display: false,
    details: { kind: "sigma-snapshot", updatedAt: state.updatedAt },
    timestamp: Date.now(),
  } as RootMessage;
  if (at < 0) {
    messages.push(sigma); // no user message (degenerate) — append; still exactly one
  } else {
    messages.splice(at, 0, sigma);
  }
}

function isSigmaSnapshot(m: RootMessage | undefined): boolean {
  return m !== undefined && m.role === "custom" && (m as { customType?: unknown }).customType === "rlm-sigma";
}

function lastIndexOfRole(messages: readonly RootMessage[], role: "user"): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return i;
  }
  return -1;
}

function totalTextLength(message: RootMessage): number {
  return textContentOf((message as { content?: unknown }).content).length;
}

function previewToolText(message: RootMessage, elideChars: number): string {
  const text = textContentOf((message as { content?: unknown }).content);
  // The preview REPLACES the payload, so `elideChars` budgets the WHOLE head+tail result.
  return truncateOutput(text, Math.max(100, elideChars), ELIDE_MARK);
}
