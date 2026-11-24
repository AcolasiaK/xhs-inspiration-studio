import { isCloudMode } from "@/lib/cloud/mode";
import { requirePageUser } from "@/lib/cloud/server/auth";
import { AdminScreen } from "@/components/cloud/auth-screens";
import { AppShell } from "@/components/app-shell";
export const dynamic = "force-dynamic";
export default async function Page(){
  if(!isCloudMode()) return <AppShell><main className="auth-page"><section className="auth-card"><h1>权限管理</h1><p className="auth-description">账号管理需要登录管理员账号。本机创作模式无需登录；请在独立测试环境体验账号管理，测试数据不会影响本机草稿或线上账号。</p><a className="auth-back" href="http://127.0.0.1:3003/entry">打开本地权限测试环境</a></section></main></AppShell>;
  await requirePageUser({admin:true});
  return <AppShell><AdminScreen/></AppShell>;
}
