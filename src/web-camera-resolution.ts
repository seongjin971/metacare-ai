type TrackLike = {
  applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
  getConstraints?: () => MediaTrackConstraints;
};
type VideoLike = { srcObject?: { getVideoTracks?: () => TrackLike[] } | null };

const WIDTH = 1920;
const HEIGHT = 1080;
/** Same short side as the installed app's smallest picture size; pouch text stays legible. */
export const SHARP_WEB_CAMERA: MediaTrackConstraints = { width: { ideal: WIDTH }, height: { ideal: HEIGHT } };

function liveTrack(container: unknown): TrackLike | undefined {
  const find = (container as { querySelector?: (selector: string) => unknown } | null)?.querySelector;
  const video = typeof find === 'function' ? find.call(container, 'video') as VideoLike | null : null;
  return video?.srcObject?.getVideoTracks?.()[0];
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Chrome reports `{ ideal: 1920 }` back as a bare `1920`. */
function idealOf(value: unknown): unknown {
  return typeof value === 'number' ? value : (value as { ideal?: unknown } | undefined)?.ideal;
}

function hasSharpRequest(track: TrackLike): boolean {
  const current = track.getConstraints?.();
  return idealOf(current?.width) === WIDTH && idealOf(current?.height) === HEIGHT;
}

async function applyWithin(track: TrackLike, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // Only the size: Chromium hands a call that also carries image-capture members (expo's focusMode,
      // torch) to ImageCapture, which drops width/height. Those members stay applied separately.
      track.applyConstraints!(SHARP_WEB_CAMERA),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    // The default resolution still records a usable photo.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * expo-camera starts the browser camera at the browser's default size, often 640×480. Ask the live
 * preview track inside `container` for a sharper frame. If the browser refuses or does not answer
 * in time, the camera keeps working at its default size.
 */
export async function sharpenWebCamera(container: unknown, timeoutMs = 2000): Promise<void> {
  const track = liveTrack(container);
  if (typeof track?.applyConstraints !== 'function') return;
  // One animation frame after the video's metadata loads, expo-camera applies its own constraint
  // set, which replaces any earlier request. Ask after that, and once more if it was replaced anyway.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await nextFrame();
    await nextFrame();
    if (hasSharpRequest(track)) return;
    await applyWithin(track, timeoutMs);
  }
}
