import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { buildLanEnvironment, resolveLanHost } from './lan-http-config.mjs';

let host;
try {
  host = resolveLanHost({ override: process.env.LAN_HOST, interfaces: networkInterfaces() });
} catch (error) {
  console.error(`Unable to start LAN mode: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

if (host) {
  const lanEnvironment = buildLanEnvironment(host);
  console.log(`LAN player URL: ${lanEnvironment.LAN_HTTP_ORIGIN}`);
  console.log(`LAN API URL: ${lanEnvironment.NEXT_PUBLIC_API_URL}`);
  console.log('Trusted Wi-Fi only. Do not expose ports 3000 or 4000 to the public Internet.');

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCommand, ['run', 'dev'], {
    env: { ...process.env, ...lanEnvironment },
    stdio: 'inherit',
  });

  child.once('error', (error) => {
    console.error(`Unable to launch npm run dev: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
  }
}
