/** Shared helpers for Pi tool implementations. */

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { err, ok, type Result } from "../util/errors.ts";

interface TextToolResponse<Details> {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: Details;
}

export function validateToolParams<Schema extends TSchema, Details>(
  schema: Schema,
  rawParams: unknown,
  toolName: string,
  createErrorDetails: (errors: string) => Details,
): Result<Static<Schema>, TextToolResponse<Details>> {
  if (Value.Check(schema, rawParams)) return ok(rawParams);
  const errors = [...Value.Errors(schema, rawParams)]
    .map((error) => `${error.instancePath}: ${error.message}`)
    .join("; ");
  return err({
    content: [{ type: "text", text: `Invalid ${toolName} parameters: ${errors}` }],
    details: createErrorDetails(errors),
  });
}

type TextUpdateCallback<Details> = (update: TextToolResponse<Details>) => void;

interface ProgressNotifierOptions<Details> {
  readonly onUpdate?: TextUpdateCallback<Details>;
  readonly getDetails: () => Details;
  readonly isRunning: (details: Details) => boolean;
  readonly renderText: (details: Details) => string;
  readonly intervalMs?: number;
}

interface ProgressNotifier {
  readonly notify: () => void;
  readonly start: () => void;
  readonly stop: () => void;
}

export function createProgressNotifier<Details>(opts: ProgressNotifierOptions<Details>): ProgressNotifier {
  let handle: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (handle === undefined) return;
    clearInterval(handle);
    handle = undefined;
  };

  const notify = (): void => {
    if (!opts.onUpdate) return;
    const details = opts.getDetails();
    opts.onUpdate({ content: [{ type: "text", text: opts.renderText(details) }], details });
  };

  const start = (): void => {
    if (!opts.onUpdate || handle !== undefined) return;
    notify();
    handle = setInterval(() => {
      const details = opts.getDetails();
      if (!opts.isRunning(details)) {
        stop();
        return;
      }
      opts.onUpdate?.({ content: [{ type: "text", text: opts.renderText(details) }], details });
    }, opts.intervalMs ?? 100);
  };

  return Object.freeze({ notify, start, stop });
}
