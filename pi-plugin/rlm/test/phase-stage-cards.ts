/**
 * phase-stage-cards — [rlm.stage] transcript cards: header/markdown builders,
 * the runtime details guard, and the renderer's collapsed/expanded split.
 * Pure — no TUI session, the components render through an identity theme.
 */

import { check, failureCount } from "./helpers.ts";
import {
  STAGE_CUSTOM_TYPE,
  isStageCardDetails,
  renderStageCard,
  stageCardHeaderLine,
  stageCardMarkdown,
  type StageCardDetails,
} from "../src/ui/stage-cards.ts";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";

/** The custom-message shape the renderer receives (CustomMessage isn't re-exported). */
type StageMessage = Parameters<MessageRenderer>[0];

// Identity theme: assertions match raw text, colors would only add noise.
const theme = { fg: (_color: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

const DIGEST: StageCardDetails = {
  kind: "digest",
  index: 1,
  turnsFolded: 14,
  tokensBefore: 12_300,
  tokensBeforeRecomputed: 12_100,
  summary: "[Root digest — deterministic structural compaction (no model call).]\n\n[Task] fix flaky bench snapshot",
};
const DEGRADE: StageCardDetails = { kind: "degrade", reason: "idle ladder exhausted", idleTurns: 6, idleMax: 6 };
const RECOVER: StageCardDetails = { kind: "recover", fencesAccepted: 3, fencesTotal: 3 };
const DISTILL: StageCardDetails = {
  kind: "distill",
  merged: [
    { text: "smokes boot a real sandbox — never mock the worker", tags: ["gotcha"] },
    { text: "A/B bench via RLM_BENCH_NO_ROOTCONTEXT=1", tags: ["recipe"] },
    { text: "buildRows — ui/tree/tree-model.ts", tags: ["symbol"] },
  ],
  total: 12,
  byTag: { gotcha: 4, recipe: 3, symbol: 5 },
};

// ── headers: one `◆/⚠` headline per kind, honest numbers ──
{
  check("header: digest folds turns + both token estimates",
    stageCardHeaderLine(DIGEST).includes("folded 14 turns") &&
    stageCardHeaderLine(DIGEST).includes("12.3k tok (recomputed 12.1k)"));
  check("header: degrade shows idle ladder", stageCardHeaderLine(DEGRADE).includes("⚠ Σ degraded") && stageCardHeaderLine(DEGRADE).includes("idle 6/6"));
  check("header: recover shows fence tally", stageCardHeaderLine(RECOVER).includes("◆ Σ recovered") && stageCardHeaderLine(RECOVER).includes("3/3"));
  check("header: distill shows delta + tag histogram",
    stageCardHeaderLine(DISTILL).includes("+3 notes distilled") && stageCardHeaderLine(DISTILL).includes("12 total") &&
    stageCardHeaderLine(DISTILL).includes("gotcha 4 · recipe 3 · symbol 5"));
}

// ── markdown: digest body VERBATIM, distill bullets, recover header-only ──
{
  const digest = stageCardMarkdown(DIGEST);
  check("markdown: digest embeds the summary verbatim", digest.includes(DIGEST.summary) && digest.includes("[Task] fix flaky bench snapshot"));
  check("markdown: degrade carries the splice-floor note", stageCardMarkdown(DEGRADE).includes("tool outcomes still feed Σ"));
  const distill = stageCardMarkdown(DISTILL);
  check("markdown: distill bullets carry tag + text", distill.includes("− gotcha: smokes boot a real sandbox") && distill.includes("− symbol: buildRows"));
  check("markdown: recover is headline-only", stageCardMarkdown(RECOVER) === stageCardHeaderLine(RECOVER));
}

// ── distill bullet cap: 8 shown, remainder as one "+N more" line ──
{
  const many: StageCardDetails = {
    kind: "distill",
    merged: Array.from({ length: 11 }, (_, i) => ({ text: `note number ${String(i)} text`, tags: ["recipe"] })),
    total: 11,
    byTag: { recipe: 11 },
  };
  const md = stageCardMarkdown(many);
  const bullets = md.split("\n").filter((l) => l.startsWith("− "));
  check("markdown: bullets capped at 8 + one more-line", bullets.length === 9 && bullets[8] === "− +3 more");
}

// ── guard: real payloads pass, stale/corrupt session data fails closed ──
{
  check("guard: digest ok", isStageCardDetails(DIGEST));
  check("guard: degrade ok", isStageCardDetails(DEGRADE));
  check("guard: recover ok", isStageCardDetails(RECOVER));
  check("guard: distill ok", isStageCardDetails(DISTILL));
  check("guard: non-object rejected", !isStageCardDetails("digest") && !isStageCardDetails(null));
  check("guard: unknown kind rejected", !isStageCardDetails({ kind: "party" }));
  check("guard: digest missing field rejected", !isStageCardDetails({ kind: "digest", index: 1 }));
  check("guard: distill bad note rejected", !isStageCardDetails({ kind: "distill", merged: [{ text: 7 }], total: 1, byTag: {} }));
  check("guard: distill non-numeric tag count rejected",
    !isStageCardDetails({ kind: "distill", merged: [], total: 1, byTag: { gotcha: "many" } }));
}

// ── renderer: collapsed = label + headline + expand hint; expanded = full card ──
{
  const message: StageMessage = {
    role: "custom",
    customType: STAGE_CUSTOM_TYPE,
    content: stageCardMarkdown(DIGEST),
    display: true,
    details: DIGEST,
    timestamp: 0,
  };
  const collapsed = renderStageCard(message, { expanded: false, outputPad: 1 }, theme);
  check("render: collapsed builds a component", collapsed !== undefined);
  if (collapsed !== undefined) {
    const lines = collapsed.render(90);
    const text = lines.join("\n");
    check("render: collapsed shows the [rlm.stage] label", text.includes("[rlm.stage]"));
    check("render: collapsed shows the headline", text.includes("digest #1"));
    check("render: collapsed hides the body", !text.includes("[Task] fix flaky bench snapshot"));
    check("render: collapsed shows the expand hint", text.includes("to expand"));
  }
  const expanded = renderStageCard(message, { expanded: true, outputPad: 1 }, theme);
  check("render: expanded builds a component", expanded !== undefined);
  if (expanded !== undefined) {
    const text = expanded.render(90).join("\n");
    check("render: expanded shows the digest body", text.includes("[Task] fix flaky bench snapshot"));
    check("render: expanded drops the hint", !text.includes("to expand"));
  }
  // Stale details from an old session file fall back to the host's default rendering.
  const stale: StageMessage = { ...message, details: { kind: "party" } };
  check("render: corrupt details render nothing (host fallback)", renderStageCard(stale, { expanded: false, outputPad: 1 }, theme) === undefined);
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
