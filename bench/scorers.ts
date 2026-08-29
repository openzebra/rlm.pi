/**
 * Paper-suite scorers — faithful ports from the rlm_test lab
 * (oolong.py `score_oolong_answer`, browsecomp.py `score_browsecomp`,
 * longbench_codeqa.py `extract_mc_letter`). Deterministic heuristics, no LLM judge.
 */

// ---------------------------------------------------------------- oolong ----

/** Light `ast.literal_eval` stand-in for gold values like "['spam']" or "42". */
function parsePyLiteral(s: string): unknown {
  const t = s.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    if (t.startsWith("[") && t.endsWith("]")) {
      const inner = t.slice(1, -1);
      if (inner.trim() === "") return [];
      return inner.split(",").map((part) => part.trim().replace(/^['"]|['"]$/g, ""));
    }
    return s;
  }
}

function normalizeLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^label:\s*/, "")
    .trim()
    .replace(/^['"[\]]+|['"[\]]+$/g, "");
}

export function scoreOolong(pred: string, gold: unknown, answerType: string): number {
  if (!pred) return 0;
  const p = pred.trim();
  const goldV = typeof gold === "string" ? parsePyLiteral(gold) : gold;

  const at = (answerType || "").toUpperCase();
  const goldLooksFreq =
    Array.isArray(goldV) && goldV.length > 0 && String(goldV[0]).toUpperCase().includes("MOST_FREQ");

  if (at.includes("LABEL") || String(goldV).toUpperCase().includes("MOST_FREQ") || goldLooksFreq) {
    const raw = Array.isArray(goldV) && goldV.length > 0 ? String(goldV[0]) : String(goldV);
    const g = normalizeLabel(raw);
    const pl = normalizeLabel(p);
    if (g && (pl.includes(g) || pl === g)) return 1.0;
    const words = pl.match(/[a-z0-9_]+/g) ?? [];
    if (words.length > 0 && words[words.length - 1] === g) return 1.0;
    return 0.0;
  }

  // numeric gold (possibly a 1-element list)
  let goldNum: number | null = null;
  if (Array.isArray(goldV) && goldV.length === 1 && typeof goldV[0] === "number") {
    goldNum = goldV[0];
  } else if (typeof goldV === "number") {
    goldNum = goldV;
  } else if (Array.isArray(goldV) && goldV.length === 1) {
    const parsed = Number(String(goldV[0]).replace(/,/g, ""));
    goldNum = Number.isFinite(parsed) ? parsed : null;
  }

  if (goldNum !== null || at.includes("NUM")) {
    const nums = p.replace(/,/g, "").match(/-?\d+\.?\d*/g) ?? [];
    if (nums.length === 0 || goldNum === null) return 0.0;
    for (const n of nums) {
      if (Math.abs(Number.parseFloat(n) - goldNum) < 1e-6) return 1.0;
    }
    return 0.0;
  }

  // fallback: gold string / list of strings — all parts should appear
  if (Array.isArray(goldV)) {
    const parts = goldV.map((x) => String(x).trim().toLowerCase()).filter((x) => x.length > 0);
    if (parts.length === 0) return 0.0;
    const pl = p.toLowerCase();
    return parts.every((part) => pl.includes(part)) ? 1.0 : 0.0;
  }

  const g = String(goldV).trim().toLowerCase();
  return g && p.toLowerCase().includes(g) ? 1.0 : 0.0;
}

// ------------------------------------------------------------ browsecomp ----

export function scoreBrowsecomp(pred: string, gold: string): number {
  if (!pred || !gold) return 0.0;
  const p = pred.trim().toLowerCase();
  const g = gold.trim().toLowerCase();
  if (g === p || p.includes(g)) return 1.0;
  const tokens = (s: string): readonly string[] => s.match(/[a-z0-9]+/g) ?? [];
  const gt = new Set<string>(tokens(g));
  const pt = new Set<string>(tokens(p));
  if (gt.size === 0) return 0.0;
  let hits = 0;
  for (const t of gt) if (pt.has(t)) hits++;
  return hits / gt.size;
}

// ------------------------------------------------------------ codeqa_lb ----

export function extractMcLetter(text: string): string {
  if (!text) return "";
  const t = text.trim().toUpperCase();
  const m = /\b([ABCD])\b/.exec(t);
  if (m) return m[1];
  if (t.length > 0 && "ABCD".includes(t[0])) return t[0];
  return "";
}
