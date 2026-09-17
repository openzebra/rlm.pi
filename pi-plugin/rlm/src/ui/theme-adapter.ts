/**
 * Theme adapters bound to an *injected* Theme instance.
 *
 * Pi's own `getMarkdownTheme()` closes over a module-global `theme` singleton. Extensions are
 * loaded through jiti, which gives them a separate module cache, so that global can be
 * `undefined` inside a plugin — pi documents this footgun on `DynamicBorder`. Every renderer
 * pi calls hands us a live `Theme`, so we build the adapter from that instead of the global.
 *
 * Fork hosts (oh-my-pi) remap `@earendil-works/pi-tui` to their own bundled copy, whose
 * `Markdown` requires a nested `symbols` record on the theme (`theme.symbols.table/hrChar/
 * quoteBorder/colorSwatch`) in addition to the upstream render functions. Their `Theme.md`
 * getter is NOT a MarkdownTheme — it is a flat symbol-string partial
 * (`{ quoteBorder, hrChar, bullet, colorSwatch }`), so returning it raw amputates the render
 * functions and the host crashes (`this.#r.heading is not a function`). Hence the merge
 * below: base functions from the injected theme, function-valued host overrides on top,
 * and the flat strings folded into a complete `symbols` record with safe defaults.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/** The `symbols` record fork hosts read off a MarkdownTheme (upstream has no such key). */
interface MarkdownThemeSymbols {
  readonly colorSwatch: string;
  readonly hrChar: string;
  readonly quoteBorder: string;
  readonly bullet?: string;
  readonly table: Readonly<Record<string, string>>;
}

/** Safe defaults covering every symbol a fork's `Markdown` dereferences (omp: table/hrChar/quoteBorder/colorSwatch). */
const FALLBACK_SYMBOLS: MarkdownThemeSymbols = Object.freeze({
  colorSwatch: "●",
  hrChar: "─",
  quoteBorder: "▌",
  table: Object.freeze({
    horizontal: "─",
    vertical: "│",
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    teeUp: "┴",
    teeDown: "┬",
    teeLeft: "├",
    teeRight: "┤",
    cross: "┼",
  }),
});

type MarkdownThemeWithSymbols = MarkdownTheme & { symbols?: MarkdownThemeSymbols };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const asNonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Fold the host's symbol surface into one complete `symbols` record. Forks expose the same
 * chars in two shapes — nested (`theme.md.symbols.colorSwatch`) or flat
 * (`theme.md.colorSwatch`) — and the host's values win over our safe defaults. `host.md`
 * flat strings are also NOT spread over the base: `quoteBorder`/`hrChar` exist on the base
 * as FUNCTIONS, so a naive spread would corrupt them.
 */
function hostSymbols(md: Record<string, unknown>): MarkdownThemeSymbols {
  const nested = isRecord(md.symbols) ? md.symbols : {};
  const fallback = FALLBACK_SYMBOLS as unknown as Record<string, unknown>;
  const fallbackString = (k: string): string => (typeof fallback[k] === "string" ? fallback[k] : "");
  const pick = (k: string): string => asNonEmptyString(nested[k]) ?? asNonEmptyString(md[k]) ?? fallbackString(k);
  const hostTable = isRecord(nested.table) ? nested.table : {};
  const table: Record<string, string> = { ...FALLBACK_SYMBOLS.table };
  for (const k of Object.keys(table)) {
    const v = asNonEmptyString(hostTable[k]);
    if (v !== undefined) table[k] = v;
  }
  const bullet = asNonEmptyString(nested.bullet) ?? asNonEmptyString(md.bullet);
  return Object.freeze({ colorSwatch: pick("colorSwatch"), hrChar: pick("hrChar"), quoteBorder: pick("quoteBorder"), bullet, table: Object.freeze(table) });
}

/**
 * A `MarkdownTheme` derived from the theme pi passed to this render pass.
 *
 * `highlightCode`/`resolveMermaidAscii` come through only if the host itself provides them
 * as functions on `theme.md` — pi's own global-based implementation reads the broken
 * module global and is deliberately never reconstructed here.
 */
export function markdownTheme(theme: Theme): MarkdownTheme {
  const base: MarkdownTheme = {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
  };
  const md: unknown = (theme as Theme & { md?: unknown }).md;
  if (!isRecord(md)) {
    const bare: MarkdownThemeWithSymbols = { ...base, symbols: hostSymbols({}) };
    return bare;
  }
  // Function-valued host fields override the base (a real host MarkdownTheme wins);
  // flat symbol strings stay out of the function surface and fold into `symbols`.
  const hostFns: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) {
    if (typeof v === "function") hostFns[k] = v;
  }
  const merged = { ...base, ...hostFns } as MarkdownTheme & { symbols?: MarkdownThemeSymbols };
  merged.symbols = hostSymbols(md);
  return merged;
}
