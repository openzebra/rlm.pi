/**
 * stage-cards — [rlm.stage] transcript cards for orchestrator stage transitions.
 *
 * Same visual language as zebra-catch's finding cards: a `**◆ …**` header with
 * status + stats, a body paragraph, `− tag (source)` bullets — sent via
 * `pi.sendMessage({ customType, display: true })` so pi draws the labeled box.
 * The renderer honors `options.expanded`, which pi's CustomMessageComponent
 * re-invokes on the user's ctrl+o (app.tools.expand) — collapsed shows the
 * header + expand hint, expanded shows the full card. Digest bodies embed the
 * root-digest text VERBATIM (glossary wording — never re-worded here).
 *
 * Pure builders + one renderer; emission points live in the rlmExtension
 * closure (src/index.ts) — no session state at module load.
 */

import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import type { SkillNoteInput } from "../config/skillstate.ts";
import { previewText } from "../text/preview.ts";
import { expandHint } from "../tool/subcall-render.ts";
import { formatTokens } from "./theme.ts";
import { markdownTheme } from "./theme-adapter.ts";

/** The transcript tag pi renders for these cards — `[rlm.stage]`. */
export const STAGE_CUSTOM_TYPE = "rlm.stage";

/** Distill bullets shown before the "+N more" ellipsis. */
const DISTILL_BULLET_CAP = 8;
/** Note text cap inside a distill bullet — the full note lives in skill.state itself. */
const DISTILL_TEXT_CHARS = 100;

/** One orchestrator stage transition. Discriminated — the renderer never guesses. */
export type StageCardDetails =
  | {
      readonly kind: "digest";
      /** 1-based compaction index (rootDigests counter at emit time). */
      readonly index: number;
      readonly turnsFolded: number;
      /** Host-consumed token estimate for the displaced span (V1 soak probe). */
      readonly tokensBefore: number;
      /** Our own estimate over the same span — divergence here is the probe's signal. */
      readonly tokensBeforeRecomputed: number;
      /** The root-digest summary text, embedded verbatim when expanded. */
      readonly summary: string;
    }
  | {
      readonly kind: "degrade";
      readonly reason: string;
      readonly idleTurns: number;
      readonly idleMax: number;
    }
  | {
      readonly kind: "recover";
      readonly fencesAccepted: number;
      readonly fencesTotal: number;
    }
  | {
      readonly kind: "distill";
      /** The notes this session contributed (pre-id/hits inputs, as handed to SkillStore.merge). */
      readonly merged: readonly SkillNoteInput[];
      readonly total: number;
      readonly byTag: Readonly<Record<string, number>>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Runtime guard for details replayed from old/corrupt session files — fail-soft, never throws. */
export function isStageCardDetails(value: unknown): value is StageCardDetails {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "digest":
      return (
        typeof value.index === "number" &&
        typeof value.turnsFolded === "number" &&
        typeof value.tokensBefore === "number" &&
        typeof value.tokensBeforeRecomputed === "number" &&
        typeof value.summary === "string"
      );
    case "degrade":
      return (
        typeof value.reason === "string" &&
        typeof value.idleTurns === "number" &&
        typeof value.idleMax === "number"
      );
    case "recover":
      return typeof value.fencesAccepted === "number" && typeof value.fencesTotal === "number";
    case "distill": {
      if (typeof value.total !== "number" || !Array.isArray(value.merged) || !isRecord(value.byTag)) return false;
      if (!Object.values(value.byTag).every((v) => typeof v === "number")) return false;
      return value.merged.every((note) => isRecord(note) && typeof note.text === "string");
    }
    default:
      return false;
  }
}

/** "gotcha 4 · recipe 3" — tags with a nonzero count, insertion order. */
function byTagPart(byTag: Readonly<Record<string, number>>): string {
  const parts: string[] = [];
  for (const [tag, count] of Object.entries(byTag)) {
    if (count > 0) parts.push(`${tag} ${String(count)}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(" · ")})`;
}

/** The `**◆ …**` headline — the only thing visible while collapsed. */
export function stageCardHeaderLine(details: StageCardDetails): string {
  switch (details.kind) {
    case "digest":
      return (
        `**◆ digest #${String(details.index)}** folded ${String(details.turnsFolded)} turns · ` +
        `${formatTokens(details.tokensBefore)} tok (recomputed ${formatTokens(details.tokensBeforeRecomputed)})`
      );
    case "degrade":
      return (
        `**⚠ Σ degraded** idle ${String(details.idleTurns)}/${String(details.idleMax)} fence-eligible turns · ` +
        previewText(details.reason, 80)
      );
    case "recover":
      return `**◆ Σ recovered** fences accepted ${String(details.fencesAccepted)}/${String(details.fencesTotal)}`;
    case "distill":
      return (
        `**◆ skill.state** +${String(details.merged.length)} notes distilled · ` +
        `${String(details.total)} total${byTagPart(details.byTag)}`
      );
  }
}

/** Body under the header — blank for recover (the headline says it all). */
function stageCardBody(details: StageCardDetails): string {
  switch (details.kind) {
    case "digest":
      return details.summary;
    case "degrade":
      return "− splices paused; tool outcomes still feed Σ (observe floor)";
    case "distill": {
      const shown = details.merged.slice(0, DISTILL_BULLET_CAP);
      const lines = new Array<string>(shown.length);
      for (let i = 0; i < shown.length; i++) {
        const note = shown[i];
        if (note === undefined) continue;
        lines[i] = `− ${note.tags?.[0] ?? "note"}: ${previewText(note.text, DISTILL_TEXT_CHARS)}`;
      }
      const rest = details.merged.length - shown.length;
      return rest > 0 ? [...lines, `− +${String(rest)} more`].join("\n") : lines.join("\n");
    }
    case "recover":
      return "";
  }
}

/** Full card content — what sendMessage stores and what expanded rendering shows. */
export function stageCardMarkdown(details: StageCardDetails): string {
  const body = stageCardBody(details);
  return body === "" ? stageCardHeaderLine(details) : `${stageCardHeaderLine(details)}\n\n${body}`;
}

/** Markdown block styled through the injected theme's adapter. */
function themedMarkdown(text: string, theme: Theme): Markdown {
  return new Markdown(text, 0, 0, markdownTheme(theme), {
    color: (t) => theme.fg("customMessageText", t),
  });
}

/**
 * The [rlm.stage] message renderer — mirrors pi's default custom-message box
 * (labeled Box + Markdown) but honors `expanded`: collapsed shows just the
 * headline + expand hint, expanded the full card. Returns undefined on
 * stale/corrupt details so pi falls back to default rendering (fail-soft,
 * host contract).
 */
export const renderStageCard: MessageRenderer = (message, options, theme) => {
  try {
    if (!isStageCardDetails(message.details)) return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${STAGE_CUSTOM_TYPE}]`)), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(themedMarkdown(
      options.expanded ? stageCardMarkdown(message.details) : stageCardHeaderLine(message.details),
      theme,
    ));
    if (!options.expanded) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(expandHint(theme), 0, 0));
    }
    return box;
  } catch {
    return undefined; // default rendering shows the stored markdown instead
  }
};
