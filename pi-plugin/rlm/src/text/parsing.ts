/**
 * Parsing helpers: extract ```repl``` code blocks from a model response.
 *
 * The RLM root model emits Python wrapped in fenced blocks tagged `repl`. We extract those
 * blocks in order; everything else is prose the model uses to think out loud. Small instruct
 * models often finalize inside ```python / ```py fences (or bare ones) instead; when a response
 * contains no `repl` block at all, those code-ish fences are used as a fallback so the engine
 * still executes their code. Other language tags (```text, ```json, ...) are never executed —
 * the sandbox only runs Python.
 */

const FENCE = /(`{3,})[ \t]*repl[ \t]*\r?\n([\s\S]*?)\1/g;
// The info string is captured so a rejected tag (e.g. ```text) still consumes its whole fence —
// otherwise that fence's own closing ``` could later match as a bare opener and swallow code.
const FALLBACK_FENCE = /(`{3,})[ \t]*([^`\r\n]*)[ \t]*\r?\n([\s\S]*?)\1/g;
const PYTHON_TAG = /^py(thon)?$/i;

import { errorMessage } from "../util/errors.ts";

/** Shared fence scan: run `re` over `text`, keep bodies the selector accepts (same trimming). */
function collectFences(text: string, re: RegExp, select: (m: RegExpExecArray) => string | null): string[] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const code = select(m);
    if (code !== null && code.trim()) blocks.push(code.replace(/\s+$/, ""));
  }
  return blocks;
}

/**
 * Return every ```repl``` block body, in document order. If the response has none, fall back to
 * ```python / ```py / untagged fences — never other language tags, and never a mix of both kinds.
 */
export function findReplBlocks(text: string): string[] {
  const repl = collectFences(text, FENCE, (m) => m[2] ?? "");
  if (repl.length > 0) return repl;
  return collectFences(text, FALLBACK_FENCE, (m) => {
    const tag = m[2] ?? "";
    return tag === "" || PYTHON_TAG.test(tag) ? (m[3] ?? "") : null;
  });
}

/** One ```state fence: parsed JSON payload, or the parse error (error-as-observation). */
export type StateFenceResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const STATE_FENCE = /(`{3,})[ \t]*state[ \t]*\r?\n([\s\S]*?)\1/g;

/** Tolerant fallback: a payload object whose FIRST key is the patch key, emitted without a
 *  (well-formed) fence — soak keeps catching `...report.state {"state_patch": …}}` blobs from
 *  small models that mangle the opening backticks. Matched literally so ordinary prose or
 *  example JSON never trips the scanner. */
const BARE_PATCH = /\{"state_patch"\s*:/g;

/** String-aware balanced-brace scan from `start` (an index of `{`). Honors string literals and
 *  backslash escapes so braces inside JSON strings cannot unbalance the count. Returns the
 *  complete object slice, or undefined when braces never balance before EOF. */
function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** A dangling opener/closer pair after the fence body was mangled (e.g. `.state {…}}` followed
 *  by a lone ``` line) — cosmetic residue we scrub alongside the object itself. */
const ORPHAN_FENCE = /^ {0,3}`{3,}[ \t]*\r?$/gm;

/** Bookkeeping transport, never content: remove well-formed ```state fences AND the bare
 *  {"state_patch"…} objects models leak when they botch the fence syntax (both directions —
 *  parse for Σ harvest, strip for user-visible answers). Order: well-formed fences out first,
 *  then the bare-object scan over the remainder can never double-count the same payload. */
function sansFences(text: string): string {
  return text.replace(STATE_FENCE, "");
}

/**
 * Workstream A: extract ```state fences (model-proposed ΔΣ_t) from a response, in document
 * order. ```repl parsing is untouched — the two fences coexist in one response. Well-formed
 * fences yield parsed payloads or a parse error (error-as-observation for the retry ladder);
 * malformed-fence payloads are recovered by the tolerant bare-object scanner, so a mangled
 * opening fence never orphans a valid delta.
 */
export function findStatePatches(text: string): readonly StateFenceResult[] {
  const out: StateFenceResult[] = [];
  let m: RegExpExecArray | null;
  STATE_FENCE.lastIndex = 0;
  while ((m = STATE_FENCE.exec(text)) !== null) {
    const body = (m[2] ?? "").trim();
    if (body === "") continue;
    try {
      out.push({ ok: true, value: JSON.parse(body) as unknown });
    } catch (err: unknown) {
      out.push({ ok: false, error: errorMessage(err) });
    }
  }
  // Tolerant harvest over fence-free remainder (well-formed payloads already taken above).
  const rest = sansFences(text);
  BARE_PATCH.lastIndex = 0;
  while ((m = BARE_PATCH.exec(rest)) !== null) {
    const obj = balancedJsonObject(rest, m.index);
    if (obj === undefined) continue;
    try {
      out.push({ ok: true, value: JSON.parse(obj) as unknown });
    } catch (err: unknown) {
      out.push({ ok: false, error: errorMessage(err) });
    }
  }
  return out;
}

/** Strip ```state fences from free text. A Σ fence is bookkeeping, never content — but models
 *  that finalize right after a Σ splice tend to echo the fence verbatim as their final output,
 *  which leaked raw state JSON into RlmResult.answer (bench graders scored JSON, reports showed
 *  bookkeeping). Deterministic scrub on the answer path; parse semantics stay in findStatePatches.
 *  Also removes bare {"state_patch"…} objects (mangled-fence leaks), a `state` token glued to
 *  preceding prose, and orphan ``` lines left behind by the mangled pair. */
export function stripStateFences(text: string): string {
  let out = sansFences(text);
  const parts: string[] = [];
  let cursor = 0;
  BARE_PATCH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_PATCH.exec(out)) !== null) {
    const obj = balancedJsonObject(out, m.index);
    if (obj === undefined) continue;
    // Glom any immediately-preceding bare `state`/`.state` token (prose like "...report.state {").
    const before = out.slice(cursor, m.index).replace(/\s*(?:\.?state)\s*$/i, "");
    parts.push(before);
    cursor = m.index + obj.length;
    BARE_PATCH.lastIndex = cursor;
  }
  // No bare objects → leave the text exactly as the well-formed pass left it (a lone ```
  // line can be a legitimate unclosed code fence in real content; only scrub residue that
  // our own removal created).
  if (parts.length === 0) return out.trim();
  parts.push(out.slice(cursor));
  return parts.join("").replace(ORPHAN_FENCE, "").trim();
}

/** Truncate REPL stdout for the model's context window (head + tail, with an elision note).
 *  `mark` lets callers specialize the wording (root elision cites the session log) while the
 *  head/tail math stays the one implementation. */
export function truncateOutput(text: string, limit = 20_000, mark = "chars elided"): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n... [${cut} ${mark}] ...\n${text.slice(-tail)}`;
}
