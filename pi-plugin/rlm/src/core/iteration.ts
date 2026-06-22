/**
 * A single RLM turn for the headless engine: ask the root model, parse its ```repl``` blocks,
 * execute each in the sandbox, and return the results. (Native mode does this via pi's loop +
 * the rlm_repl tool instead.)
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, modelComplete } from "../bridge/model.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import type { PythonSandbox } from "../sandbox/sandbox.ts";
import { findReplBlocks } from "../text/parsing.ts";
import type { Sampling } from "./types.ts";

export interface Turn {
  response: string;
  results: ReplResult[];
  usage: Usage;
}

export interface TurnDeps {
  model: Model<Api>;
  registry: ModelRegistry;
  sampling?: Sampling;
  signal?: AbortSignal;
}

export async function runTurn(history: ChatMsg[], sandbox: PythonSandbox, deps: TurnDeps): Promise<Turn> {
  const { text, usage } = await modelComplete(history, {
    model: deps.model,
    registry: deps.registry,
    maxTokens: deps.sampling?.maxTokens,
    temperature: deps.sampling?.temperature,
    reasoning: deps.sampling?.reasoning,
    signal: deps.signal,
  });

  const blocks = findReplBlocks(text);
  const results: ReplResult[] = [];
  for (const code of blocks) {
    results.push(await sandbox.exec(code));
  }
  return { response: text, results, usage };
}
