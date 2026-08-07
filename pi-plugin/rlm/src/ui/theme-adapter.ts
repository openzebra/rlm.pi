/**
 * Theme adapters bound to an *injected* Theme instance.
 *
 * Pi's own `getMarkdownTheme()` closes over a module-global `theme` singleton. Extensions are
 * loaded through jiti, which gives them a separate module cache, so that global can be
 * `undefined` inside a plugin — pi documents this footgun on `DynamicBorder`. Every renderer
 * pi calls hands us a live `Theme`, so we build the adapter from that instead of the global.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * A `MarkdownTheme` derived from the theme pi passed to this render pass.
 *
 * `highlightCode` is deliberately omitted: pi's implementation also reads the module global,
 * and it is optional on `MarkdownTheme` — code blocks render uncoloured rather than crashing.
 */
export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
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
}
