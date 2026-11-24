/** Search pages can repeat earlier cards or virtualize them away. Count each ID once per traversal. */
export function createXhsSearchCursor(offset = 0, processedIds?: string[]) {
  const seen = new Set<string>();
  const processed = processedIds ? new Set(processedIds) : null;
  let remaining = processed ? 0 : Math.max(0, Math.floor(offset));
  return {
    get remaining() { return remaining; },
    take<T extends { id: string }>(cards: T[]) {
      const next: T[] = [];
      let discovered = 0;
      for (const card of cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id); discovered++;
        if (processed?.has(card.id)) continue;
        if (remaining) remaining--;
        else next.push(card);
      }
      return { cards: next, discovered };
    },
  };
}
