/**
 * `ask_user_question` — the sandbox's only interactive escape hatch.
 *
 * Two halves of one seam: `createPiInteractiveDeps` turns a Pi ExtensionContext into the
 * callback the engine/tool carries around, and `buildInteractiveHandlers` wraps that callback
 * in the sub-call emit pattern the sandbox handler surface expects.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractiveDeps } from "../core/types.ts";
import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";
import type { SubLlmHandlers } from "../sandbox/sandbox.ts";
import type { RlmEmitter } from "../tool/rlm-events.ts";
import { formatError } from "../util/errors.ts";

async function askViaUi(ctx: ExtensionContext, questions: readonly AskQuestion[]): Promise<AskAnswer[]> {
  if (!ctx.hasUI) throw new Error("ask_user_question requires UI");
  const answers = new Array<AskAnswer>(questions.length);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q) {
      answers[i] = { question: "", selected: [], custom: formatError("malformed question") };
      continue;
    }
    if (q.multiSelect) {
      const selected: string[] = [];
      while (true) {
        const pick = await ctx.ui.select(`${q.header}: ${q.question}`, [...q.options.map((o) => o.label), "Done"]);
        if (!pick || pick === "Done") break;
        if (!selected.includes(pick)) selected.push(pick);
      }
      answers[i] = { question: q.question, selected };
      continue;
    }
    const pick = await ctx.ui.select(`${q.header}: ${q.question}`, [...q.options.map((o) => o.label), "Type something."]);
    if (!pick) answers[i] = { question: q.question, selected: [], custom: formatError("user cancelled") };
    else if (pick === "Type something.") answers[i] = { question: q.question, selected: [], custom: await ctx.ui.input(q.question) ?? "" };
    else answers[i] = { question: q.question, selected: [pick] };
  }
  return answers;
}

export function createPiInteractiveDeps(ctx: ExtensionContext): InteractiveDeps {
  return Object.freeze({
    onAskUserQuestion: (questions: readonly AskQuestion[]): Promise<AskAnswer[]> => askViaUi(ctx, questions),
  });
}

export interface InteractiveBridgeOpts {
  readonly onAskUserQuestion?: (questions: readonly AskQuestion[]) => Promise<AskAnswer[]>;
  readonly emitter?: RlmEmitter;
  readonly depth: number;
  readonly parentId?: string;
}

export function buildInteractiveHandlers(opts: InteractiveBridgeOpts): {
  askUserQuestion: SubLlmHandlers["askUserQuestion"];
} {
  return {
    async askUserQuestion(questions, depth) {
      if (depth > 0) return questions.map((q) => ({
        question: q.question,
        selected: [],
        custom: formatError("ask_user_question not available inside rlm_query sub-calls"),
      }));

      const id = opts.emitter?.emitSubcallCreated({
        kind: "tool", parentId: opts.parentId,
        label: "ask_user_question",
        args: `${questions.length} question(s)`,
        depth,
      });
      try {
        const cb = opts.onAskUserQuestion;
        if (!cb) throw new Error("ask_user_question not configured (no onAskUserQuestion callback)");
        const answers = await cb(questions);
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "done" });
        return answers;
      } catch (err) {
        if (id) opts.emitter?.emitSubcallUpdated({ id, status: "error", detail: String(err) });
        throw err;
      }
    },
  };
}
