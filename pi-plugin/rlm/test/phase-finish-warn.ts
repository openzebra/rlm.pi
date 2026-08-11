/**
 * finish soft-policy: warning when tasks still pending.
 * Run: bun run pi-plugin/rlm/test/phase-finish-warn.ts
 */

import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { MOCK_REGISTRY } from "./helpers.ts";
import { check, failureCount } from "./helpers.ts";
import {
  createSubcallHandlers,
  createTaskRegistry,
  limitsFromRemaining,
} from "../src/bridge/handlers/index.ts";
import { createSubcallGates } from "../src/util/concurrency.ts";
import { RlmEmitter } from "../src/tool/rlm-events.ts";
import type { SubcallOpts } from "../src/sandbox/interrupts.ts";

const ATTACHED: SubcallOpts = Object.freeze({ detached: false });
const emitter = new RlmEmitter();
const registry = createTaskRegistry();

const handlers = createSubcallHandlers(
  {
    resolve: (_o, depth) => ({
      emitter,
      parentId: undefined,
      depth,
      limits: limitsFromRemaining(),
    }),
    gates: createSubcallGates(2),
    registry: MOCK_REGISTRY,
    getLlmModel: () => {
      throw new Error("should not complete");
    },
    getConfig: () => ({ maxPromptChars: 10_000, maxDepth: 1 }),
  },
  registry,
);

// Manually register a pending task without resolving it
const pending = registry.spawnDeps.register("llm", 1, "task_pending_1");
check("spawn registered", pending.task_id === "task_pending_1");
check("unawaited lists id", registry.awaitDeps.unawaitedIds().includes("task_pending_1"));

const fin = await handlers.finishTask("done", 0, ATTACHED);
check("finish ok", fin.ok === true && fin.finished === true);
check(
  "finish warns on pending",
  typeof (fin as { warning?: string }).warning === "string"
    && String((fin as { warning?: string }).warning).includes("task_pending_1"),
  String((fin as { warning?: string }).warning),
);

const failed = failureCount();
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
