/** Start a fully isolated, loopback-only account-management demo.
 * It never reads the project's dotenv files or uses any cloud provider credentials.
 * Start with `npm run dev:auth-test`; credentials are written only to a private local file.
 */
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

async function main() {
const projectRoot = process.cwd();
const portText = process.env.XHS_AUTH_TEST_PORT || "3003";
if (!/^\d{1,5}$/u.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) throw new Error("无效的本地测试端口");
const port = Number(portText);
const origin = `http://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), "xhs-permission-test-"));
const appDirectory = join(directory, "app-source");
await mkdir(appDirectory, {mode:0o700});
const allowedDirectories = ["app", "components", "lib", "deployment", "vendor", "public"];
const allowedFiles = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "instrumentation.ts"];
const forbidden = (path:string) => /^(?:\.env.*|\.npmrc|\.yarnrc.*|\.git|\.next|\.local-data|\.cloud-dev|\.codex|\.agents|node_modules|test-results)$/iu.test(basename(path)) || /\.(?:db|sqlite[^/]*|pem|key|p12|pfx|log)$/iu.test(basename(path)) || /^(?:credentials.*|service-account.*)\.json$/iu.test(basename(path));
for (const entry of [...allowedDirectories,...allowedFiles]) {
  const source=join(projectRoot,entry), target=join(appDirectory,entry);
  try {
    const info=await lstat(source);
    if(info.isSymbolicLink())throw new Error("测试项目不能从符号链接复制源码。");
    await cp(source,target,{recursive:info.isDirectory(),filter:async path=>!forbidden(path)&&!(await lstat(path)).isSymbolicLink()});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entry !== "public") throw error;
  }
}
await symlink(resolve(projectRoot,"node_modules"),join(appDirectory,"node_modules"),"dir");

const randomSecret = () => randomBytes(21).toString("base64url");
const gateSecret=randomSecret(),bootstrapSecret=randomSecret(),adminPassword=randomSecret(),friendPassword=randomSecret();
// The current process is used for setup too: clear all inherited cloud/AI values first.
for (const name of Object.keys(process.env)) {
  if (/^(?:CLOUD|CLOUDBASE|OPENAI|BOCHA|SITE_ACCESS|ADMIN_BOOTSTRAP|APP_MODE|APP_LOCAL_ONLY|APP_ORIGIN|VERCEL)/u.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  NODE_ENV:"development", APP_MODE:"cloud", APP_LOCAL_ONLY:"0", APP_ORIGIN:origin,
  CLOUD_LOCAL_TEST:"1", CLOUD_BACKEND:"sqlite", CLOUD_SQLITE_PATH:join(directory,"test.sqlite"), CLOUD_BLOB_PATH:join(directory,"blobs"),
});
const {hashSecret,issueGate,gateCookieName,bootstrapAdmin,registerUser} = await import("../lib/cloud/server/auth");
process.env.SITE_ACCESS_HASH=await hashSecret(gateSecret);
process.env.ADMIN_BOOTSTRAP_HASH=await hashSecret(bootstrapSecret);
const gateToken=await issueGate(gateSecret);
const request=new Request(`${origin}/`,{headers:{cookie:`${gateCookieName()}=${gateToken}`}});
await bootstrapAdmin(request,bootstrapSecret,"test_admin",adminPassword);
await registerUser(request,"test_friend",friendPassword);
const credentialPath=join(directory,"test-credentials.txt");
await writeFile(credentialPath, `仅本地隔离测试使用，勿用于真实账号。\n统一测试口令：${gateSecret}\n测试管理员：test_admin\n测试管理员密码：${adminPassword}\n测试普通用户：test_friend\n测试普通用户密码：${friendPassword}\n`, {mode:0o600,flag:"wx"});

// Never inherit provider tokens, cookies or unrelated host settings into the demo.
const safeEnvironment:NodeJS.ProcessEnv = {NODE_ENV:"development"};
for (const key of ["PATH","HOME","TMPDIR","LANG","TERM"]) if(process.env[key])safeEnvironment[key]=process.env[key];
Object.assign(safeEnvironment, {
  NODE_ENV:"development", APP_MODE:"cloud", APP_LOCAL_ONLY:"0", APP_ORIGIN:origin,
  CLOUD_LOCAL_TEST:"1", CLOUD_BACKEND:"sqlite", CLOUD_SQLITE_PATH:join(directory,"test.sqlite"), CLOUD_BLOB_PATH:join(directory,"blobs"),
  SITE_ACCESS_HASH:process.env.SITE_ACCESS_HASH, ADMIN_BOOTSTRAP_HASH:process.env.ADMIN_BOOTSTRAP_HASH,
  OPENAI_API_KEY:"", OPENAI_MODEL:"", OPENAI_BASE_URL:"", BOCHA_API_KEY:"",
});
console.info(`本地权限测试地址：${origin}/entry\n测试凭据保存在仅本机可读的文件：${credentialPath}\n关闭此进程即可停止测试环境；数据和账号与本机创作及腾讯云隔离。`);
const child=spawn(process.execPath,[resolve(projectRoot,"node_modules/next/dist/bin/next"),"dev","--webpack","--hostname","127.0.0.1","--port",String(port)],{cwd:appDirectory,env:safeEnvironment,stdio:"inherit"});
child.on("exit",code=>{process.exitCode=code??1;});
for (const signal of ["SIGINT","SIGTERM"] as const) process.on(signal,()=>{child.kill(signal);});
}

void main().catch(() => { console.error("本地权限测试环境未能启动；请检查项目依赖和本机临时目录权限。"); process.exitCode=1; });
