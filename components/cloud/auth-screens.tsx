"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Clear private tab state on account changes. */
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Cloud, LockKeyhole, UserRound, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { cloudFetch } from "@/lib/cloud/client";
import { verifyGate } from "@/lib/cloud/gate-client";
import { useCloud, type CloudClientUser } from "./context";
import "./auth.css";

type EntryState = { gateVerified: boolean; bootstrapComplete: boolean };
type ListedUser = { id: string; username: string; role: "admin" | "user"; mustChange: boolean; createdAt: string; disabled?: boolean };
const subscribeHydration = () => () => undefined;
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;
async function action(name: string, data: object) {
  let response: Response;
  try { response = await cloudFetch(`/api/cloud/auth/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); }
  catch { throw new Error("网络连接失败，请检查网络后重试。"); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error?.message === "string" ? result.error.message : "请求未完成，请稍后重试。");
  return result;
}
function Frame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  // Do not accept typing before React has attached handlers: otherwise cold hydration can discard it.
  const ready = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot);
  const {testEnvironment} = useCloud();
  return <main className="auth-page"><section className={`auth-card${title === "权限管理" ? " auth-card--admin" : ""}`} aria-busy={!ready}><div className="auth-brand"><span><Cloud size={20}/></span><strong>小红书灵感工作台</strong></div>{testEnvironment && <p className="auth-test-badge">本地测试环境：账号和草稿与线上完全独立</p>}<h1>{title}</h1><p className="auth-description">{description}</p>{!ready && <p className="auth-info" role="status">正在准备页面…</p>}<fieldset inert={!ready} disabled={!ready}>{children}</fieldset></section></main>;
}
function PasswordField({ label, value, onChange, autoComplete = "new-password", placeholder }: { label: string; value: string; onChange: (value: string) => void; autoComplete?: string; placeholder?: string }) {
  return <label className="auth-field"><span>{label}</span><input type="password" required maxLength={256} autoComplete={autoComplete} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
function GatePasswordField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: string }) {
  const [visible, setVisible] = useState(false);
  return <div className="auth-field"><label htmlFor="gate-secret">统一访问口令</label><div className="auth-password-wrap"><input id="gate-secret" type={visible ? "text" : "password"} maxLength={256} autoComplete="off" value={value} onChange={event => onChange(event.target.value)} placeholder="请输入统一访问口令" aria-invalid={Boolean(error)} aria-describedby={error ? "gate-secret-help gate-secret-error" : "gate-secret-help"} /><button type="button" className="auth-password-toggle" aria-label={visible ? "隐藏口令" : "显示口令"} aria-pressed={visible} onClick={() => setVisible(previous => !previous)}>{visible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}</button></div><span id="gate-secret-help" className="auth-field-hint">口令区分大小写；输入的空格也会参与验证。</span></div>;
}
function ErrorMessage({ error, id }: { error: string; id?: string }) { return error ? <p id={id} className="auth-error" role="alert">{error}</p> : null; }

export function EntryScreen({ state, passwordChanged = false, gateChanged = false, initialGateError = "" }: { state: EntryState; passwordChanged?: boolean; gateChanged?: boolean; initialGateError?: string }) {
  const [secret, setSecret] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login"), [busy, setBusy] = useState(false), [error, setError] = useState(initialGateError);
  const active = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (active.current) return; active.current = true; setBusy(true); setError("");
    let leaving = false;
    try {
      if (!state.gateVerified) { await verifyGate(secret); setSecret(""); window.location.reload(); leaving = true; }
      else { await action(mode, { username, password }); setPassword(""); window.location.assign("/"); leaving = true; }
    } catch (error) { setError(error instanceof Error ? error.message : "请求未完成，请稍后重试。"); }
    finally { if (!leaving) { active.current = false; setBusy(false); } }
  }
  if (!state.gateVerified) return <Frame title="欢迎来到工作台" description="请先输入管理员提供的统一访问口令，通过后即可使用自己的账号。">{gateChanged && <p className="auth-info" role="status">统一访问口令已更新。请使用新口令重新验证；所有设备的旧口令状态已失效。</p>}<form onSubmit={submit} className="auth-form" noValidate><GatePasswordField value={secret} onChange={setSecret} error={error}/><ErrorMessage id="gate-secret-error" error={error}/><button type="submit" className="generate-button" disabled={busy}><LockKeyhole size={16}/>{busy ? "正在验证…" : "继续"}</button></form><p className="auth-footnote">访问验证和账号登录分别保持 7 天；到期后按提示重新验证。</p></Frame>;
  return <Frame title="登录或创建账号" description="每个人拥有独立的草稿、图片和写作偏好。"><div role="group" aria-label="账号操作" className="auth-tabs"><button type="button" aria-pressed={mode === "login"} onClick={()=>{setMode("login");setError("");}}>登录</button><button type="button" aria-pressed={mode === "register"} onClick={()=>{setMode("register");setError("");}}>注册</button></div>{passwordChanged && <p className="auth-info" role="status">密码已更新，请使用新密码登录。</p>}{!state.bootstrapComplete && <div className="auth-info">请先由管理员完成初始化。<Link href="/setup">创建管理员账号</Link></div>}<form onSubmit={submit} className="auth-form"><label className="auth-field"><span>用户名</span><input required minLength={3} maxLength={24} autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} placeholder="3～24 位字母、数字或下划线"/></label><PasswordField label="个人密码" value={password} onChange={setPassword} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "register" ? "至少 12 个字符" : "输入你的个人密码"}/><ErrorMessage error={error}/><button type="submit" className="generate-button" disabled={busy || !state.bootstrapComplete}><UserRound size={16}/>{busy ? "正在处理…" : mode === "login" ? "登录" : "创建账号并登录"}</button></form><p className="auth-footnote">忘记密码请联系管理员重置；首次使用临时密码后需自行修改。</p></Frame>;
}

export function SetupScreen() {
  const [bootstrapSecret,setBootstrapSecret]=useState(""),[username,setUsername]=useState(""),[password,setPassword]=useState(""),[confirm,setConfirm]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const active=useRef(false);
  async function submit(event:FormEvent){event.preventDefault();if(active.current)return;if(password!==confirm){setError("两次输入的密码不一致。");return;}active.current=true;setBusy(true);setError("");let leaving=false;try{await action("setup",{bootstrapSecret,username,password});setBootstrapSecret("");setPassword("");setConfirm("");window.location.assign("/");leaving=true;}catch(e){setError(e instanceof Error?e.message:"初始化未完成。");}finally{if(!leaving){active.current=false;setBusy(false);}}}
  return <Frame title="创建管理员" description="仅首次初始化可用，需要服务器配置的管理员初始化凭据。"><form onSubmit={submit} className="auth-form"><PasswordField label="管理员初始化凭据" value={bootstrapSecret} onChange={setBootstrapSecret}/><label className="auth-field"><span>管理员用户名</span><input autoComplete="username" required minLength={3} maxLength={24} value={username} onChange={e=>setUsername(e.target.value)} placeholder="3～24 位字母、数字或下划线"/></label><PasswordField label="管理员个人密码" value={password} onChange={setPassword} placeholder="至少 12 个字符"/><PasswordField label="再次输入个人密码" value={confirm} onChange={setConfirm}/><ErrorMessage error={error}/><button className="generate-button" type="submit" disabled={busy}><ShieldCheck size={16}/>{busy?"正在创建…":"创建管理员"}</button></form><Link className="auth-back" href="/entry">返回登录</Link></Frame>;
}

export function AccountScreen({user}:{user:CloudClientUser}) {
  const [oldPassword,setOldPassword]=useState(""),[newPassword,setNewPassword]=useState(""),[confirm,setConfirm]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");const active=useRef(false);
  async function submit(event:FormEvent){event.preventDefault();if(active.current)return;if(newPassword!==confirm){setError("两次输入的新密码不一致。");return;}active.current=true;setBusy(true);setError("");let leaving=false;try{await action("change",{oldPassword,newPassword});setOldPassword("");setNewPassword("");setConfirm("");window.location.assign("/entry?changed=1");leaving=true;}catch(e){setError(e instanceof Error?e.message:"密码修改未完成。");}finally{if(!leaving){active.current=false;setBusy(false);}}}
  async function logout(){if(active.current)return;active.current=true;setBusy(true);setError("");let leaving=false;try{await action("logout",{});window.location.assign("/entry");leaving=true;}catch(e){setError(e instanceof Error?e.message:"退出未完成，请重试。");}finally{if(!leaving){active.current=false;setBusy(false);}}}
  return <Frame title="修改个人密码" description={user.mustChange?"管理员已为你重置密码。请先设置自己的新密码，再继续创作。":`当前账号：${user.username}。修改后需要重新登录。`}><form onSubmit={submit} className="auth-form"><PasswordField label="当前密码" value={oldPassword} onChange={setOldPassword} autoComplete="current-password"/><PasswordField label="新密码" value={newPassword} onChange={setNewPassword} placeholder="至少 12 个字符"/><PasswordField label="再次输入新密码" value={confirm} onChange={setConfirm}/><ErrorMessage error={error}/><button type="submit" className="generate-button" disabled={busy}>{busy?"正在处理…":"保存新密码"}</button></form><div className="auth-account-actions">{!user.mustChange&&<Link className="auth-back" href="/">返回工作台</Link>}<button type="button" className="auth-back" disabled={busy} onClick={()=>void logout()}>退出登录</button></div></Frame>;
}

export function AdminScreen() {
  const [users,setUsers]=useState<ListedUser[]>([]), [passwords,setPasswords]=useState<Record<string,string>>({});
  const [username,setUsername]=useState(""), [temporaryPassword,setTemporaryPassword]=useState("");
  const [currentGate,setCurrentGate]=useState(""), [newGate,setNewGate]=useState(""), [confirmGate,setConfirmGate]=useState("");
  const [oldPassword,setOldPassword]=useState(""), [newPassword,setNewPassword]=useState(""), [confirmPassword,setConfirmPassword]=useState("");
  const [busy,setBusy]=useState(""), [error,setError]=useState(""), [info,setInfo]=useState(""), [loaded,setLoaded]=useState(false);
  const active=useRef(false);
  const {user: currentUser}=useCloud();
  async function loadUsers() {
    const response=await cloudFetch("/api/cloud/auth/users");
    const data=await response.json().catch(()=>null);
    if(!response.ok||!Array.isArray(data?.users)) throw new Error("用户列表暂时无法读取，请检查登录状态后重试。");
    setUsers(data.users);setLoaded(true);
  }
  useEffect(()=>{let cancelled=false;void cloudFetch("/api/cloud/auth/users").then(async response=>{const data=await response.json().catch(()=>null);if(!response.ok||!Array.isArray(data?.users))throw new Error();if(!cancelled){setUsers(data.users);setLoaded(true);}}).catch(()=>{if(!cancelled){setLoaded(true);setError("用户列表暂时无法读取，请检查网络后重试。");}});return()=>{cancelled=true;};},[]);
  async function run(label:string, operation:()=>Promise<void>) {
    if(active.current)return;
    active.current=true;setBusy(label);setError("");setInfo("");
    try { await operation(); }
    catch(e) { setError(e instanceof Error ? e.message : "操作未完成，请稍后重试。"); }
    finally { active.current=false;setBusy(""); }
  }
  async function create(event:FormEvent) {
    event.preventDefault();
    await run("create",async()=>{await action("create",{username,password:temporaryPassword});const createdName=username;setUsername("");setTemporaryPassword("");setInfo(`已创建普通用户 ${createdName}。请通过安全方式交付刚设置的临时密码；对方首次登录后必须修改。`);await loadUsers();});
  }
  async function reset(event:FormEvent,user:ListedUser) {
    event.preventDefault();if(active.current||!window.confirm(`为“${user.username}”设置临时密码？该账号的现有登录会立即失效。`))return;
    await run(`reset:${user.id}`,async()=>{await action("reset",{userId:user.id,password:passwords[user.id]||""});setPasswords(old=>({...old,[user.id]:""}));setInfo(`已为 ${user.username} 重置密码。请安全交付刚设置的临时密码，对方首次登录后须修改。`);await loadUsers();});
  }
  async function toggle(user:ListedUser) {
    const enabled=Boolean(user.disabled);
    if(active.current||!window.confirm(enabled ? `启用“${user.username}”？该账号可以再次登录。` : `停用“${user.username}”？该账号所有现有登录将立即失效。`))return;
    await run(`toggle:${user.id}`,async()=>{await action("toggle",{userId:user.id,enabled});setInfo(enabled?`已启用 ${user.username}；对方可重新登录。`:`已停用 ${user.username}，该账号的现有登录已失效。`);await loadUsers();});
  }
  async function changeGate(event:FormEvent) {
    event.preventDefault();
    if(newGate!==confirmGate){setError("两次输入的新统一口令不一致。");return;}
    if(active.current||!window.confirm("更新统一访问口令后，所有设备的旧口令验证都会立即失效，需要使用新口令重新验证。确定继续吗？"))return;
    await run("gate",async()=>{await action("gate-change",{currentSecret:currentGate,newSecret:newGate});setCurrentGate("");setNewGate("");setConfirmGate("");window.location.assign("/entry?gateChanged=1");});
  }
  async function changeOwnPassword(event:FormEvent) {
    event.preventDefault();if(newPassword!==confirmPassword){setError("两次输入的新密码不一致。");return;}
    await run("own-password",async()=>{await action("change",{oldPassword,newPassword});setOldPassword("");setNewPassword("");setConfirmPassword("");window.location.assign("/entry?changed=1");});
  }
  async function logout() { await run("logout",async()=>{await action("logout",{});window.location.assign("/entry");}); }
  return <Frame title="权限管理" description="只有管理员可以管理账号和统一访问口令。这里不显示任何人的现有密码，也不提供查看他人草稿的入口。">
    <ErrorMessage error={error}/>{info&&<p className="auth-info" role="status">{info}</p>}
    <section className="admin-section" aria-labelledby="admin-users-title"><h2 id="admin-users-title">账号列表</h2><p>只有一个管理员；普通用户停用后无法登录，既有草稿仍保留。</p><button type="button" className="text-button admin-toggle" disabled={Boolean(busy)} onClick={()=>void run("reload",async()=>{await loadUsers();setInfo("账号列表已刷新。");})}>刷新账号列表</button>
      <div className="auth-user-list">{!loaded ? <p role="status">正在读取账号…</p> : users.length===0 ? <p>暂时没有可显示的账号。</p> : users.map(user=><article key={user.id} className="auth-user"><strong>{user.username}</strong><span>{user.role === "admin" ? "管理员" : "普通用户"} · {user.disabled ? "已停用" : "已启用"}{user.mustChange ? " · 待修改密码" : ""}</span>
        {user.role === "user" && <><form onSubmit={event=>void reset(event,user)} className="auth-reset"><label className="sr-only" htmlFor={`reset-${user.id}`}>为 {user.username} 设置临时密码</label><input id={`reset-${user.id}`} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={passwords[user.id]||""} onChange={event=>setPasswords(old=>({...old,[user.id]:event.target.value}))} placeholder="设置至少 12 个字符的临时密码"/><button type="submit" className="secondary-button" disabled={Boolean(busy)}>{busy===`reset:${user.id}`?"正在重置…":"重置密码"}</button></form><button type="button" className="text-button admin-toggle" disabled={Boolean(busy)} onClick={()=>void toggle(user)}>{user.disabled ? "启用账号" : "停用账号"}</button></>}
      </article>)}</div>
    </section>
    <section className="admin-section" aria-labelledby="admin-create-title"><h2 id="admin-create-title">创建普通用户</h2><p>设置临时密码后，请通过安全方式交给对方；首次登录时必须更换个人密码。</p><form className="auth-form" onSubmit={event=>void create(event)}><label className="auth-field"><span>用户名</span><input required minLength={3} maxLength={24} autoComplete="off" value={username} onChange={event=>setUsername(event.target.value)} placeholder="3～24 位字母、数字或下划线"/></label><PasswordField label="临时密码" value={temporaryPassword} onChange={setTemporaryPassword} placeholder="至少 12 个字符"/><button className="secondary-button" type="submit" disabled={Boolean(busy)}>{busy==="create"?"正在创建…":"创建普通用户"}</button></form></section>
    <section className="admin-section" aria-labelledby="admin-gate-title"><h2 id="admin-gate-title">统一访问口令</h2><p>修改后，所有设备的旧口令验证立即失效，大家需要输入新口令。个人登录有效期不会延长。</p><form className="auth-form" onSubmit={event=>void changeGate(event)}><PasswordField label="当前统一口令" value={currentGate} onChange={setCurrentGate} autoComplete="off"/><PasswordField label="新统一口令" value={newGate} onChange={setNewGate} autoComplete="off" placeholder="至少 12 个字符"/><PasswordField label="再次输入新统一口令" value={confirmGate} onChange={setConfirmGate} autoComplete="off"/><button className="secondary-button" type="submit" disabled={Boolean(busy)}>{busy==="gate"?"正在更新…":"更新统一口令"}</button></form></section>
    <section className="admin-section" aria-labelledby="admin-account-title"><h2 id="admin-account-title">我的管理员账号</h2><p>当前账号：{currentUser?.username ?? "管理员"}。修改密码后需重新登录。</p><form className="auth-form" onSubmit={event=>void changeOwnPassword(event)}><PasswordField label="当前个人密码" value={oldPassword} onChange={setOldPassword} autoComplete="current-password"/><PasswordField label="新的个人密码" value={newPassword} onChange={setNewPassword} placeholder="至少 12 个字符"/><PasswordField label="再次输入个人密码" value={confirmPassword} onChange={setConfirmPassword}/><button className="secondary-button" type="submit" disabled={Boolean(busy)}>{busy==="own-password"?"正在保存…":"修改我的密码"}</button></form><button type="button" className="auth-back admin-logout" disabled={Boolean(busy)} onClick={()=>void logout()}>退出登录</button></section>
    <p className="auth-footnote">当前无法直接获取可靠的服务商用量或费用，请在服务商控制台查看实际账单。</p>
  </Frame>;
}
