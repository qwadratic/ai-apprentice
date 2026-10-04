import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const children = [
  spawn(process.execPath, ['--watch', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('apps/api/', root)),
    stdio: 'inherit',
  }),
  spawn(process.execPath, [fileURLToPath(new URL('node_modules/vite/bin/vite.js', root)), '--host', '127.0.0.1'], {
    cwd: fileURLToPath(new URL('apps/web/', root)),
    stdio: 'inherit',
  }),
];

let stopping = false;
function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}

for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', (code, signal) => {
    if (!stopping) stop(code || (signal ? 1 : 0));
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
