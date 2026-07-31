/**
 * Per-phase guidance for the gated RLM pipeline.
 * Injected at each phase boundary; the only channel between phases is durable
 * artifacts under .rlm/artifacts/.
 */
import type { Phase } from "../core/pipeline.ts";

const CLARIFY_GUIDANCE = Object.freeze([
  "## Clarify phase (intake interview)",
  "Interview the user until the task is understood. The engine COUNTS ask_user_question",
  "rounds it services — you cannot advance without having actually asked at least once.",
  "",
  "1. Intent first: ask ONE open-ended intent question (what problem, who hits it, what",
  "   success looks like). Options are answer *shapes* (e.g. end user / maintainer / operator);",
  "   do NOT mark a Recommended option. The automatic Other / free-text path carries the real framing.",
  "   Up to 2 more intent rounds if the answer still cannot scope a narrow probe; then proceed",
  "   with what you have.",
  "2. Probe before asking more: ground follow-ups in the REPL (deterministic search over",
  "   context, a few llm_query reads) so questions cite real code as file:line.",
  "3. Confirm inferences, don't record them: batch inferred decisions into one call —",
  "   \"From the code I inferred <behavior> (file:line). Keep or change?\" The user's answer",
  "   is the Decision, not your inference.",
  "4. Scope / shape / detail rounds, one at a time: recommended option first; architecture",
  "   (shape) options must state the tradeoff (\"optimizes X, costs Y\") — never one option",
  "   masquerading as a choice; 2–4 independent detail questions may batch in one call.",
  "5. Classify answers: Decision → record; Correction → re-probe that seam, re-ask dependents;",
  "   Defer → ## Open Questions.",
  "6. Terminate on depth, not politeness: stop when every raised branch has a Decision or a",
  "   Deferral and ## Problem & Intent holds the user's own words verbatim. Do not pad the",
  "   interview; do not ask a final \"looks good?\" rubber-stamp.",
  "7. Then save_artifact(\"clarification\", content) with frontmatter:",
  "     status: ready",
  "     decisions_count: N",
  "     open_questions_count: M",
  "   and body sections:",
  "     ## Problem & Intent  (user's words VERBATIM)",
  "     ## Decisions         (one '- ' bullet per decision)",
  "     ## Open Questions    (one '- ' bullet per deferral; may be empty with count 0)",
  "     ## Non-Goals",
  '   Then advance_phase("research", summary).',
].join("\n"));

const RESEARCH_GUIDANCE = Object.freeze([
  "## Research phase",
  "Read the clarifications artifact (if present) and honor recorded Decisions; do not silently",
  "resolve Open Questions.",
  "Probe the repository, delegate long reads via `llm_query_batched` / `llm_query_chunked`.",
  "Every factual claim about the code MUST be cited as `path/file.ext:LINE` (or `LINE-LINE`).",
  "The engine VERIFIES citations against the working tree — unbacked citations reject advance.",
  "When research is complete, write ONE research document with a `## Findings` section and call:",
  '  `save_artifact("research", content)`  # frontmatter must include `status: ready`',
  '  `advance_phase("blueprint", summary)`',
  "Do not implement code in this phase.",
].join("\n"));

const BLUEPRINT_GUIDANCE = Object.freeze([
  "## Blueprint phase",
  "Read the clarifications artifact (if present) and plan only within recorded Decisions;",
  "Open Questions that would block the design must be re-asked via ask_user_question, not assumed.",
  'Produce ONE plan document and save it with `save_artifact("plan", content)`.',
  "This pipeline is read-only: it produces a plan a human or a native-mode agent executes;",
  "do not write source files here (sandbox write modes are blocked).",
  "Write changes as exact, copy-pasteable before/after code — never as prose instructions.",
  "The ENGINE derive-checks the document — these are hard gates, not suggestions:",
  "- frontmatter: `status: ready`, `phase_count: N`, `phases: [{n: 1, title: ...}, ...]`",
  "- `phases:` / `phase_count` MUST match the `## Phase N:` body headings exactly (fenced examples ignored)",
  "- every `file:line` citation MUST resolve against the working tree at this revision",
  "Each `## Phase N: <title>` section contains:",
  "- `### Changes Required` — per file: path + the exact intended change",
  "- `### Success Criteria` — `#### Automated Verification:` (runnable commands) and",
  "  `#### Manual Verification:` checklists",
  "Phases must be independently implementable in order, each leaving the tree working.",
  'When ready: `advance_phase("validate", summary)`.',
].join("\n"));

const VALIDATE_GUIDANCE = Object.freeze([
  "## Validate phase (adversarial plan review)",
  "Nothing has been implemented — you are reviewing the PLAN, not a diff.",
  "Read the goal artifact (verbatim brief), the clarifications artifact (recorded Decisions),",
  "and the plan. For each plan phase check against the working tree:",
  "- every cited `file:line` still resolves and says what the plan claims",
  "- every file the phase edits exists (or is created by an earlier phase)",
  "- no phase contradicts a recorded Decision or silently resolves an Open Question",
  "- the Success Criteria are actually runnable and actually prove the change",
  "- phases are independently implementable in the stated order",
  "Write ONE review via `save_artifact(\"validation\", content)` with frontmatter:",
  "- `status: ready`",
  "- `blockers_count: <int >= 0>`  # MEASURED — routing key; not prose",
  "- `verdict: pass | fail`  # pass requires blockers_count === 0",
  "Each blocker needs a resolvable `file:line` citation.",
  "Then finalize: `answer[\"content\"] = <the reviewed plan + review summary>; answer[\"ready\"] = True`.",
  "If `blockers_count > 0`, the engine re-enters blueprint (bounded by maxBackwardJumps).",
].join("\n"));

const GUIDANCE: Readonly<Record<Phase, string>> = Object.freeze({
  clarify: CLARIFY_GUIDANCE,
  research: RESEARCH_GUIDANCE,
  blueprint: BLUEPRINT_GUIDANCE,
  validate: VALIDATE_GUIDANCE,
});

export function phaseGuidance(phase: Phase): string {
  return GUIDANCE[phase];
}
