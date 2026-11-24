/** Desktop panels own scrolling. Stacked mobile layouts scroll inside the workspace grid. */
export function hotspotScrollPanel(element: HTMLElement | null): HTMLElement | null {
  const panel = element?.closest<HTMLElement>('[data-hotspot-scroll]');
  return panel && ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY) ? panel : null;
}

export function scrollHotspotSection(target: HTMLElement) {
  const panel = hotspotScrollPanel(target);
  if (!panel) { target.scrollIntoView({ block: 'start', behavior: 'instant' }); return; }
  const inset = parseFloat(getComputedStyle(panel).scrollPaddingTop) || 24;
  panel.scrollTo({ top: panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientTop - inset, behavior: 'instant' });
}
