// Headless render. Bundles the compositions, picks the browser that is already on this machine
// (see lib/browser.ts) and writes an MP4 (or a PNG with --still) into out/.
//
//   npm run render:sample
//   npm run render -- TitleCard
//   npm run render -- Sample --script scripts/my-video.json --out out/my-video.mp4
//   npm run still -- LayersDiagram --frame 300
//
// Without a composition id it lists the ids.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { resolveBrowser } from './lib/browser';

const root = path.dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    script: { type: 'string' },
    out: { type: 'string' },
    still: { type: 'boolean', default: false },
    frame: { type: 'string', default: '0' },
    concurrency: { type: 'string' },
    crf: { type: 'string', default: '16' },
    scale: { type: 'string', default: '1' },
    'image-format': { type: 'string', default: 'png' },
    help: { type: 'boolean', default: false },
  },
});

const kebab = (id: string): string => id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Every `src` string in the props that points at a local file must exist under assets/. */
const missingAssets = (props: unknown): string[] => {
  const missing: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'src' && typeof inner === 'string' && !/^https?:\/\//i.test(inner)) {
          if (!existsSync(path.join(root, 'assets', inner))) missing.push(inner);
        } else visit(inner);
      }
    }
  };
  visit(props);
  return missing;
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const main = async (): Promise<void> => {
  const browser = resolveBrowser();
  console.log(
    browser
      ? `Browser: ${browser.executable} (${browser.kind}, from ${browser.source})`
      : 'Browser: none found, Remotion will download its own headless shell.',
  );
  const browserOptions = {
    browserExecutable: browser?.executable ?? null,
    chromeMode: browser?.kind === 'chrome' ? ('chrome-for-testing' as const) : ('headless-shell' as const),
    logLevel: 'warn' as const,
  };

  const started = Date.now();
  process.stdout.write('Bundling ');
  let lastPct = -1;
  const serveUrl = await bundle({
    entryPoint: path.join(root, 'src', 'index.ts'),
    publicDir: path.join(root, 'assets'),
    onProgress: (pct) => {
      if (pct - lastPct >= 25) {
        process.stdout.write(`${pct}% `);
        lastPct = pct;
      }
    },
  });
  console.log(`done in ${seconds(Date.now() - started)}`);

  const id = positionals[0];
  if (!id || values.help) {
    const all = await getCompositions(serveUrl, { ...browserOptions });
    console.log('Compositions:');
    for (const c of all) console.log(`  ${c.id}  ${c.width}x${c.height} @${c.fps} fps, ${(c.durationInFrames / c.fps).toFixed(1)} s`);
    console.log('Usage: npm run render -- <Id> [--script file.json] [--out file.mp4] [--concurrency N] [--crf 16]');
    console.log('       npm run still -- <Id> [--frame N] [--script file.json] [--out file.png]');
    return;
  }

  const inputProps = values.script
    ? (JSON.parse(readFileSync(path.resolve(values.script), 'utf8')) as Record<string, unknown>)
    : {};
  const composition = await selectComposition({ serveUrl, id, inputProps, ...browserOptions });
  const missing = missingAssets(composition.props);
  if (missing.length > 0) {
    const hints = missing.map((file) => {
      const walkthrough = /^recordings\/(.+)\.mp4$/.exec(file)?.[1];
      return walkthrough && existsSync(path.join(root, 'recorder', 'walkthroughs', `${walkthrough}.json`))
        ? `  ${file}: record it with "npm run record -- ${walkthrough}"`
        : `  ${file}: not found, fix the script or add the file`;
    });
    console.error(`Missing file(s) under assets/ (the recordings are not in git):\n${hints.join('\n')}`);
    process.exit(1);
  }

  mkdirSync(path.join(root, 'out'), { recursive: true });
  const scale = Number(values.scale);
  const common = { serveUrl, composition, inputProps, ...browserOptions };

  if (values.still) {
    const output = path.resolve(values.out ?? path.join(root, 'out', `${kebab(id)}.png`));
    await renderStill({ ...common, output, frame: Number(values.frame), scale, imageFormat: 'png', overwrite: true });
    console.log(`Still: ${output} (${(statSync(output).size / 1024).toFixed(0)} KB)`);
    return;
  }

  const output = path.resolve(values.out ?? path.join(root, 'out', `${kebab(id)}.mp4`));
  const renderStarted = Date.now();
  let lastLogged = -1;
  await renderMedia({
    ...common,
    outputLocation: output,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    crf: Number(values.crf),
    scale,
    imageFormat: values['image-format'] === 'jpeg' ? ('jpeg' as const) : ('png' as const),
    jpegQuality: 95,
    concurrency: values.concurrency ? Number(values.concurrency) : null,
    // Long product clips played fast need more than the default 30 s for a frame on a busy 4-core machine.
    timeoutInMilliseconds: 180_000,
    // Keep the decoded-frame cache small: two renders side by side otherwise fill the memory of a 16 GB machine.
    offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
    overwrite: true,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== lastLogged) {
        lastLogged = pct;
        process.stdout.write(`${pct}% `);
      }
    },
  });
  console.log(`\nRendered ${id}: ${composition.width}x${composition.height} @${composition.fps} fps, ${(composition.durationInFrames / composition.fps).toFixed(1)} s`);
  console.log(`Output: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(2)} MB), render took ${seconds(Date.now() - renderStarted)}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
