// Inter and JetBrains Mono come from npm (@fontsource), so rendering needs no network. The
// render waits until the faces are ready; otherwise the first frames could use a fallback font.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import { cancelRender, continueRender, delayRender } from 'remotion';

if (typeof document !== 'undefined' && document.fonts) {
  const handle = delayRender('Loading Inter and JetBrains Mono');
  Promise.all([
    document.fonts.load('400 40px Inter'),
    document.fonts.load('500 40px Inter'),
    document.fonts.load('600 40px Inter'),
    document.fonts.load('700 40px Inter'),
    document.fonts.load('800 40px Inter'),
    document.fonts.load('500 24px "JetBrains Mono"'),
  ])
    .then(() => continueRender(handle))
    .catch((error: unknown) => cancelRender(error));
}
