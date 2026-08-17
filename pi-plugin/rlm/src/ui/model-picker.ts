/**
 * Model picker facade — grouped drill-down: provider → model → thinking level.
 *
 * The implementation is split under model-picker/ (grouping = pure catalog,
 * levels = thinking-level step, drilldown = the overlay flow); this module is
 * the stable import path everything else (commands, tests) talks to.
 */

export { CHEAPEST_VALUE, SESSION_VALUE, buildCatalog, initialModelPickerIndex, pickableModels, modelRefOf, type ProviderGroup } from "./model-picker/grouping.ts";
export { selectThinkingLevel, supportedThinkingLevels, type SelectableThinkingLevel } from "./model-picker/levels.ts";
export { selectModel, type ModelSelection, type PickerRole } from "./model-picker/drilldown.ts";
