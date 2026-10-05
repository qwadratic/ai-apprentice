import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const children = [
  spawn(process.execPath, ['--watch', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('apps/api/', root)),
    stdio: 'inherit',
    // The dev rig knows one invented earlier session of the email twin (docs/pitch/twin-demo.md); AGENT_SEED_MAPS=0 turns that off.
    // Production never sets it, and it only applies while no confirmed map exists. The map_enrich job reads up to 5 earlier
    // sessions here (one person at the keyboard); a shared deployment leaves AGENT_ENRICH_SESSIONS unset, which reads none.
    env: { ...process.env, AGENT_SEED_MAPS: process.env.AGENT_SEED_MAPS ?? '1', AGENT_ENRICH_SESSIONS: process.env.AGENT_ENRICH_SESSIONS ?? '5' },
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
