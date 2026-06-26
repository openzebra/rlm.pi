/** Shared configuration + runtime types for the RLM engine. */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AskAnswer, AskQuestion, ProposedDiffEdit, ProposedEdit } from "../sandbox/protocol.ts";

export interface Sampling {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
}

export interface FsLimits {
  maxReadBytes: number;
  maxOutputChars: number;
  maxFindFiles: number;
  maxManifestFiles: number;
  commandTimeoutMs: number;
  grepDefaultMaxMatches: number;
  grepMaxMatchesCeiling: number;
}

export type EditRequestApprovalMode = "ask";

export interface TelemetryConfig {
  /** Default: enabled iff a tracking URI resolves from config or MLFLOW_TRACKING_URI. */
  readonly enabled?: boolean;
  readonly trackingUri?: string;
  readonly experimentId?: string;
  /** Bearer token is env-only via MLFLOW_TRACKING_TOKEN; never persisted in rlm.json. */
  readonly maxQueueSize?: number;
}

import type { ReconstructResult } from "../state/resume.ts";

export interface RunLogConfig {
  /** Default: true — always-on, opt-out. */
  readonly enabled?: boolean;
  /** Default: ".rlm/runs". Directory under cwd for run artifacts. */
  readonly dir?: string;
  /** Default: true — whether to write sandbox.pkl snapshots. */
  readonly snapshot?: boolean;
  /** Default: 50 — prune oldest runs beyond this count on each new run. */
  readonly maxRuns?: number;
}

export interface RlmConfig {
  /** Persistent editor-routing mode; when enabled, plain interactive prompts use RLM. */
  enabled: boolean;
  /** Max recursion depth. depth >= maxDepth ⇒ rlm_query falls back to a plain llm_query. */
  maxDepth: number;
  /** Max turns before the engine must finalize. */
  maxIterations: number;
  /** Per-`repl`-block wall-clock timeout inside the worker (seconds). */
  execTimeoutS: number;
  /** Parent-side watchdog per sandbox request (ms). */
  requestTimeoutMs: number;
  /** Concurrency pool for *_batched sub-calls. */
  maxConcurrentSubcalls: number;
  /** Reject sub-LLM prompts larger than this many chars. */
  maxPromptChars: number;
  /** Max USD spend across the whole tree before the engine stops (undefined = no cap). */
  maxBudgetUsd?: number;
  /** Max wall-clock ms across the whole tree before the engine stops (undefined = no cap). */
  maxTimeoutMs?: number;
  /** Max total input+output tokens across the whole tree before the engine stops (undefined = no cap). */
  maxTokens?: number;
  /** Max consecutive error turns before the engine stops (undefined = no cap). */
  maxErrors?: number;
  /** Append the orchestrator addendum to the system prompt. */
  orchestrator: boolean;
  /** Summarize the trajectory when it grows past the threshold (keeps the root window small). */
  compaction: boolean;
  /** Compact when estimated history tokens reach this fraction of the model's context window. */
  compactionThresholdPct: number;
  /** Python executable used to launch the sandbox worker. */
  python: string;
  /** Filesystem tool limits for read_file/grep/find/project-map generation. */
  fsLimits: FsLimits;
  /** Worker startup wait before treating sandbox init as failed (ms). */
  sandboxInitTimeoutMs: number;
  /** Enable RLM to propose unified diff edits for explicit approval and final application after the run. */
  editEnabled: boolean;
  /** Allow ask_user_question() calls from the root REPL. */
  askUserQuestion: boolean;
  /** Allow todo() calls from the REPL. */
  todo: boolean;
  /** Diff edit requests always ask before being recorded; old persisted values sanitize to ask. */
  editRequestApproval: EditRequestApprovalMode;
  /** SECURITY: allow first-class fs tools to read outside the workspace root. */
  allowReadOutsideWorkspace: boolean;
  /** Sampling for the root smart model. */
  smartReasoning?: ThinkingLevel;
  /** Sampling for sub-LLM (worker) calls. */
  subSampling: Sampling;
  /** Optional MLflow telemetry export configuration. Omitted by default. */
  readonly telemetry?: TelemetryConfig;
  /** Optional run-state persistence configuration. Enabled by default. */
  readonly runLog?: RunLogConfig;
}

/** Input to a (headless) RLM run. */
export interface RlmInput {
  /** The question for the root model (folded into the metadata prompt). */
  rootPrompt: string;
  /** The (possibly huge) context loaded into the sandbox REPL. */
  context: unknown;
  /** Recursion depth; 0 = top-level root. */
  depth: number;
  /** AgentTree node to attach this run's node under (set when recursing). */
  parentNodeId?: string;
  /** "provider/id" — overrides deps.smartModel for this run (set by recursive rlm_query). */
  smartModelOverride?: string;
  /** Remaining budget for this subtree (set by parent from its LimitGuard). */
  remainingBudgetUsd?: number;
  /** Remaining timeout for this subtree (set by parent from its LimitGuard). */
  remainingTimeoutMs?: number;
  /** Workspace root exposed to sanctioned file-backed REPL tools. */
  workspaceRoot?: string;
  /** True when context was synthesized by buildProjectManifest. */
  projectMap?: boolean;
  /** Depth-0 resume payload — controller rebuilds this from the trail's `reconstructRlmState()`. */
  readonly resume?: ReconstructResult & { readonly ok: true };
}

/** Result of a completed RLM run. */
export interface RlmResult {
  answer: string;
  /** Legacy anchor edits retained for compatibility while older run-state rows exist. */
  edits?: ProposedEdit[];
  diffs?: ProposedDiffEdit[];
  iterations: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** A function that runs an RLM to completion — used to wire recursion (rlm_query). */
export interface InteractiveDeps {
  /** Called when the sandbox issues ask_user_question; undefined = feature disabled. */
  onAskUserQuestion?: (questions: readonly AskQuestion[]) => Promise<AskAnswer[]>;
  /** Called when the sandbox issues todo; undefined = feature disabled. */
  onTodo?: (action: string, params: Record<string, unknown>) => Promise<string>;
}

export type RunRlm = (input: RlmInput) => Promise<RlmResult>;
