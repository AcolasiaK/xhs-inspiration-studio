'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function PersonalActionDock({ children }: { children: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = dock.current;
    const studio = element?.closest<HTMLElement>('.personal-studio');
    if (!element || !studio) return;
    const measure = () => studio.style.setProperty('--personal-dock-height', `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); studio.style.removeProperty('--personal-dock-height'); };
  }, []);
  return <div ref={dock} className="personal-action-dock" role="region" aria-label="当前步骤操作">
    <div className="personal-action-dock-inner">{children}</div>
  </div>;
}
