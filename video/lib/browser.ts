// Finds a Chromium-family browser that is already on this machine, so that nothing has to be
// downloaded. Used by the renderer (render.ts, remotion.config.ts) and by the recorder.
//
// Order: REMOTION_BROWSER_EXECUTABLE, then CHROMIUM_EXECUTABLE, then a Playwright browser cache
// (headless shell first), then common system installs. If nothing is found the result is null:
// Remotion then downloads its own headless shell on first render, and the recorder asks for
// `npx playwright-core install chromium` or an executable path.
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BrowserKind = 'headless-shell' | 'chrome';
export type BrowserChoice = { executable: string; kind: BrowserKind; source: string };

const kindOf = (executable: string): BrowserKind =>
  /headless[_-]shell/i.test(executable) ? 'headless-shell' : 'chrome';

const newestDirs = (root: string, pattern: RegExp): string[] => {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
    .map((name) => path.join(root, name));
};

const playwrightCaches = (): string[] =>
  [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter((p): p is string => Boolean(p) && p !== '0');

export const resolveBrowser = (): BrowserChoice | null => {
  for (const name of ['REMOTION_BROWSER_EXECUTABLE', 'CHROMIUM_EXECUTABLE']) {
    const value = process.env[name];
    if (value) return { executable: value, kind: kindOf(value), source: name };
  }

  for (const cache of playwrightCaches()) {
    for (const dir of newestDirs(cache, /^chromium_headless_shell-\d+$/)) {
      for (const rel of ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const file = path.join(dir, rel);
        if (existsSync(file)) return { executable: file, kind: 'headless-shell', source: `playwright cache ${cache}` };
      }
    }
  }
  for (const cache of playwrightCaches()) {
    for (const dir of newestDirs(cache, /^chromium-\d+$/)) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const file = path.join(dir, rel);
        if (existsSync(file)) return { executable: file, kind: 'chrome', source: `playwright cache ${cache}` };
      }
    }
  }

  const system = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const file of system) {
    if (existsSync(file)) return { executable: file, kind: 'chrome', source: 'system install' };
  }
  return null;
};
