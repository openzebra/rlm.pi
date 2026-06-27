import type { InputSource } from "@earendil-works/pi-coding-agent";

export interface InputRouteState {
  readonly enabled: boolean;
  readonly busy: boolean;
}

export interface InputRouteEvent {
  readonly source: InputSource;
  readonly text: string;
}

export type InputRouteDecision = "continue" | "route" | "busy";

export function decideRlmInputRoute(event: InputRouteEvent, state: InputRouteState): InputRouteDecision {
  const eligible = state.enabled && event.source === "interactive" && !event.text.trimStart().startsWith("/");
  if (!eligible) return "continue";
  return state.busy ? "busy" : "route";
}

export function shouldRouteRlmInput(event: InputRouteEvent, state: InputRouteState): boolean {
  return decideRlmInputRoute(event, state) === "route";
}
