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
import { ROOT_TURN_ELIDED_LINE } from "../prompts/glossary.ts";
import { truncateOutput } from "../text/parsing.ts";
import { textContentOf } from "../text/agent-text.ts";

/** The message union Pi passes through the context event (indexed — host evolution safe). */
export type RootMessage = ContextEvent["messages"][number];

export interface ElideOptions {
  readonly keepTurns: number;
  readonly elideChars: number;
}

const ELIDE_MARK = "chars elided — repl sandbox persists: print(answers[k]) or re-run repl to re-derive";

/**
 * WS-3a: elide stale turns. The newest `keepTurns` assistant turns and the final user message
 * stay verbatim. Older turns collapse in two tiers (§5.3 discard semantics + R5/G4 honest
 * strictness, and the only way the R6 acceptance bound — per-call ≤ Σ + window — can hold):
 *   - recent stale ring (the last `max(keepTurns, 1)` stale turns): toolResult payloads over
 *     `elideChars` become head+tail previews (same truncation shape as repl stdout); assistant
 *     prose always collapses to the one-line stub.
 *   - older still: EVERYTHING (payloads included) becomes the one-line session-log stub —
 *     a stale preview per turn would itself accumulate linearly and re-create O(T).
 * `role:"custom"` messages of the Σ/intro kinds are immune (WS-3b owns them). Mutates the
 * array in place; returns the number of messages elided (telemetry), for zero-cost counters.
 */
export function elideStalePayloads(messages: RootMessage[], opts: ElideOptions): number {
  const keepTurns = Math.max(0, Math.floor(opts.keepTurns));
  if (messages.length === 0) return 0;
  // Preview ring: stale turns recent enough to deserve the §5.3 head+tail preview. Scales with
  // the window knob — one calibration, two tiers (preview ring, then stub) — and never zero,
  // so keepTurns=0 still previews the single closest stale payload instead of stubbing blind.
  const previewRing = Math.max(keepTurns, 1);
  if (keepTurns === 0) {
    // R5 strict-0: nothing inside the window — Σ + immune customs + the final user message
    // are all that survive verbatim.
    return elideRange(messages, 0, messages.length, opts, previewRing);
  }

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
  return elideRange(messages, 0, tailStart, opts, previewRing);
}

/** Custom messages the elision never touches — the Σ snapshot/observation and the intro. */
const IMMUNE_CUSTOM_TYPES: ReadonlySet<string> = new Set(["rlm-sigma", "rlm-sigma-observation", "rlm-intro"]);

function isImmuneCustom(m: RootMessage): boolean {
  if (m.role !== "custom") return false;
  const customType: unknown = (m as { customType?: unknown }).customType;
  return typeof customType === "string" && IMMUNE_CUSTOM_TYPES.has(customType);
}

/** R5: elide [from, to) — stale assistant prose always becomes the one-line Σ stub; stale
 *  toolResults get the §5.3 preview while `assistantsAfter < previewRing` and the stub beyond
 *  (two-tier elision — previews must not accumulate linearly). Immune customs and the final
 *  user message are never touched. Mutates in place; returns the elided count. */
function elideRange(
  messages: RootMessage[],
  from: number,
  to: number,
  opts: ElideOptions,
  previewRing: number,
): number {
  const lastUser = lastIndexOfRole(messages, "user");
  // Pre-pass: stale assistant indices in [from, to) — a payload's recency is measured by the
  // stale turns AFTER it (pre-allocated walk, no per-message allocation).
  let staleAssistants = 0;
  for (let i = from; i < to; i++) {
    if (messages[i]?.role === "assistant") staleAssistants += 1;
  }
  let elided = 0;
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (m === undefined || isImmuneCustom(m)) continue;
    if (i === lastUser) continue; // paranoia: the final user message is never touched
    if (m.role === "assistant") {
      staleAssistants -= 1; // turns AFTER this one = count minus itself
      // Provider pairing invariant: Anthropic requires every tool_result to follow the
      // assistant message carrying its tool_use; OpenAI requires each tool/function_call_output
      // to pair with its tool_call/function_call. Eliding the toolCall blocks here orphaned the
      // surviving toolResults and broke the request. Elide only the prose — keep toolCall blocks.
      const toolCalls = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string }>).filter((b) => b?.type === "toolCall")
        : [];
      const content: unknown[] =
        toolCalls.length > 0
          ? [...toolCalls, { type: "text", text: ROOT_TURN_ELIDED_LINE }]
          : [{ type: "text", text: ROOT_TURN_ELIDED_LINE }];
      messages[i] = { ...m, content } as RootMessage;
      elided += 1;
      continue;
    }
    if (m.role !== "toolResult") continue;
    if (staleAssistants >= previewRing) {
      // Deep-stale payload: even the preview would accumulate — collapse to the stub.
      messages[i] = { ...m, content: [{ type: "text", text: ROOT_TURN_ELIDED_LINE }] } as RootMessage;
      elided += 1;
      continue;
    }
    if (totalTextLength(m) <= opts.elideChars) continue;
    messages[i] = {
      ...m,
      content: [{ type: "text", text: previewToolText(m, opts.elideChars) }],
    } as RootMessage;
    elided += 1;
  }
  return elided;
}

/** WS-3b: exactly one live Σ snapshot, immediately before the LAST user message.
 *  R2 (G2): `withContract` makes the splice carry the fence contract (A.4 authoring mode) —
 *  pass-through to runStateRootBlock; without it, the v1 observation-only block. */
export function spliceSigmaSnapshot(
  messages: RootMessage[],
  state: RunState,
  rectifyHint: string | undefined,
  opts?: { readonly withContract?: boolean },
): void {
  const block = runStateRootBlock(state, opts);
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
