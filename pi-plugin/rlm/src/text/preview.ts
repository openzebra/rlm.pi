/** Shared short text previews for live tree rows. */

import type { ReplResult } from "../sandbox/protocol.ts";

const DEFAULT_PREVIEW_CHARS = 200;

export function previewText(text: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 1))}…` : normalized;
}

export function previewStdout(results: readonly ReplResult[]): string {
  for (let index = results.length - 1; index >= 0; index--) {
    const stdout = results[index]?.stdout.trim();
    if (stdout) return previewText(stdout);
  }
  return "";
}
