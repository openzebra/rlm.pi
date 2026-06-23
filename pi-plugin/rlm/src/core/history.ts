/** Shared history mutation helpers used by both the engine loop and the resume fold. */

import type { ChatMsg } from "../bridge/model.ts";

/** Append content to the last user message if adjacent, otherwise push a new user message. */
export function appendUserMessage(history: ChatMsg[], content: string): void {
  const last = history.at(-1);
  if (last?.role === "user") {
    last.content = [last.content, content].join("\n\n");
    return;
  }
  history.push({ role: "user", content });
}
