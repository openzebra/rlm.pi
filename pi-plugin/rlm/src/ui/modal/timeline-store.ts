/**
 * TimelineStore — per-run ring buffer of notable events for the agent modal.
 *
 * Subscribes to the same emitter as SubcallStore (via the shared EmitterListener
 * base) but records HISTORY instead of latest state: spawns, phase transitions,
 * settlements, turn ticks. Bounded — oldest entries drop off past TIMELINE_CAP.
 * The modal filters by nodeId, so one store serves every agent of the run.
 */

import type {
  RlmEmitter,
  RootPhaseEvent,
  SubcallCreatedEvent,
  SubcallUpdatedEvent,
  TurnEvent,
} from "../../tool/rlm-events.ts";
import { EmitterListener } from "../../tool/emitter-listener.ts";

export const TIMELINE_CAP = 200;

export type TimelineIcon = "spawn" | "phase" | "done" | "error" | "note" | "turn";

export interface TimelineEntry {
  readonly at: number;
  /** Node the entry belongs to: the subcall it describes; spawns attach to the PARENT. */
  readonly nodeId: string;
  readonly icon: TimelineIcon;
  readonly text: string;
}

export class TimelineStore extends EmitterListener {
  private entries: TimelineEntry[] = [];

  constructor(emitter: RlmEmitter, private readonly runId: string) {
    super();
    this.trackAll([
      emitter.onSubcallCreated((e) => this.handleCreated(e)),
      emitter.onSubcallUpdated((e) => this.handleUpdated(e)),
      emitter.onTurn((e) => this.handleTurn(e)),
      emitter.onRootPhase((e) => this.handleRootPhase(e)),
    ]);
  }

  /** Entries about a node, oldest first. Allocates — call from modal render only. */
  forNode(nodeId: string): readonly TimelineEntry[] {
    return this.entries.filter((e) => e.nodeId === nodeId);
  }

  private handleCreated(event: SubcallCreatedEvent): void {
    this.push({
      at: Date.now(),
      nodeId: event.parentId ?? this.runId,
      icon: "spawn",
      text: `spawned ${event.kind}: ${event.label}`,
    });
  }

  private handleUpdated(event: SubcallUpdatedEvent): void {
    if (event.phase !== undefined) {
      this.push({ at: Date.now(), nodeId: event.id, icon: "phase", text: event.phase });
    }
    if (event.detail !== undefined) {
      this.push({ at: Date.now(), nodeId: event.id, icon: "note", text: event.detail });
    }
    if (event.status === "done") {
      this.push({ at: Date.now(), nodeId: event.id, icon: "done", text: "settled" });
    } else if (event.status === "error") {
      this.push({ at: Date.now(), nodeId: event.id, icon: "error", text: event.detail ?? "failed" });
    }
  }

  private handleTurn(event: TurnEvent): void {
    this.push({ at: Date.now(), nodeId: this.runId, icon: "turn", text: `turn ${event.current}/${event.max}` });
  }

  private handleRootPhase(event: RootPhaseEvent): void {
    this.push({ at: Date.now(), nodeId: this.runId, icon: "phase", text: event.phase });
  }

  private push(entry: TimelineEntry): void {
    // Ring semantics: at cap, the oldest entry goes. Cap is small (200), shift is fine.
    if (this.entries.length >= TIMELINE_CAP) this.entries.shift();
    this.entries.push(entry);
  }
}
