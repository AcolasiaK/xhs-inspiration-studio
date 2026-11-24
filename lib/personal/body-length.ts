/** Keep incomplete edits out of persisted drafts while allowing the field to be cleared and retyped. */
export function parsePersonalCustomLength(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 100 && count <= 1200 ? count : null;
}
