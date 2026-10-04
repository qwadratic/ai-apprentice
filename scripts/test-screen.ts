import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Explicit feature boundaries; support each slice while its tests migrate to TS.
const required = [
  'packages/screen/capture/tests',
  'packages/screen/vision',
  'packages/screen/baseline',
  'packages/screen/bridge',
  'apps/api/screen',
];
const optional = [
  'packages/screen/recording',
  'packages/screen/evidence',
  'apps/api/screen/recording',
  'apps/web/features/screen/ReplayPanel',
];
const demo = 'apps/web/features/demo-workspace/tests';
const directories = [...required, ...optional.filter(directory => existsSync(directory)), ...(existsSync(demo) ? [demo] : [])];
const files: string[] = [];
for (const directory of directories) {
  const tests = readdirSync(directory)
    .filter(name => /\.test\.(?:mjs|ts)$/.test(name))
    .sort()
    .map(name => `${directory}/${name}`);
  if (tests.length === 0) throw new Error(`No tests found in ${directory}`);
  console.info(`${directory}: ${tests.length} test files`);
  files.push(...tests);
}
if (!existsSync(demo)) console.info('Demo workspace not present in this revision.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
