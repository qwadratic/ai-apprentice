// Copies static/ (index.html) into dist/ so that dist/ is the whole demo site.
// Run after tsc: node scripts/copy-static.ts
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const from = fileURLToPath(new URL('static/', root));
const to = fileURLToPath(new URL('dist/', root));

if (!existsSync(from)) throw new Error(`missing ${from}`);
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
