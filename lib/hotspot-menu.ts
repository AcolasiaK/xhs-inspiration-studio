export type HotspotDestination = "personal" | "photo" | "video";

/** Fixed-position menu in the visible viewport, including mobile keyboard/zoom offsets. */
export function placeHotspotMenu(anchor: { left: number; top: number; bottom: number }, menuHeight: number,
  viewport: { width: number; height: number; left: number; top: number }) {
  const margin = 8, gap = 6;
  const width = Math.min(216, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - width - margin));
  const below = viewport.top + viewport.height - margin - anchor.bottom - gap;
  const above = anchor.top - gap - viewport.top - margin;
  const upwards = below < menuHeight && above > below;
  const maxHeight = Math.max(0, Math.min(viewport.height - margin * 2, upwards ? above : below));
  const height = Math.min(menuHeight, maxHeight);
  const top = Math.max(viewport.top + margin, Math.min(upwards ? anchor.top - gap - height : anchor.bottom + gap, viewport.top + viewport.height - margin - height));
  return { left, top, width, maxHeight };
}
