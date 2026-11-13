import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARP_WEB_CAMERA, sharpenWebCamera } from '../src/web-camera-resolution.ts';

function stageWith(track: object | undefined) {
  const video = { srcObject: { getVideoTracks: () => (track ? [track] : []) } };
  return { querySelector: (selector: string) => (selector === 'video' ? video : null) };
}

/** A camera track that, like a browser's, keeps the most recently applied constraints. */
function cameraTrack(initial: MediaTrackConstraints) {
  let current = initial;
  const applied: MediaTrackConstraints[] = [];
  return {
    applied,
    replace(next: MediaTrackConstraints) { current = next; },
    getConstraints: () => current,
    applyConstraints: async (constraints: MediaTrackConstraints) => { applied.push(constraints); current = constraints; },
  };
}

test('the live web camera track is asked for a sharper frame with the size alone', async () => {
  // Mixing the size into the track's image-capture constraints makes Chromium drop the size.
  const track = cameraTrack({ facingMode: { ideal: 'environment' }, advanced: [{ frameRate: 30 }] });
  await sharpenWebCamera(stageWith(track));
  assert.deepEqual(track.applied, [SHARP_WEB_CAMERA]);
});

test('a request that expo-camera replaces right after is made once more', async () => {
  const track = cameraTrack({});
  const first = track.applyConstraints;
  track.applyConstraints = async constraints => {
    await first(constraints);
    // expo-camera re-applies only its own advanced constraints once the video's metadata loads.
    if (track.applied.length === 1) setTimeout(() => track.replace({ advanced: [{}] }), 0);
  };
  await sharpenWebCamera(stageWith(track));
  assert.deepEqual(track.applied, [SHARP_WEB_CAMERA, SHARP_WEB_CAMERA]);
  assert.deepEqual(track.getConstraints(), SHARP_WEB_CAMERA);
});

test('a request the browser reports back in its short form is not repeated', async () => {
  const track = cameraTrack({});
  const first = track.applyConstraints;
  // Chrome returns { ideal: 1920 } from getConstraints() as a bare 1920.
  track.applyConstraints = async constraints => { await first(constraints); track.replace({ width: 1920, height: 1080 }); };
  await sharpenWebCamera(stageWith(track));
  assert.equal(track.applied.length, 1);
  const already = cameraTrack({ width: 1920, height: { ideal: 1080 } });
  await sharpenWebCamera(stageWith(already));
  assert.equal(already.applied.length, 0);
});

test('a missing, refusing or silent camera keeps its default size without failing', async () => {
  await sharpenWebCamera(null);
  await sharpenWebCamera({});
  await sharpenWebCamera({ querySelector: () => null });
  await sharpenWebCamera(stageWith(undefined));
  await sharpenWebCamera(stageWith({ applyConstraints: async () => { throw new Error('OverconstrainedError'); } }));
  const started = Date.now();
  await sharpenWebCamera(stageWith({ applyConstraints: () => new Promise<void>(() => undefined) }), 20);
  assert.ok(Date.now() - started < 1000);
});
