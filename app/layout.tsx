import type { Metadata } from "next";
import { CloudProvider } from "@/components/cloud/context";
import { isCloudMode } from "@/lib/cloud/mode";
import { pageAuthForDisplay } from "@/lib/cloud/server/page-auth-display";
import "./globals.css";
import "./atelier.css";
import "./scene-motion.css";
import "@/components/ai/usage-status.css";
import "@/components/rewrite/rewrite.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "小红书灵感工作台 · 把想法变成笔记",
  description: "上传图片，输入灵感，创作你的标题、逐图配文和完整正文。",
};
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cloud = isCloudMode();
  const testEnvironment = cloud && process.env.NODE_ENV !== "production" && process.env.CLOUD_LOCAL_TEST === "1";
  // The provider is presentation only. Protected pages/API routes still run
  // their own server-side guards and cannot accept this anonymous fallback.
  const user = cloud ? (await pageAuthForDisplay()).state.user : null;
  return <html lang="zh-CN"><body className="atelier"><CloudProvider cloud={cloud} user={user} testEnvironment={testEnvironment}>{children}</CloudProvider></body></html>;
}
