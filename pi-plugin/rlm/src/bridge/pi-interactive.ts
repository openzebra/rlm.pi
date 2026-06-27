import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InteractiveDeps } from "../core/types.ts";
import type { AskAnswer, AskQuestion } from "../sandbox/protocol.ts";
import { formatError } from "../util/errors.ts";
import { createTodoFallback } from "./fallback-todo.ts";

interface ToolInvoker {
  readonly callTool?: (name: string, params: unknown) => Promise<unknown>;
}

function hasAnswers(value: unknown): value is { readonly answers: readonly unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { readonly answers?: unknown }).answers);
}

function isAskAnswer(value: unknown): value is AskAnswer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly question?: unknown; readonly selected?: unknown; readonly custom?: unknown };
  return typeof candidate.question === "string"
    && Array.isArray(candidate.selected)
    && candidate.selected.every((item) => typeof item === "string")
    && (candidate.custom === undefined || typeof candidate.custom === "string");
}

function normalizeAnswers(result: unknown): AskAnswer[] | undefined {
  if (!hasAnswers(result)) return undefined;
  const answers = result.answers;
  return answers.every(isAskAnswer) ? Array.from(answers) : undefined;
}

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
  const fallbackTodo = createTodoFallback();
  return Object.freeze({
    onAskUserQuestion: async (questions: readonly AskQuestion[]): Promise<AskAnswer[]> => {
      const callTool = (ctx as unknown as ToolInvoker).callTool;
      if (typeof callTool === "function") {
        try {
          const result = await callTool.call(ctx, "ask_user_question", { questions });
          const answers = normalizeAnswers(result);
          if (answers) return answers;
        } catch {
          // Fall through to native UI fallback when the extension tool is not registered or fails.
        }
      }
      return askViaUi(ctx, questions);
    },
    onTodo: async (action: string, params: Record<string, unknown>): Promise<string> => {
      const callTool = (ctx as unknown as ToolInvoker).callTool;
      if (typeof callTool === "function") {
        try {
          const result = await callTool.call(ctx, "todo", { action, ...params });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch {
          // Fall through to in-process task store when the extension tool is not registered or fails.
        }
      }
      return fallbackTodo(action, params);
    },
  });
}
