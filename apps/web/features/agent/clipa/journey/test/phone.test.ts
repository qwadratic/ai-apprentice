import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canShareScreen, canUseCamera, capturePath, detectCapabilities } from '../capabilities.ts';
import { flush, rig } from './helpers.ts';

describe('capability checks', () => {
  const desktop = { mediaDevices: { getDisplayMedia() {}, getUserMedia() {} } };
  const phone = { mediaDevices: { getUserMedia() {} } };
  const insecure = {};

  it('a laptop can share the screen and use the camera', () => {
    assert.equal(canShareScreen(desktop), true);
    assert.equal(canUseCamera(desktop), true);
    assert.equal(capturePath(detectCapabilities(desktop)), 'screen');
  });

  it('a phone has the camera but cannot share the screen', () => {
    assert.equal(canShareScreen(phone), false);
    assert.equal(canUseCamera(phone), true);
    assert.equal(capturePath(detectCapabilities(phone)), 'camera');
  });

  it('a page without mediaDevices (insecure context, old browser, no navigator) can do neither', () => {
    assert.equal(canShareScreen(insecure), false);
    assert.equal(canUseCamera(insecure), false);
    assert.equal(canShareScreen(undefined), false);
    assert.equal(capturePath(detectCapabilities(insecure)), 'none');
  });
});

describe('the phone path', () => {
  it('says plainly that the device cannot share a screen: the camera is not offered unless the shell has a camera source', async () => {
    const { play, director, clock, journey } = rig({ capabilities: { screen: false, camera: false } });
    await play({ type: 'app_ready' });
    assert.deepEqual(director.points, ['-'], 'no control to fly to');
    assert.match(director.lines[0] ?? '', /can't share a screen/);
    assert.match(director.lines[0] ?? '', /laptop/);
    assert.doesNotMatch(director.lines[0] ?? '', /camera/);
    director.clear();
    clock.advance(10 * 60 * 1000);
    await flush();
    assert.deepEqual(director.calls, [], 'no nudge: there is nothing the person can click');
    assert.equal(journey.getSnapshot().capture, 'none');
  });

  it('a phone without the camera opt-in gets the same honest message from the default detection', async () => {
    // The default capability check: a page without getDisplayMedia, camera not opted in.
    const { play, director, journey } = rig({ capabilities: undefined, camera: false });
    const snap = journey.getSnapshot();
    // In node there is no navigator.mediaDevices, so this is also the "no device support" case.
    assert.equal(snap.capture, 'none');
    await play({ type: 'app_ready' });
    assert.match(director.lines[0] ?? '', /laptop/);
  });

  it('offers the camera only when the shell says it has a camera source', async () => {
    const { play, director, journey } = rig({ capabilities: { screen: false, camera: true } });
    await play({ type: 'app_ready' });
    assert.match(director.lines[0] ?? '', /point the camera at your screen/);
    assert.equal(journey.getSnapshot().capture, 'camera');
    await play({ type: 'session_live', mode: 'learn' });
    assert.equal(director.points.at(-1), 'use-camera');
    await play({ type: 'camera_capturing' });
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('keeps the desktop wording on a laptop', async () => {
    const { play, director } = rig({ capabilities: { screen: true, camera: false } });
    await play({ type: 'app_ready' });
    assert.deepEqual(director.points, ['session-start']);
    assert.match(director.lines[0] ?? '', /share the window you work in/);
  });

  it('offers the camera after a refused picker only when a camera exists, and only a retry otherwise', async () => {
    const withCamera = rig({ capabilities: { screen: true, camera: true } });
    await withCamera.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_unavailable', reason: 'denied' });
    assert.match(withCamera.director.lines.at(-1) ?? '', /or use the camera/);

    const screenOnly = rig({ capabilities: { screen: true, camera: false } });
    await screenOnly.play({ type: 'app_ready' }, { type: 'session_live', mode: 'learn' }, { type: 'screen_unavailable', reason: 'denied' });
    assert.doesNotMatch(screenOnly.director.lines.at(-1) ?? '', /camera/);
  });

  it('switches to the plain wording when the shell finds out screen sharing is unsupported', async () => {
    const { play, director, journey } = rig({ capabilities: { screen: true, camera: false } });
    await play({ type: 'app_ready' });
    await play({ type: 'screen_unavailable', reason: 'unsupported' });
    assert.equal(journey.getSnapshot().capture, 'none');
    assert.match(director.lines.at(-1) ?? '', /laptop/);
  });
});
