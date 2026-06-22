/**
 * Parsing helpers: extract ```repl``` code blocks from a model response.
 *
 * The RLM root model emits Python wrapped in fenced blocks tagged `repl`. We extract those
 * blocks in order; everything else is prose the model uses to think out loud.
 */

const FENCE = /```[ \t]*repl[ \t]*\r?\n([\s\S]*?)```/g;

/** Return every ```repl``` block body, in document order. */
export function findReplBlocks(text: string): string[] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    const code = m[1] ?? "";
    if (code.trim()) blocks.push(code.replace(/\s+$/, ""));
  }
  return blocks;
}

/** True if the response contains at least one runnable ```repl``` block. */
export function hasReplBlock(text: string): boolean {
  FENCE.lastIndex = 0;
  return FENCE.test(text);
}

/** Truncate REPL stdout for the model's context window (head + tail, with an elision note). */
export function truncateOutput(text: string, limit = 20_000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n... [${cut} chars elided] ...\n${text.slice(-tail)}`;
}
