"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

type Scene = "explore" | "writing" | "collage" | "film";
// Coordinates refer to the checked-in 768 × 350 illustration plates. Moving
// fragments are cut out of the base, so an animated object never has a ghost copy.
const fragments: Record<Scene, { name: string; points: string; origin: string }[]> = {
  explore: [{ name: "map", points: "491,251 534,150 576,157 582,137 637,145 644,131 721,132 694,207 645,209 641,251 597,251 592,272", origin: "595px 262px" }],
  writing: [
    { name: "lamp", points: "492,105 505,80 541,51 555,46 557,33 568,32 577,40 575,49 588,58 604,86 601,114 592,134 570,140 522,130", origin: "575px 64px" },
    { name: "pen", points: "337,211 346,208 400,297 393,301", origin: "365px 267px" },
    { name: "page", points: "447,305 449,256 472,225 508,211 539,210 515,235 492,275 487,306", origin: "450px 307px" },
  ],
  collage: [
    { name: "photo-one", points: "319,83 408,67 429,178 345,194", origin: "377px 78px" },
    { name: "photo-two", points: "552,57 640,31 685,130 598,157", origin: "594px 46px" },
    { name: "clip", points: "490,41 516,41 516,80 490,80", origin: "503px 66px" },
  ],
  film: [
    { name: "clapper", points: "416,134 484,83 498,99 427,151", origin: "420px 144px" },
    { name: "camera", points: "49,103 98,104 107,47 187,58 181,102 158,100 191,127 226,119 228,183 186,193 155,181 139,202 49,177", origin: "130px 189px" },
  ],
};


// Repaint only the vacated silhouette with adjacent watercolor or paper. These
// are SVG layers over the unchanged plate, not a second copy of its moving part.
const backdropViews: Record<Scene, string> = {
  explore: "500 75 110 35", writing: "320 50 100 40", collage: "520 65 25 20", film: "275 40 110 30",
};
function FragmentBackdrop({ scene, part, clipId }: { scene: Scene; part: { name: string; points: string }; clipId: string }) {
  const href = `/illustrations/${scene}.webp`;
  if (part.name === "pen") return <g clipPath={`url(#${clipId})`}><image href={href} x="12" width="768" height="350" /></g>;
  if (part.name === "page") return <polygon points={part.points} fill="#f3dfac" />;
  const points = part.points.split(" ").map(point => point.split(",").map(Number));
  const left = Math.min(...points.map(point => point[0])), top = Math.min(...points.map(point => point[1]));
  const width = Math.max(...points.map(point => point[0])) - left, height = Math.max(...points.map(point => point[1])) - top;
  const backing = scene === "collage" ? "#f7e9cb" : "#8fae9e";
  const viewBox = part.name === "clapper" ? "500 105 30 35" : backdropViews[scene];
  return <><polygon points={part.points} fill={backing} /><g clipPath={`url(#${clipId})`}><svg x={left} y={top} width={width} height={height} viewBox={viewBox} preserveAspectRatio="none"><image href={href} width="768" height="350" /></svg></g></>;
}

export function SceneIllustration({ scene, variant }: { scene: Scene; variant?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "");
  const parts = fragments[scene];
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let visible = false;
    const update = () => { element.dataset.paused = String(!visible || document.hidden); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); }, { threshold: 0.1 });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <div ref={root} className={`scene-illustration scene-${scene}`} data-variant={variant} data-paused="true" aria-hidden="true">
    <svg viewBox="0 0 768 350" focusable="false">
      <defs>
        <mask id={`${id}-base`}><rect width="768" height="350" fill="white"/>{parts.map(part => <polygon key={part.name} points={part.points} fill="black"/>)}</mask>
        {parts.map(part => <clipPath key={part.name} id={`${id}-${part.name}`}><polygon points={part.points}/></clipPath>)}
      </defs>
      {parts.map(part => <FragmentBackdrop key={part.name} scene={scene} part={part} clipId={`${id}-${part.name}`} />)}
      <image href={`/illustrations/${scene}.webp`} width="768" height="350" mask={`url(#${id}-base)`}/>
      {parts.map(part => <g key={part.name} className={`scene-part scene-${part.name}`} style={{ transformOrigin: part.origin }}><image href={`/illustrations/${scene}.webp`} width="768" height="350" clipPath={`url(#${id}-${part.name})`}/></g>)}
      {scene === "writing" && <g className="scene-steam-lines" style={{ transformOrigin: "575px 232px" }}><path d="M565 232c-13-17 14-23 4-39"/><path d="M587 225c-12-16 13-22 6-34"/></g>}
      {scene === "explore" && <g className="scene-discovery"><circle cx="680" cy="158" r="17" fill="none" stroke="#e87426" strokeWidth="2"/><circle cx="680" cy="158" r="25" fill="none" stroke="#e87426" strokeWidth="1"/></g>}
      {scene === "film" && <g className="scene-storyboards" fill="#ffbe50"><path className="scene-part scene-frame-one" d="M444 250h55l-8 40h-55z"/><path className="scene-part scene-frame-two" d="M520 250h58l-9 40h-58z"/><path className="scene-part scene-frame-three" d="M598 250h58l-9 40h-58z"/></g>}
    </svg>
  </div>;
}

export function SceneHeader({ scene, title, children, variant }: { scene: Scene; title: string; description: string; children?: ReactNode; variant?: string }) {
  return <header className="scene-header">
    <div className="scene-copy"><h1>{title}</h1></div>
    <SceneIllustration scene={scene} variant={variant}/>
    {children && <div className="scene-actions"><div className="scene-actions-desktop">{children}</div><details className="scene-actions-mobile"><summary aria-label={`${title}操作`}>操作</summary><div className="scene-actions-menu">{children}</div></details></div>}
  </header>;
}
