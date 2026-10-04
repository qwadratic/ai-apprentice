// Config for `npx remotion studio` and `npx remotion render`. `npm run render` (render.ts)
// sets the same options in code. See README.md.
import { Config } from '@remotion/cli/config';
import { resolveBrowser } from './lib/browser';

Config.setEntryPoint('./src/index.ts');
Config.setPublicDir('./assets');
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

const browser = resolveBrowser();
if (browser) {
  Config.setBrowserExecutable(browser.executable);
  Config.setChromeMode(browser.kind === 'headless-shell' ? 'headless-shell' : 'chrome-for-testing');
}
