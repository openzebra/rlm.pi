export interface AnchorEdit {
  readonly oldText: string;
  readonly newText: string;
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
