import { err, errorMessage, ok, type Result } from "../util/errors.ts";

export type PiToolCallError =
  | { readonly kind: "tool-invoke-unavailable"; readonly message: string }
  | { readonly kind: "tool-invoke-failed"; readonly message: string };

type PiToolCall = (name: string, params: unknown) => unknown | Promise<unknown>;

interface PiToolInvokerHost {
  readonly callTool: PiToolCall;
}

function hasCallTool(value: unknown): value is PiToolInvokerHost {
  return typeof value === "object"
    && value !== null
    && typeof (value as { readonly callTool?: unknown }).callTool === "function";
}

export async function callPiTool(
  ctx: unknown,
  name: string,
  params: unknown,
): Promise<Result<unknown, PiToolCallError>> {
  if (!hasCallTool(ctx)) {
    return err({
      kind: "tool-invoke-unavailable",
      message: "Pi native tool invocation is unavailable in this context",
    });
  }

  try {
    const result = await ctx.callTool.call(ctx, name, params);
    return ok(result);
  } catch (e) {
    return err({
      kind: "tool-invoke-failed",
      message: errorMessage(e),
    });
  }
}
