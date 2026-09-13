/**
 * python-highlight — minimal Python syntax coloring for the repl card's code payload.
 *
 * Deliberately NOT pi's highlightCode(): that closes over the module-global theme,
 * which is unreliable inside a jiti-loaded plugin (see ui/theme-adapter.ts). The
 * grammar here is a small, honest subset — comments, strings (triple-quoted and
 * prefixed), keywords, numbers, decorators — enough to read a cell at a glance.
 * Colors come from the theme pi hands each render pass.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Master pattern; alternation order is priority — a `#` comment consumes to end-of-line
 * before strings can match, leftmost match wins everywhere else. Group indices:
 * 1 comment, 2 triple-quoted string, 3 single-line string (optional prefix), 4 decorator,
 * 5 number, 6 keyword. Module-level snapshot: a regex is immutable state, not session state.
 */
const TOKEN_RE = new RegExp(
  [
    "(#[^\\n]*)",                                                                                       // 1
    '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')',                                                        // 2
    '([fFrRbBuU]{0,2}"(?:\\\\.|[^"\\\\\\n])*"|[fFrRbBuU]{0,2}\'(?:\\\\.|[^\'\\\\\\n])*\')',             // 3
    "(@[A-Za-z_][\\w.]*)",                                                                              // 4
    "\\b(\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?j?)\\b",                                               // 5
    "\\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|" +
      "finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b", // 6
  ].join("|"),
  "g",
);

/** The whole code colored in one pass; spans never overlap, text content is preserved byte-for-byte. */
export function highlightPython(code: string, theme: Theme): string {
  const out: string[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    const [raw = "", comment, triple, str, decorator, num, keyword] = m;
    if (comment !== undefined) out.push(theme.fg("muted", comment));
    else if (triple !== undefined || str !== undefined) out.push(theme.fg("mdCode", raw));
    else if (decorator !== undefined) out.push(theme.fg("mdHeading", decorator));
    else if (num !== undefined) out.push(theme.fg("warning", num));
    else out.push(theme.fg("accent", keyword));
    last = at + raw.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out.join("");
}
