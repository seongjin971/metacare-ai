import { careRequest } from '../shared/care-api';
import { normalizePouchReading, parsePouchImage, POUCH_READ_PATH, type PouchReading } from '../shared/pouch-reading';

/** Sends one camera photo to the sharing server's AI route. Nothing is stored there. */
export async function requestPouchReading(imageDataUri: string): Promise<PouchReading | null> {
  // Fails here, before any upload, for a photo the route would refuse.
  parsePouchImage(imageDataUri);
  const result = await careRequest<{ reading?: unknown }>(POUCH_READ_PATH, { method: 'POST', body: { image: imageDataUri }, timeoutMs: 30_000 });
  return result?.reading == null ? null : normalizePouchReading(result.reading);
}
