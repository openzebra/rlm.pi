/**
 * tui-compat — runtime seams for host-flavored TUI exports.
 *
 * `DynamicBorder` is exported by the vendored pi host bundle (`@earendil-works/pi-coding-agent`),
 * but NOT by omp's coding-agent barrel; under omp the `@earendil-works/*` specifiers remap to
 * canonical `@oh-my-pi/*` and the component lives in the tui package. Static namespace imports
 * keep the real module graph intact, and the structural guard degrades to `undefined` instead
 * of crashing when the export is missing. Callers render the container without a border frame
 * (deterministic degrade, no crash).
 */

import * as piCodingAgentNs from "@earendil-works/pi-coding-agent";
import * as piTuiNs from "@earendil-works/pi-tui";

/** Structural mirror of the host's DynamicBorder (pi-coding-agent dynamic-border.d.ts). */
export interface DynamicBorderLike {
  new (color?: (str: string) => string): {
    invalidate(): void;
    render(width: number): string[];
  };
}

function isDynamicBorderCtor(v: unknown): v is DynamicBorderLike {
  return typeof v === "function";
}

/** Resolve the host's DynamicBorder; `undefined` = render without a border frame. */
export function resolveDynamicBorder(): DynamicBorderLike | undefined {
  if (isDynamicBorderCtor(piCodingAgentNs.DynamicBorder)) return piCodingAgentNs.DynamicBorder;
  // pi-tui's vendored typings do not name DynamicBorder; probe the runtime namespace.
  const tuiNs = piTuiNs as unknown as Record<string, unknown>;
  if (isDynamicBorderCtor(tuiNs.DynamicBorder)) return tuiNs.DynamicBorder;
  return undefined;
}
