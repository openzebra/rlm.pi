/**
 * Σ fence fold for the transcript — display on screen, original on the wire.
 *
 * pi stores the `message_end` message object in agent state and the session log, so editing
 * its text also edits what the model reads next turn. The registry therefore remembers each
 * folded block's ORIGINAL text (keyed by message timestamp + block index) and `restore`
 * puts it back on the clone the `context` event hands us. Fail-soft: never throws.
 */

import { foldStateFences, hasStatePatch } from "../text/parsing.ts";

interface TextBlockLike { type?: string; text?: string }
interface MessageLike { role?: string; timestamp?: number; content?: unknown }

export interface FoldRegistry {
  /** Fold every text block of `message` that holds a state patch; remembers the originals. */
  fold(message: MessageLike, digest: string): void;
  /** Re-install the original text on any folded message found in `messages`. */
  restore(messages: readonly MessageLike[]): void;
}

const isTextBlock = (b: unknown): b is TextBlockLike & { text: string } =>
  typeof b === "object" && b !== null && (b as TextBlockLike).type === "text" &&
  typeof (b as TextBlockLike).text === "string";

export function createFoldRegistry(): FoldRegistry {
  const originals = new Map<number, ReadonlyMap<number, string>>();
  return {
    fold(message, digest) {
      try {
        const { content, timestamp } = message;
        if (!Array.isArray(content) || typeof timestamp !== "number") return;
        const saved = new Map<number, string>();
        content.forEach((block: unknown, i) => {
          if (!isTextBlock(block) || !hasStatePatch(block.text)) return;
          const folded = foldStateFences(block.text, digest);
          if (folded === block.text) return;
          saved.set(i, block.text);
          block.text = folded;
        });
        if (saved.size > 0) originals.set(timestamp, saved);
      } catch {
        // fail-soft: an unfolded message just shows the raw fence.
      }
    },
    restore(messages) {
      if (originals.size === 0) return;
      try {
        for (const m of messages) {
          if (m.role !== "assistant" || !Array.isArray(m.content) || typeof m.timestamp !== "number") continue;
          const saved = originals.get(m.timestamp);
          if (saved === undefined) continue;
          saved.forEach((text, i) => {
            const block: unknown = m.content instanceof Array ? m.content[i] : undefined;
            if (isTextBlock(block)) block.text = text;
          });
        }
      } catch {
        // fail-soft: identity context beats a broken turn.
      }
    },
  };
}
