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
import { SIGMA_DIGEST_ITEM_CAP, SIGMA_DIGEST_MAX_ITEMS, resolveSigmaLocale, setDisplayLocale, sigmaFenceDigest } from "../src/ui/sigma-i18n.ts";
import { findStatePatches, foldStateFences } from "../src/text/parsing.ts";
import { createFoldRegistry } from "../src/ui/sigma-fold.ts";
import { applySetting } from "../src/ui/config-panel.ts";
import { mergeConfig, validateConfig } from "../src/config/settings.ts";
import { detectSigmaLocale, sigmaStrings } from "../src/ui/sigma-i18n.ts";
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
  check("fold: multi-fence → digest appears ONCE", foldedMulti.split("**Σ recorded:**").length === 2, "");
  check("fold: multi-line fold prefixes every line", foldStateFences(fenced("{}"), "l1\n\nl2").split("\n")[1] === ">", "");

  const noFence = "just prose, nothing to fold";
  check("fold: no fence → text unchanged", foldStateFences(noFence, "x") === noFence, "");
  const blankFold = foldStateFences(fenced('{"state_patch": {}}'), "   ");
  check("fold: blank fold → whole text unchanged, fence kept raw", blankFold.includes("```state") && blankFold.includes("state_patch"), "");
}

// ── fold: model text with `$` replacement patterns stays verbatim ──
{
  const fact = "echo $& and $' and $1 and $`";
  const d = sigmaFenceDigest(findStatePatches(fenced(JSON.stringify({ state_patch: { "verifiedFacts[+]": [fact] } }))), 1, 0);
  const folded = foldStateFences(`x\n${fenced("{}")}\ny`, d);
  check("fold: $-patterns not expanded", folded.includes(fact), folded);
}

// ── digest: newlines in model text cannot break the list line ──
{
  const d = sigmaFenceDigest(findStatePatches(fenced(JSON.stringify({ state_patch: { "verifiedFacts[+]": ["a\n\n- fake item\nb"] } }))), 1, 0);
  check("digest: whitespace collapsed to one line", d.split("\n").length === 2 && d.includes("- fact a - fake item b"), d);
}

// ── locale tables: identical key sets, config wiring ──
{
  const keysOf = (o: object): string => Object.keys(o).sort().join(",");
  const en = sigmaStrings("en");
  const zh = sigmaStrings("zh");
  const ru = sigmaStrings("ru");
  check("i18n: panel labels key parity", keysOf(en.panel.labels) === keysOf(zh.panel.labels), "");
  check("i18n: descriptions key parity", keysOf(en.descriptions) === keysOf(zh.descriptions), "");
  check("i18n: labels/descriptions cover same ids", keysOf(en.panel.labels) === keysOf(en.descriptions), "");
  check("i18n: notify key parity", keysOf(en.notify) === keysOf(zh.notify), "");
  check("i18n: picker key parity", keysOf(en.picker) === keysOf(zh.picker), "");
  check("i18n: sections key parity", keysOf(en.sections) === keysOf(zh.sections), "");
  check("i18n: ru key parity (labels/desc/notify/picker/sections/cards/status)",
    keysOf(en.panel.labels) === keysOf(ru.panel.labels) && keysOf(en.descriptions) === keysOf(ru.descriptions) &&
    keysOf(en.notify) === keysOf(ru.notify) && keysOf(en.picker) === keysOf(ru.picker) &&
    keysOf(en.sections) === keysOf(ru.sections) && keysOf(en.cards) === keysOf(ru.cards) && keysOf(en.status) === keysOf(ru.status), "");
  const ph = (t: string): string => (t.match(/\{\w+\}/g) ?? []).sort().join(",");
  check("i18n: ru placeholders match en", [["tail", en.tail, ru.tail], ["plainSuffix", en.plainSuffix, ru.plainSuffix], ["card digest", en.cards.digest, ru.cards.digest], ["degrade", en.cards.degrade, ru.cards.degrade], ["recover", en.cards.recover, ru.cards.recover], ["distill", en.cards.distill, ru.cards.distill], ["pinnedRlm", en.notify.pinnedRlm, ru.notify.pinnedRlm], ["modelsCount", en.picker.modelsCount, ru.picker.modelsCount], ["useLevelFor", en.picker.useLevelFor, ru.picker.useLevelFor], ["backToModels", en.picker.backToModels, ru.picker.backToModels], ["guide", en.intro.guide, ru.intro.guide]].every(([, a, b]) => ph(a ?? "") === ph(b ?? "")), "");

  const base = mergeConfig({});
  const zhCfg = applySetting(base, "displayLocale", "zh");
  check("config: applySetting zh sets config + live locale", zhCfg.displayLocale === "zh" && resolveSigmaLocale() === "zh", "");
  check("config: applySetting rejects junk", applySetting(zhCfg, "displayLocale", "fr") === zhCfg, "");
  setDisplayLocale("en");
  check("config: validateConfig accepts zh", validateConfig({ displayLocale: "zh" }).displayLocale === "zh", "");
  check("config: validateConfig accepts auto + ru", validateConfig({ displayLocale: "auto" }).displayLocale === "auto" && validateConfig({ displayLocale: "ru" }).displayLocale === "ru", "");
  check("config: validateConfig drops junk", validateConfig({ displayLocale: "fr" }).displayLocale === undefined, "");
  check("config: default is auto", base.displayLocale === "auto", "");
  applySetting(base, "displayLocale", "ru");
  check("config: applySetting ru sets live locale", resolveSigmaLocale() === "ru", "");
  setDisplayLocale("en");
}

// ── bare (unfenced) state_patch blobs fold too; ```json quotations stay ──
{
  const bare = 'done.state {"state_patch": {"verifiedFacts[+]": ["b1"]}} ok';
  const f = foldStateFences(bare, "**Σ recorded:**\n- fact b1");
  check("fold: bare blob replaced", !f.includes("state_patch") && f.includes("> **Σ recorded:**") && f.endsWith(" ok"), f);
  const quote = "example:\n```json\n{\"state_patch\": {\"x\": 1}}\n```";
  check("fold: ```json quotation untouched", foldStateFences(quote, "d") === quote, "");
  const mixed = `${fenced('{"state_patch": {"verifiedFacts[+]": ["1"]}}')}\n{"state_patch": {"verifiedFacts[+]": ["2"]}}`;
  check("fold: fence + bare → digest once", foldStateFences(mixed, "D").split("> D").length === 2 && !foldStateFences(mixed, "D").includes("state_patch"), "");
}

// ── FoldRegistry: fold on screen, original restored on the wire clone ──
{
  const raw = "go\n" + fenced('{"state_patch": {"verifiedFacts[+]": ["f"]}}');
  const msg = { role: "assistant", timestamp: 42, content: [{ type: "text", text: raw }, { type: "toolCall", text: undefined as string | undefined }] };
  const reg = createFoldRegistry();
  reg.fold(msg, "**Σ recorded:**\n- fact f");
  const shown = msg.content[0]?.text ?? "";
  check("registry: message folded for display", shown.includes("> **Σ recorded:**") && !shown.includes("state_patch"), "");
  const clone = structuredClone([msg, { role: "assistant", timestamp: 7, content: [{ type: "text", text: "plain" }] }]);
  reg.restore(clone);
  const c0 = clone[0]?.content[0];
  check("registry: restore reinstates original fence text", c0?.type === "text" && c0.text === raw, "");
  check("registry: other messages untouched", clone[1]?.content[0]?.type === "text" && (clone[1].content[0] as { text: string }).text === "plain", "");
  const nonText = { role: "assistant", timestamp: 1, content: "oops" };
  reg.fold(nonText, "x"); reg.restore([nonText, { role: "user" }]);
  check("registry: malformed messages never throw", true, "");
}

// ── locale detection: PI_LANG > LC_ALL > LC_MESSAGES > LANG > Intl > en ──
{
  check("detect: ru_RU.UTF-8", detectSigmaLocale({ LANG: "ru_RU.UTF-8" }) === "ru", "");
  check("detect: zh-CN", detectSigmaLocale({ LANG: "zh_CN.UTF-8" }) === "zh", "");
  check("detect: unsupported → en", detectSigmaLocale({ LANG: "de_DE.UTF-8" }) === "en", "");
  check("detect: PI_LANG beats LANG", detectSigmaLocale({ PI_LANG: "zh", LANG: "ru_RU.UTF-8" }) === "zh", "");
  check("detect: LC_ALL beats LANG", detectSigmaLocale({ LC_ALL: "ru_RU", LANG: "en_US.UTF-8" }) === "ru", "");
  check("detect: C/POSIX skipped → next var", detectSigmaLocale({ LC_ALL: "C", LANG: "ru_RU.UTF-8" }) === "ru", "");
  check("detect: nothing set → Intl", detectSigmaLocale({}, "ru-RU") === "ru", "");
  check("detect: nothing at all → en", detectSigmaLocale({}) === "en", "");
  setDisplayLocale("ru");
  check("ru: digest header localized", sigmaFenceDigest(findStatePatches(fenced('{"state_patch": {"verifiedFacts[+]": ["х"]}}')), 1, 0).startsWith("**Σ записано:**"), "");
  setDisplayLocale("en");
  setDisplayLocale("auto");
  check("auto: resolves to a concrete locale", ["en", "zh", "ru"].includes(resolveSigmaLocale()), "");
  setDisplayLocale("en");
}

console.log(`\n${failureCount() === 0 ? "ALL PASS" : `${failureCount()} FAILURE(S)`}`);
process.exit(failureCount() === 0 ? 0 : 1);
