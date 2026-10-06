/**
 * phase-sigma-fold — ```state fence transcript fold + display-layer locale:
 * foldStateFences (quote-block replacement, plain fallback), sigmaFenceDigest
 * (section labels, dotted keys, clip/tail caps, broken-JSON fallback, rejects),
 * and the setDisplayLocale / resolveSigmaLocale precedence ladder.
 * Pure — no sandbox, no TUI.
 */

import { check, failureCount } from "./helpers.ts";
// Display-layer assertions pin English regardless of host LANG — the string tables under
// test are resolved per render from the locale detector.
import {
  SIGMA_DIGEST_ITEM_CAP,
  SIGMA_DIGEST_MAX_ITEMS,
  resolveSigmaLocale,
  setDisplayLocale,
  sigmaFenceDigest,
} from "../src/prompts/glossary.ts";
import { findStatePatches, foldStateFences } from "../src/text/parsing.ts";
setDisplayLocale("en");

/** Wrap a JSON payload in a ```state fence the way the model emits it. */
const fenced = (json: string): string => "```state\n" + json + "\n```";

// ── resolveSigmaLocale: explicit arg > session override; default English ──
{
  setDisplayLocale("en");
  check("locale: explicit arg beats session override", resolveSigmaLocale("zh") === "zh");
  check("locale: default session state is English", resolveSigmaLocale() === "en");
  setDisplayLocale("zh");
  check("locale: session override localizes", resolveSigmaLocale() === "zh");
  setDisplayLocale("en"); // restore the pinned locale for the sections below
}

// ── sigmaFenceDigest: content digest from a real user-shaped patch ──
{
  const msg = fenced(
    '{"state_patch": {"verifiedFacts[+]": ["specrune-go/ — S1 done, go build OK", "mygo.View→ui.View — import fixed"], "artifacts":{"/tmp/specrune-go":"runnable, window live"}}}',
  );
  const d = sigmaFenceDigest(findStatePatches(msg), 3, 0);
  check("digest: en header present", d.startsWith("**Σ recorded:**"), d.slice(0, 30));
  check("digest: fact lines labeled", d.includes("- fact specrune-go/"), "");
  check("digest: artifact line uses backtick path", d.includes("- `/tmp/specrune-go` — runnable"), "");
  check("digest: no reject note when problems=0", !d.includes("rejected"), "");
  check("digest: no tail when items ≤ cap", !d.includes("more archived"), "");
}

// ── sigmaFenceDigest: dotted key + full section spread ──
{
  const msg = fenced(
    '{"state_patch": {"findings[+]": ["F1"], "verifiedFacts[+]": ["V1"], "testedApproaches.h1": {"status":"failed","reason":"grep too narrow"}, "openQuestions[+]": "panel-demo race?", "artifacts":{"/p":"v"}}}',
  );
  const d = sigmaFenceDigest(findStatePatches(msg), 5, 0);
  check("digest: dotted approach rendered as one entry", d.includes("- approach h1: failed — grep too narrow"), "");
  check("digest: question label", d.includes("- question panel-demo race?"), "");
  check("digest: finding label", d.includes("- finding F1"), "");
}

// ── sigmaFenceDigest: tail + clip caps ──
{
  const facts = Array.from({ length: SIGMA_DIGEST_MAX_ITEMS + 2 }, (_, i) => `fact-${i}`);
  const msg = fenced(`{"state_patch": {"verifiedFacts[+]": ${JSON.stringify(facts)}}}`);
  const lines = sigmaFenceDigest(findStatePatches(msg), facts.length, 0).split("\n");
  check("digest: caps at SIGMA_DIGEST_MAX_ITEMS items", lines.length - 1 <= SIGMA_DIGEST_MAX_ITEMS + 1, `lines=${lines.length}`);
  check("digest: tail counts the remainder", lines.at(-1)?.includes("more archived") === true, lines.at(-1) ?? "");

  const long = "x".repeat(SIGMA_DIGEST_ITEM_CAP + 50);
  const d2 = sigmaFenceDigest(findStatePatches(fenced(`{"state_patch": {"verifiedFacts[+]": ["${long}"]}}`)), 1, 0);
  const body = d2.split("\n").find((l) => l.startsWith("- ")) ?? "";
  check("digest: items clipped at SIGMA_DIGEST_ITEM_CAP + ellipsis", body.length <= "- fact ".length + SIGMA_DIGEST_ITEM_CAP + 1 && body.endsWith("…"), `len=${body.length}`);
}

// ── sigmaFenceDigest: broken JSON / non-patch payloads fall back to plain ──
{
  const broken = sigmaFenceDigest(findStatePatches(fenced("{broken")), 3, 0);
  check("digest: broken JSON → plain fold form", broken.includes("Σ commit — folded") && !broken.includes("recorded"), "");

  const noPatch = sigmaFenceDigest([{ ok: true, value: { other: 1 } }], 1, 0);
  check("digest: payload without state_patch → plain fold form", noPatch.includes("Σ commit — folded"), "");

  const rejected = sigmaFenceDigest(findStatePatches(fenced("{broken")), 3, 1);
  check("digest: rejects surface in fallback suffix", rejected.includes("3 accepted") && rejected.includes("1 rejected"), rejected);

  const okWithReject = sigmaFenceDigest(findStatePatches(fenced('{"state_patch": {"verifiedFacts[+]": ["v1"]}}')), 1, 1);
  check("digest: rejects surface alongside item lines", okWithReject.includes("1 rejected"), "");
}

// ── sigmaFenceDigest: zh table + override precedence ──
{
  const msg = fenced('{"state_patch": {"verifiedFacts[+]": ["事实一"]}}');
  // explicit override beats the pinned en session locale
  check("digest: override zh wins over session en", sigmaFenceDigest(findStatePatches(msg), 1, 0, "zh").startsWith("**Σ 已记录：**"), "");
  // session switch re-localizes without restart
  setDisplayLocale("zh");
  check("digest: session zh localizes", sigmaFenceDigest(findStatePatches(msg), 1, 0).includes("- 事实 事实一"), "");
  setDisplayLocale("en"); // restore
  check("digest: restored en", sigmaFenceDigest(findStatePatches(msg), 1, 0).startsWith("**Σ recorded:**"), "");
}

// ── foldStateFences: quote-block replacement, surrounding prose intact ──
{
  const msg = `做完了。\n\n${fenced('{"state_patch": {"verifiedFacts[+]": ["f1"]}}')}\n\n继续 S2。`;
  const folded = foldStateFences(msg, "**Σ recorded:**\n- fact f1");
  check("fold: prose before preserved", folded.startsWith("做完了。\n\n"), "");
  check("fold: prose after preserved", folded.endsWith("\n\n继续 S2。"), "");
  check("fold: fence body replaced by digest", !folded.includes("state_patch") && folded.includes("> **Σ recorded:**"), "");
  check("fold: every digest line quote-prefixed", folded.split("\n").filter((l) => l.length > 0 && !l.startsWith("> ")).every((l) => !l.includes("Σ")), "");
}

// ── foldStateFences: plain-form injection + multi-fence + no-fence passthrough ──
{
  const plain = foldStateFences(fenced('{"state_patch": {}}'), "*Σ commit — folded, data flows unchanged*");
  check("fold: plain form passed through as the fold text", plain.includes("> *Σ commit — folded, data flows unchanged*"), "");

  const multi = `a\n${fenced('{"state_patch": {"verifiedFacts[+]": ["1"]}}')}\nb\n${fenced('{"state_patch": {"verifiedFacts[+]": ["2"]}}')}\nc`;
  const foldedMulti = foldStateFences(multi, "**Σ recorded:**\n- fact 1");
  check("fold: both fences collapse", !foldedMulti.includes("state_patch") && foldedMulti.includes("a\n") && foldedMulti.includes("\nb\n") && foldedMulti.includes("\nc"), "");
  check("fold: multi-line fold prefixes every line", foldStateFences(fenced("{}"), "l1\n\nl2").split("\n")[1] === ">", "");

  const noFence = "just prose, nothing to fold";
  check("fold: no fence → text unchanged", foldStateFences(noFence, "x") === noFence, "");
  const blankFold = foldStateFences(fenced('{"state_patch": {}}'), "   ");
  check("fold: blank fold → whole text unchanged, fence kept raw", blankFold.includes("```state") && blankFold.includes("state_patch"), "");
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
