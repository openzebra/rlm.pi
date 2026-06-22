#!/usr/bin/env bun
import { decideRlmInputRoute, shouldRouteRlmInput } from "../src/mode/input-router.ts";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`✗ ${name}${detail ? `  — ${detail}` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${name}${detail ? `  — ${detail}` : ""}`);
}

assert(
  "input router routes enabled interactive non-slash",
  decideRlmInputRoute({ source: "interactive", text: "explain this" }, { enabled: true, busy: false }) === "route",
  "handled",
);
assert(
  "input router continues when disabled",
  decideRlmInputRoute({ source: "interactive", text: "explain this" }, { enabled: false, busy: false }) === "continue",
  "continue",
);
assert(
  "input router continues slash commands",
  decideRlmInputRoute({ source: "interactive", text: "  /rlm" }, { enabled: true, busy: false }) === "continue",
  "continue",
);
assert(
  "input router continues non-interactive sources",
  decideRlmInputRoute({ source: "rpc", text: "explain this" }, { enabled: true, busy: false }) === "continue",
  "continue",
);
assert(
  "input router handles busy interactive prompts",
  decideRlmInputRoute({ source: "interactive", text: "explain this" }, { enabled: true, busy: true }) === "busy",
  "handled busy",
);
assert(
  "shouldRoute only true for runnable route",
  !shouldRouteRlmInput({ source: "interactive", text: "explain this" }, { enabled: true, busy: true }),
  "busy is handled separately",
);

if (!process.exitCode) console.log("\nALL PASS");
