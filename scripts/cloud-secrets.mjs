#!/usr/bin/env node
// Interactive only. No user secret is printed or stored; only salted hashes are written.
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { stdin, stdout, stderr } from "node:process";
import { resolve } from "node:path";

if (!stdin.isTTY || !stdout.isTTY) { stderr.write("请在本机终端运行此命令，不能通过管道传入密码。\n"); process.exit(1); }
const path = resolve(".env.cloud.secrets");
async function hidden(prompt) {
  stdout.write(prompt); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
  return new Promise((resolveValue, reject) => {
    let value = "";
    const stop = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); };
    const onData = data => { for (const char of data) {
      if (char === "\u0003") { stop(); reject(new Error("已取消")); return; }
      if (char === "\r" || char === "\n") { stop(); resolveValue(value); return; }
      if (char === "\u007f" || char === "\b") {
        if (value.length) { value = Array.from(value).slice(0, -1).join(""); stdout.write("\b \b"); }
      } else if (char >= " " && value.length < 256) { value += char; stdout.write("*"); }
    }};
    stdin.on("data", onData);
  });
}
async function readConfirmed(label, min) {
  const first = await hidden(`请设置${label}（至少 ${min} 个字符，输入显示为星号）：`);
  const second = await hidden(`请再次输入${label}：`);
  if (first !== second || Array.from(first.trim()).length < min || Array.from(first).length > 256) throw new Error(`两次输入不一致或${label}长度不合要求。`);
  return first;
}
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
async function hash(value) { const salt = randomBytes(16); const key = await new Promise((resolveValue,reject) => scryptCallback(value,salt,32,options,(error,result)=>error?reject(error):resolveValue(result)));return `scrypt:32768:8:3:${salt.toString("base64url")}:${key.toString("base64url")}`; }
try {
  const gate = await readConfirmed("统一访问口令", 12);
  const bootstrap = await readConfirmed("管理员初始化凭据", 20);
  if (gate === bootstrap) throw new Error("统一口令和管理员初始化凭据必须不同。");
  await writeFile(path, `# 本文件只包含哈希。仅放到服务器安全环境变量，切勿提交。\nSITE_ACCESS_HASH=${await hash(gate)}\nADMIN_BOOTSTRAP_HASH=${await hash(bootstrap)}\n`, { flag: "wx", mode: 0o600 });
  stdout.write("已创建 .env.cloud.secrets（不会覆盖已有文件）。请在本机打开，将两行哈希分别填入云端服务器的安全环境变量。创建管理员需要你刚设置的初始化凭据；请自行妥善保存，不要发送到聊天。\n");
} catch (error) { stderr.write(error?.code === "EEXIST" ? "文件已存在，未覆盖；请自行备份后重命名旧文件，再重新生成。\n" : `${error.message || "操作未完成"}\n`); process.exitCode = 1; }
