/**
 * RlmEventAggregator — builds RlmDetails from RlmEmitter events.
 *
 * Attaches as a listener to an RlmEmitter and accumulates sub-call lifecycle
 * events into a flat RlmSubcall[] array with O(1) running totals. Exposes
 * getState(): RlmDetails for direct access (spinner loop, final return).
 *
 * Subcall storage and totals are delegated to SubcallStore. Root-level state
 * (status, prompt, turns, answer, edits) is kept in the aggregator.
 *
 * Replaces RlmToolBridge's internal state accumulation. The emitter is pure
 * dispatch; the aggregator is pure state. Separated for independent testing.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { RlmEmitter, TurnEvent, RootUsageEvent, AnswerEvent, EditsEvent, StatusEvent, RootPromptEvent } from "./rlm-events.ts";
import type { RlmDetails, RlmRunStatus } from "./rlm-details.ts";
import { EmitterListener } from "./emitter-listener.ts";
import { SubcallStore } from "./subcall-store.ts";

export class RlmEventAggregator extends EmitterListener {
  private readonly store: SubcallStore;

  // Root-level state
  private rootStatus: RlmRunStatus = "running";
  private rootPrompt = "";
  private turnCurrent = 0;
  private turnMax = 0;
  private answer?: string;
  private edits: RlmDetails["edits"] = [];

  constructor(
    emitter: RlmEmitter,
    private readonly onChange?: AgentToolUpdateCallback<RlmDetails>,
  ) {
    super();
    this.store = new SubcallStore(emitter, () => this.notify());

    this.trackAll([
      emitter.onTurn((e) => this.handleTurn(e)),
      emitter.onRootUsage((e) => this.handleRootUsage(e)),
      emitter.onAnswer((e) => this.handleAnswer(e)),
      emitter.onEdits((e) => this.handleEdits(e)),
      emitter.onStatus((e) => this.handleStatus(e)),
      emitter.onRootPrompt((e) => this.handleRootPrompt(e)),
    ]);
  }

  // ── Event handlers ──

  private handleTurn(event: TurnEvent): void {
    this.turnCurrent = event.current;
    this.turnMax = event.max;
    this.notify();
  }

  private handleRootUsage(event: RootUsageEvent): void {
    this.store.addRootUsage(event.costUsd, event.tokens);
    this.notify();
  }

  private handleAnswer(event: AnswerEvent): void {
    this.answer = event.text;
    this.notify();
  }

  private handleEdits(event: EditsEvent): void {
    this.edits = event.edits;
    this.notify();
  }

  private handleStatus(event: StatusEvent): void {
    this.rootStatus = event.status;
    this.notify();
  }

  private handleRootPrompt(event: RootPromptEvent): void {
    this.rootPrompt = event.text;
    // No notify — root prompt is set before listeners exist; no TUI re-render needed
  }

  // ── Read ──

  /** Snapshot the current accumulated state. O(1). */
  getState(): RlmDetails {
    return {
      status: this.rootStatus,
      rootPrompt: this.rootPrompt,
      turns: { current: this.turnCurrent, max: this.turnMax },
      subcalls: this.store.getSubcalls(),
      totals: this.store.getTotals(),
      answer: this.answer,
      edits: this.edits,
    };
  }

  // ── Lifecycle ──

  /** Detach all emitter listeners. Call after the run completes. */
  override dispose(): void {
    this.store.dispose();
    super.dispose();
  }

  // ── Internal ──

  private notify(): void {
    if (!this.onChange) return;
    const state = this.getState();
    this.onChange({
      content: [{ type: "text", text: state.answer ?? "(running...)" }],
      details: state,
    });
  }
}
