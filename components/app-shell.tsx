"use client";
import { AiSelector } from "./ai/selector";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Discard private in-memory drafts on logout. */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, Flame, LoaderCircle, NotebookPen, ShieldCheck, PenLine, CheckSquare, Layers, Monitor, MoreHorizontal } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useCloud } from "./cloud/context";
import { cloudFetch } from "@/lib/cloud/client";
import { AppNavigationContext } from "./app-navigation";



const menus = [
  { href: "/hotspots", label: "今日热点", description: "发现值得分享的选题", icon: Flame },
  { href: "/personal", label: "个人创作", description: "从你的经历开始", icon: PenLine },
  { href: "/", label: "图文创作", description: "把想法变成一篇笔记", icon: NotebookPen },
  { href: "/video", label: "视频创作", description: "从拍摄想法到剪辑方案", icon: Clapperboard },
];

export function AppShell({ children, disabled = false, navigateSafely, guardNavigation }: {
  children: ReactNode;
  disabled?: boolean;
  navigateSafely?: (navigate: () => void) => Promise<boolean>;
  guardNavigation?: (navigate: () => void) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navigating = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { cloud, user, testEnvironment } = useCloud();
  const contentMenus = [
    { href: "/personal/completed", label: "已完成笔记", description: "收藏满意的版本", icon: CheckSquare },
    { href: "/personal/styles", label: "风格管理", description: "管理写作规则与版本", icon: Layers },
    ...(!cloud || user?.role === "admin" ? [{ href: "/admin", label: "权限管理", description: "管理账号与访问", icon: ShieldCheck }] : []),
  ];
  const visibleMenus = [...menus, ...contentMenus];

  function requestNavigation(href: string) {
    if (disabled || pending || href === pathname) return;
    if (guardNavigation) guardNavigation(() => { void navigate(href); });
    else void navigate(href);
  }

  async function navigate(href: string) {
    if (disabled || navigating.current || href === pathname) return;
    navigating.current = true;
    setPending(true);
    setError("");
    let moved = false;
    try {
      if (navigateSafely) moved = await navigateSafely(() => router.push(href));
      else { router.push(href); moved = true; }
      if (!moved) setError("草稿尚未保存，已留在当前页。请重试保存后再切换。");
    } catch {
      setError("暂时无法切换页面，当前内容仍保留，请重试。");
    } finally {
      // 成功时保持锁定直到新页面挂载，避免路由等待期间重复提交或编辑。
      if (!moved) { navigating.current = false; setPending(false); }
    }
  }

  async function logout() {
    if (disabled || navigating.current) return;
    navigating.current = true; setPending(true); setError("");
    async function finish() {
      try {
        const response = await cloudFetch("/api/cloud/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!response.ok) throw new Error("退出未完成，请稍后重试。");
        // A full navigation discards private in-memory state before another user signs in.
        window.location.assign("/entry");
      } catch (error) {
        setError(error instanceof Error ? error.message : "退出未完成，请稍后重试。");
        navigating.current = false; setPending(false);
      }
    }
    try {
      if (navigateSafely) {
        const saved = await navigateSafely(() => { void finish(); });
        if (!saved) { setError("草稿尚未保存，请先重试保存再退出。当前内容仍保留。"); navigating.current = false; setPending(false); }
      } else await finish();
    } catch { setError("草稿尚未保存，请先重试保存再退出。当前内容仍保留。"); navigating.current = false; setPending(false); }
  }

  return <AppNavigationContext.Provider value={{ navigate: requestNavigation, disabled: disabled || pending }}><div className="app-shell">
    <a className="skip-to-content" href="#workbench-content">跳到主要内容</a>
    <aside className="app-sidebar" aria-label="工作台导航">
      <div className="app-brand"><span className="brand-mark"><NotebookPen size={22} strokeWidth={1.6} aria-hidden="true" /></span><span>小红书<span className="app-brand-subtitle">灵感工作台</span></span></div>
      {testEnvironment && <p className="app-test-badge">本地测试环境 · 独立账号与草稿</p>}
      <div className="app-nav-caption">创作空间</div>
      <nav className="app-navigation" aria-label="主要导航">
        {visibleMenus.map(({ href, label, description, icon: Icon }) => {
          const current = pathname === href || (href === "/hotspots" && pathname.startsWith(`${href}/`)) || (href === "/personal/completed" && pathname.startsWith(`${href}/`));
          return <Link key={href} href={href} aria-current={current ? "page" : undefined}
            aria-disabled={disabled || pending || undefined} className={`app-nav-link${current ? " is-active" : ""}${href === "/personal/completed" ? " app-content-nav-start app-secondary-nav" : contentMenus.some(item => item.href === href) ? " app-secondary-nav" : ""}`}
            onNavigate={(event) => { event.preventDefault(); requestNavigation(href); }}>
            <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>
          </Link>;
        })}
      </nav>
      <details className="app-mobile-management">
        <summary aria-label="打开管理导航"><MoreHorizontal size={20} aria-hidden="true"/><span>管理</span></summary>
        <nav aria-label="管理导航">{contentMenus.map(({href,label,icon:Icon})=><Link key={href} href={href}
          aria-current={pathname===href?"page":undefined} aria-disabled={disabled||pending||undefined}
          onNavigate={event=>{event.preventDefault();requestNavigation(href);}}><Icon size={18} aria-hidden="true"/>{label}</Link>)}</nav>
      </details>
      <AiSelector compact disabled={disabled || pending} onNavigate={requestNavigation}/>
      <div className="app-nav-status" role="status" aria-live="polite">{pending ? <><LoaderCircle size={14} className="spin" />{navigateSafely ? "正在保存并切换…" : "正在切换…"}</> : disabled ? "处理完成后即可切换页面" : null}</div>
      {error && <p className="app-nav-error" role="alert">{error}</p>}
      {cloud && user && <div className="app-account"><span>当前账号：<strong>{user.username}</strong></span><div>
        <Link href="/account" aria-disabled={disabled || pending || undefined} onNavigate={event=>{event.preventDefault();requestNavigation("/account");}}>修改密码</Link>
        <button type="button" disabled={disabled || pending} onClick={()=>guardNavigation ? guardNavigation(()=>{void logout();}) : void logout()}>退出登录</button>
      </div></div>}
      {cloud && <p className="app-sidebar-note"><Monitor size={18} aria-hidden="true"/>账号创作空间</p>}
    </aside>
    <div id="workbench-content" tabIndex={-1} className="app-content" aria-busy={pending} inert={pending}>{children}</div>
  </div></AppNavigationContext.Provider>;
}
