/**
 * Chunking + bin-packing helpers (Kleinberg "Algorithm Design" Ch.5 cost intuition):
 * to keep the divide-and-conquer cost near-linear, pack many context items into as FEW
 * sub-LLM prompts as possible, each near the per-call capacity ceiling. Fewer, fatter
 * prompts = fewer turns = lower cost than many tiny ones.
 *
 * The root model usually writes its own chunking in Python; these are provided for the
 * bridge's oversize-prompt guard and for callers that want a ready-made packer.
 */

/** Split a long string into ≤ `capacity`-sized slices (used to guard oversize sub-prompts). */
export function sliceString(text: string, capacity: number): string[] {
  if (capacity <= 0 || text.length <= capacity) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += capacity) out.push(text.slice(i, i + capacity));
  return out;
}

/**
 * First-Fit-Decreasing bin packing: group `items` into joined chunks each ≤ `capacity` chars.
 * Items larger than capacity are sliced first so nothing is dropped. Returns joined strings.
 */
export function packChunks(items: string[], capacity: number, sep = "\n\n"): string[] {
  const units: string[] = [];
  for (const it of items) {
    if (it.length > capacity) units.push(...sliceString(it, capacity));
    else units.push(it);
  }
  // Decreasing size first — the classic FFD ordering for tight packing.
  const ordered = [...units].sort((a, b) => b.length - a.length);
  const bins: { text: string; len: number }[] = [];
  for (const u of ordered) {
    const add = (bin: { text: string; len: number }) => {
      bin.text = bin.text ? bin.text + sep + u : u;
      bin.len += u.length + (bin.len ? sep.length : 0);
    };
    const fit = bins.find((b) => b.len + u.length + sep.length <= capacity);
    if (fit) add(fit);
    else {
      const bin = { text: "", len: 0 };
      add(bin);
      bins.push(bin);
    }
  }
  return bins.map((b) => b.text);
}
