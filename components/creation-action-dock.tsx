'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function CreationActionDock({ children, label }: { children: ReactNode; label: string }) {
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = dock.current;
    const studio = element?.closest<HTMLElement>('.creation-studio');
    if (!element || !studio) return;
    const measure = () => studio.style.setProperty('--creation-dock-height', `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); studio.style.removeProperty('--creation-dock-height'); };
  }, []);
  return <div ref={dock} className="creation-action-dock" role="region" aria-label={label}>
    <div className="creation-action-inner">{children}</div>
  </div>;
}
