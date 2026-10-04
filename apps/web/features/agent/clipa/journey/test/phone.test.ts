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
  it('offers the camera when the device cannot share a screen', async () => {
    const { bus, director, journey } = rig({ capabilities: { screen: false, camera: true } });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.points, ['use-camera']);
    assert.match(director.lines[0] ?? '', /point the camera at your screen/);
    assert.equal(journey.getSnapshot().capture, 'camera');
    bus.emit({ type: 'share_requested' });
    await flush();
    assert.equal(director.points.at(-1), 'use-camera', 'the next step keeps pointing at the camera button');
    bus.emit({ type: 'camera_capturing' });
    await flush();
    assert.equal(journey.getSnapshot().stepId, 'learn');
  });

  it('says plainly that the device cannot share when there is neither screen nor camera', async () => {
    const { bus, director, clock, journey } = rig({ capabilities: { screen: false, camera: false } });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.points, ['-'], 'no control to fly to');
    assert.match(director.lines[0] ?? '', /can't share a screen or camera/);
    assert.match(director.lines[0] ?? '', /laptop/);
    director.clear();
    clock.advance(10 * 60 * 1000);
    await flush();
    assert.deepEqual(director.calls, [], 'no nudge: there is nothing the person can click');
    assert.equal(journey.getSnapshot().capture, 'none');
  });

  it('keeps the desktop wording on a laptop', async () => {
    const { bus, director } = rig({ capabilities: { screen: true, camera: true } });
    bus.emit({ type: 'session_started' });
    await flush();
    assert.deepEqual(director.points, ['share-screen']);
    assert.match(director.lines[0] ?? '', /share the window you work in/);
  });

  it('offers the camera after a refused picker when a camera exists, and only a retry otherwise', async () => {
    const withCamera = rig({ capabilities: { screen: true, camera: true } });
    withCamera.bus.emit({ type: 'session_started' });
    withCamera.bus.emit({ type: 'share_requested' });
    await flush();
    withCamera.bus.emit({ type: 'screen_unavailable', reason: 'denied' });
    await flush();
    assert.match(withCamera.director.lines.at(-1) ?? '', /or use the camera/);

    const screenOnly = rig({ capabilities: { screen: true, camera: false } });
    screenOnly.bus.emit({ type: 'session_started' });
    screenOnly.bus.emit({ type: 'share_requested' });
    await flush();
    screenOnly.bus.emit({ type: 'screen_unavailable', reason: 'denied' });
    await flush();
    assert.doesNotMatch(screenOnly.director.lines.at(-1) ?? '', /camera/);
  });

  it('switches to the camera wording when the shell finds out screen sharing is unsupported', async () => {
    const { bus, director, journey } = rig({ capabilities: { screen: true, camera: true } });
    bus.emit({ type: 'session_started' });
    await flush();
    bus.emit({ type: 'screen_unavailable', reason: 'unsupported' });
    await flush();
    assert.equal(journey.getSnapshot().capture, 'camera');
    assert.equal(director.points.at(-1), 'use-camera');
  });
});
