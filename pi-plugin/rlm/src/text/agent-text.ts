/**
 * Text extraction from host AgentMessages (coding-agent `Message | CustomMessage | …` union).
 *
 * The root-Σ modules (core/root-digest.ts, core/root-context.ts) and the index.ts event
 * handlers all need the same "text payload of a message" projection. One implementation
 * here; callers never re-walk content blocks. Everything takes `unknown` and narrows via
 * guards — host shapes evolve, this module is the single adaptation seam.
 */

/** Text payload of one content block list / string: string as-is, `{text}` blocks joined. */
export function textContentOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = new Array<string>(content.length);
  let n = 0;
  for (const block of content) {
    if (isTextBlock(block)) parts[n++] = block.text;
  }
  parts.length = n;
  return parts.join("");
}

function isTextBlock(block: unknown): block is { readonly type: "text"; readonly text: string } {
  return (
    typeof block === "object" && block !== null &&
    (block as Record<string, unknown>).type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
}

/**
 * Text payload of a whole AgentMessage: role-disciplined extraction. `thinking` blocks and
 * tool-call payloads are deliberately skipped (digests/elision want observable prose and
 * results, never the model's private reasoning). Unknown shapes yield "".
 */
export function agentMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const m = message as Record<string, unknown>;
  switch (m.role) {
    case "user":
    case "assistant":
    case "custom":
    case "toolResult":
      return textContentOf(m.content);
    case "compactionSummary":
    case "branchSummary":
      return typeof m.summary === "string" ? m.summary : "";
    default:
      return "";
  }
}

/** First non-blank line, trimmed and capped — the error-reason shape trackers store. */
export function firstLine(text: string, maxChars = 200): string {
  const line = text.split("\n", 1)[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}
