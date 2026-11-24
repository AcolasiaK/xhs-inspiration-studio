/* eslint-disable @typescript-eslint/no-require-imports -- Container entry uses CommonJS. */
// Fail closed: this public container must never start in the local bypass mode.
const { spawn } = require('node:child_process');
if (process.env.APP_MODE !== 'cloud' || process.env.APP_LOCAL_ONLY === '1' || process.env.CLOUD_LOCAL_TEST === '1') {
  console.error('云端启动配置不安全，服务未启动。');
  process.exit(1);
}
const port = process.env.PORT || '3000';
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('服务端口配置无效，服务未启动。');
  process.exit(1);
}
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '0.0.0.0', '--port', port], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('云服务启动失败。'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
