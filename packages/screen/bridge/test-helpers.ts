import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import type {createScreenBridgeRuntime as CreateScreenBridgeRuntime} from './ScreenBridgeRuntime.ts';

export async function loadBridgeRuntime(): Promise<{
  createScreenBridgeRuntime: typeof CreateScreenBridgeRuntime;
  cleanup(): Promise<void>;
}> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'apprentice-bridge-test-'));
  const contract = pathToFileURL(join(root, 'packages/contracts/dist/index.js')).href;
  for (const path of ['packages/screen/privacy/masks.ts', 'packages/screen/capture/ScreenCapture.ts',
    'packages/screen/bridge/ScreenBridgeRuntime.ts']) {
    const output = join(directory, path.replace(/\.ts$/, '.js'));
    await mkdir(dirname(output), {recursive: true});
    const source = (await readFile(join(root, path), 'utf8')).replaceAll("'@apprentice/contracts'", `'${contract}'`);
    await writeFile(output, stripTypeScriptTypes(source, {mode: 'strip'}));
  }
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const loaded = await import(pathToFileURL(join(directory, 'packages/screen/bridge/ScreenBridgeRuntime.js')).href) as {
    createScreenBridgeRuntime: typeof CreateScreenBridgeRuntime;
  };
  return {...loaded, cleanup: () => rm(directory, {recursive: true, force: true})};
}
