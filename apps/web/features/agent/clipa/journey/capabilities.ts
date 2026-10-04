/*
 * What this device can capture. A phone has no getDisplayMedia, but its rear camera can look at a screen.
 * Both checks take the navigator as a parameter so node tests can pass a fake.
 */

interface MediaNavigator {
  mediaDevices?: { getDisplayMedia?: unknown; getUserMedia?: unknown } | undefined;
}

function defaultNavigator(): MediaNavigator | undefined {
  try {
    return (globalThis as { navigator?: MediaNavigator }).navigator;
  } catch {
    return undefined;
  }
}

/** True when the browser can open the screen or window picker. */
export function canShareScreen(nav: MediaNavigator | undefined = defaultNavigator()): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
}

/** True when the browser can open a camera (it needs a secure context, which the Pages app has). */
export function canUseCamera(nav: MediaNavigator | undefined = defaultNavigator()): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function';
}

export interface CaptureCapabilities {
  screen: boolean;
  camera: boolean;
}

export type CapturePath = 'screen' | 'camera' | 'none';

export function detectCapabilities(nav: MediaNavigator | undefined = defaultNavigator()): CaptureCapabilities {
  return { screen: canShareScreen(nav), camera: canUseCamera(nav) };
}

/** The best way to share on this device: the screen, else the camera, else nothing. */
export function capturePath(caps: CaptureCapabilities): CapturePath {
  if (caps.screen) return 'screen';
  return caps.camera ? 'camera' : 'none';
}
