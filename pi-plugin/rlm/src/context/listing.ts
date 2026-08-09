/**
 * Compact human-readable listing of currently loaded context files for the parent LLM.
 * Shows paths and token estimates — NOT full file contents.
 */

import type { ContextFile } from "./types.ts";
import { isContextFile } from "./namespace.ts";

/** Maximum files shown in the compact LLM listing before truncation. */
const MAX_LLM_LISTING_FILES = 200;

/**
 * Format a context payload (ContextFile[] or empty) for injection into the parent agent's
 * message stream. Empty state points at autoSeedCwd / external add_context — never
 * `add_context(".")`, which would re-pack the already-seeded cwd under a ctx/ prefix.
 */
export function formatContextListing(context: unknown): string {
  const files = toFileList(context);
  if (files.length === 0) {
    return [
      "RLM `context` is EMPTY — no files loaded yet.",
      "The working directory seeds automatically on the first `repl()` call (autoSeedCwd).",
      'Use `add_context("/path/to/dir")` / `add_context("docs.pdf")` / `add_context("https://…")` for external sources.',
      "Documents (PDF, DOCX, XLSX, PPTX, CSV, …) are converted to Markdown on the way in.",
      "",
      "Use repl({code}) and delegate semantic reading to llm_query / llm_query_batched / llm_query_chunked.",
    ].join("\n");
  }

  let totalTokens = 0;
  let totalChars = 0;
  for (let i = 0; i < files.length; i++) {
    totalTokens += files[i].tokens;
    totalChars += files[i].content.length;
  }

  const shown = files.slice(0, MAX_LLM_LISTING_FILES);
  const truncated = files.length > MAX_LLM_LISTING_FILES
    ? `... and ${files.length - MAX_LLM_LISTING_FILES} more files (truncated)`
    : "";

  const listingParts = new Array<string>(shown.length);
  for (let i = 0; i < shown.length; i++) {
    const f = shown[i];
    listingParts[i] =
      `${f.path} (${f.tokens.toLocaleString()} tok, ${f.content.length.toLocaleString()} chars)`;
  }

  return [
    `Context: ${files.length.toLocaleString()} files, ${totalTokens.toLocaleString()} estimated tokens, ${totalChars.toLocaleString()} total characters.`,
    "",
    listingParts.join("\n"),
    truncated,
    "",
    "File contents are loaded in the REPL `context` variable — file-reading tools are disabled.",
    "Use repl({code}) and delegate semantic reading to llm_query / llm_query_batched / llm_query_chunked.",
  ].join("\n");
}

function toFileList(context: unknown): readonly ContextFile[] {
  if (!Array.isArray(context)) return Object.freeze([]);
  const out = new Array<ContextFile>(context.length);
  let n = 0;
  for (let i = 0; i < context.length; i++) {
    const entry: unknown = context[i];
    if (isContextFile(entry)) out[n++] = entry;
  }
  out.length = n;
  return out;
}
