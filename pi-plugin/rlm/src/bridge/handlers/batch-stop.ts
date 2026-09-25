/**
 * Stop a batch from launching more siblings after an auth, credit, or rate-limit failure.
 * The note happens INSIDE the admission gate, before the slot is released, so a waiter
 * observes the stop before it starts its own call.
 */

import { isProviderStop } from "../../util/retry.ts";
import type { Semaphore } from "../../util/concurrency.ts";

export interface BatchStop {
  before(): string | undefined;
  /** Record `value` when it is a provider-stop error. Idempotent after the first. */
  note(value: string): void;
}

export function createBatchStop(): BatchStop {
  let stopped: string | undefined;
  return {
    before: () => stopped,
    note: (value: string): void => {
      if (stopped === undefined && isProviderStop(value)) stopped = value;
    },
  };
}

/**
 * Run `exec` in `gate`. If a sibling already stopped the batch, return that error
 * without calling `exec`. `note` runs before the slot is released.
 */
export async function runAdmitted(
  gate: Semaphore,
  stop: BatchStop | undefined,
  exec: () => Promise<string>,
): Promise<string> {
  return gate.run(async () => {
    const halted = stop?.before();
    if (halted !== undefined) return halted;
    const value = await exec();
    stop?.note(value);
    return value;
  });
}
