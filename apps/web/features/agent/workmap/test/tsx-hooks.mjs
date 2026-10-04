// Module hooks for the board's component tests: .tsx goes through esbuild (automatic JSX runtime), .css becomes an empty module.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  if (url.startsWith('file:') && url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const out = await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'esm', sourcefile: fileURLToPath(url), target: 'node22' });
    return { format: 'module', source: out.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
