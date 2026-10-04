import { useShell, useShellState } from '../hooks.ts';

export function Banner() {
  const { controller } = useShell();
  const banner = useShellState((s) => s.banner);
  if (!banner) return null;
  return (
    <div className={`as-banner as-banner--${banner.kind}`} role={banner.kind === 'error' ? 'alert' : 'status'} data-testid="banner">
      <span className="as-banner__text">{banner.text}</span>
      <button type="button" className="as-btn as-btn--small" onClick={() => controller.dismissBanner()}>Dismiss</button>
    </div>
  );
}
