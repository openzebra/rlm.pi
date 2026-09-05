/**
 * SKILL.state Workstream C — prompt injection seams: Ξ lands BEFORE the metadata line in the
 * headless system prompt; the native static snapshot and its budget stay untouched.
 * Run: bun run pi-plugin/rlm/test/phase-ss-prompt.ts
 */

import { buildMetadataLine, buildRlmSystemPrompt } from "../src/prompts/system.ts";
import { NATIVE_PROMPT_BUDGET, NATIVE_PROMPT_STATIC } from "../src/prompts/native.ts";
import { check, finish } from "./helpers.ts";

const META_LINE_NEEDLE = "Your context is";
const BLOCK = [
  "[Project facts — SkillState, 2 notes, distilled from prior sessions]",
  "- (config) settingsPath() joins getAgentDir()",
  "- (gotcha) llm_query has no filesystem",
].join("\n");

{
  const meta = { contextType: "str" as const, contextChars: 1_000, skillBlock: BLOCK };
  const prompt = buildRlmSystemPrompt(meta, { orchestrator: false });
  check("skill block present", prompt.includes(BLOCK));
  const blockAt = prompt.indexOf(BLOCK);
  const metaAt = prompt.indexOf(META_LINE_NEEDLE);
  check("block precedes the metadata line", blockAt >= 0 && metaAt >= 0 && blockAt < metaAt);

  const plain = buildRlmSystemPrompt(
    { contextType: "str" as const, contextChars: 1_000 },
    { orchestrator: false },
  );
  check("no block ⇒ prompt unchanged", !plain.includes("[Project facts"));
  check("empty-string block ⇒ prompt unchanged", buildRlmSystemPrompt(
    { contextType: "str" as const, contextChars: 1_000, skillBlock: "" },
    { orchestrator: false },
  ) === plain);
}

{
  // Files-kind context: same seam, block still before metadata (which includes the <task>).
  const meta = {
    contextType: "list[dict]" as const,
    contextChars: 5_000,
    rootPrompt: "audit the retry path",
    skillBlock: BLOCK,
  };
  const prompt = buildRlmSystemPrompt(meta, { orchestrator: false });
  check("files-kind: block present", prompt.includes(BLOCK));
  check("files-kind: block before metadata", prompt.indexOf(BLOCK) < prompt.indexOf(META_LINE_NEEDLE));
  check("files-kind: task header still last-ish", prompt.indexOf("<task>") > prompt.indexOf(BLOCK));
  check("metadata line helper unchanged", buildMetadataLine({ contextType: "str", contextChars: 10 }).includes(META_LINE_NEEDLE));
}

{
  // Native mode: the STATIC snapshot never carries session text; dynamic Ξ is concatenated
  // per-session in index.ts. Guard the invariant the whole design rests on.
  check("native static snapshot within budget", NATIVE_PROMPT_STATIC.length <= NATIVE_PROMPT_BUDGET,
    `${NATIVE_PROMPT_STATIC.length} <= ${NATIVE_PROMPT_BUDGET}`);
  check("native static snapshot has no Ξ", !NATIVE_PROMPT_STATIC.includes("SkillState"));
  check("native budget untouched", NATIVE_PROMPT_BUDGET === 9_500);
}

finish();
