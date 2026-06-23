export interface AnchorEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface AnchorEditRange extends AnchorEdit {
  readonly start: number;
  readonly end: number;
}

export interface ValidateAnchorEditSuccess {
  readonly ok: true;
  readonly range: AnchorEditRange;
}

export interface ValidateAnchorEditFailure {
  readonly ok: false;
  readonly error: string;
}

export type ValidateAnchorEditResult = ValidateAnchorEditSuccess | ValidateAnchorEditFailure;

export interface ApplyAnchorEditsSuccess {
  readonly ok: true;
  readonly text: string;
  readonly applied: number;
}

export interface ApplyAnchorEditsFailure {
  readonly ok: false;
  readonly error: string;
}

export type ApplyAnchorEditsResult = ApplyAnchorEditsSuccess | ApplyAnchorEditsFailure;

function indexSuffix(index: number | undefined): string {
  return index === undefined ? "" : ` at index ${index}`;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) return count;
    count++;
    offset = match + needle.length;
  }
}

export function validateAnchorEdit(text: string, path: string, edit: AnchorEdit, index?: number): ValidateAnchorEditResult {
  const suffix = indexSuffix(index);
  if (edit.oldText.length === 0) return { ok: false, error: `'old' anchor${suffix} must not be empty` };
  const count = countOccurrences(text, edit.oldText);
  if (count === 0) return { ok: false, error: `anchor${suffix} not found in '${path}' — copy it verbatim from read_file output` };
  if (count > 1) return { ok: false, error: `anchor${suffix} occurs ${count}× in '${path}' — extend it with surrounding lines to make it unique` };
  const start = text.indexOf(edit.oldText);
  return { ok: true, range: { start, end: start + edit.oldText.length, oldText: edit.oldText, newText: edit.newText } };
}

function dedupeExactEdits(edits: readonly AnchorEdit[]): AnchorEdit[] {
  const seen = new Set<string>();
  const out: AnchorEdit[] = [];
  for (const edit of edits) {
    const key = JSON.stringify([edit.oldText, edit.newText]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edit);
  }
  return out;
}

export function validateAnchorEditSet(text: string, path: string, edits: readonly AnchorEdit[]): ValidateAnchorEditFailure | { readonly ok: true; readonly ranges: AnchorEditRange[] } {
  const unique = dedupeExactEdits(edits);
  const ranges = new Array<AnchorEditRange>(unique.length);
  for (let i = 0; i < unique.length; i++) {
    const edit = unique[i];
    if (!edit) return { ok: false, error: `missing edit at index ${i} for '${path}'` };
    const validated = validateAnchorEdit(text, path, edit, i);
    if (!validated.ok) return validated;
    ranges[i] = validated.range;
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && current.start < previous.end) {
      return { ok: false, error: `overlapping edits in '${path}' around offsets ${previous.start} and ${current.start}` };
    }
  }
  return { ok: true, ranges };
}

export function applyAnchorEdits(text: string, path: string, edits: readonly AnchorEdit[]): ApplyAnchorEditsResult {
  if (edits.length === 0) return { ok: true, text, applied: 0 };

  const validated = validateAnchorEditSet(text, path, edits);
  if (!validated.ok) return validated;

  const segments = new Array<string>(validated.ranges.length * 2 + 1);
  let cursor = 0;
  let segment = 0;
  for (const range of validated.ranges) {
    segments[segment] = text.slice(cursor, range.start);
    segments[segment + 1] = range.newText;
    segment += 2;
    cursor = range.end;
  }
  segments[segment] = text.slice(cursor);
  return { ok: true, text: segments.join(""), applied: validated.ranges.length };
}
