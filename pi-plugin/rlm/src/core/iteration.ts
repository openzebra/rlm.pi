/**
 * A single RLM turn for the headless engine: ask the root model, parse its ```repl``` blocks,
 * execute each in the sandbox, and return the results. (The engine drives this; pi's loop is
 * not involved.)
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ChatMsg, type CompleteOptions, type CompleteResult, modelComplete } from "../bridge/model.ts";
import type { ReplResult } from "../sandbox/protocol.ts";
import type { PythonSandbox } from "../sandbox/sandbox.ts";
import { findReplBlocks } from "../text/parsing.ts";
import type { Sampling } from "./types.ts";

export interface Turn {
  readonly response: string;
  readonly results: readonly ReplResult[];
  readonly usage: Usage;
  readonly blocks: readonly string[];
  /** Blocks not executed because an earlier block raised. */
  readonly skippedBlocks: number;
}

export type CompleteFn = (messages: readonly ChatMsg[], opts: CompleteOptions) => Promise<CompleteResult>;

export interface TurnDeps {
  readonly model: Model<Api>;
  readonly registry: ModelRegistry;
  readonly sampling?: Sampling;
  readonly signal?: AbortSignal;
  /** Test-only override for model completion (scripted responses). */
  readonly complete?: CompleteFn;
}

export async function runTurn(history: readonly ChatMsg[], sandbox: PythonSandbox, deps: TurnDeps): Promise<Turn> {
  const complete = deps.complete ?? modelComplete;
  const { text, usage } = await complete(history, {
    model: deps.model,
    registry: deps.registry,
    maxTokens: deps.sampling?.maxTokens,
    temperature: deps.sampling?.temperature,
    reasoning: deps.sampling?.reasoning,
    signal: deps.signal,
  });

  const blocks = findReplBlocks(text);
  const results = new Array<ReplResult>(blocks.length);
  let executed = 0;
  for (let i = 0; i < blocks.length; i++) {
    results[i] = await sandbox.exec(blocks[i]);
    executed = i + 1;
    if (results[i].raised) break;
  }
  results.length = executed;
  return { response: text, results, usage, blocks, skippedBlocks: blocks.length - executed };
}
