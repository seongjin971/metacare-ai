import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Whether this device sends dose photos to the AI for reading: a separate choice from caregiver sharing. */
export type AiPhotoReading = 'on' | 'off';
// v2: the consent text names Anthropic's own retention; a choice made under the earlier text is asked again.
const KEY = 'metacare.ai-photo-reading.v2';
let cached: AiPhotoReading | null | undefined;
// An "off" that could not be saved still stops sending for the rest of this session.
let unsavedOff = false;
const listeners = new Set<(value: AiPhotoReading | null) => void>();

const parse = (raw: string | null): AiPhotoReading | null => raw === 'on' || raw === 'off' ? raw : null;
function remember(value: AiPhotoReading | null) {
  cached = value;
  listeners.forEach(listener => listener(value));
}

/** null means the patient has not chosen yet. `fresh` rereads storage, so a choice made in another tab applies. */
export async function loadAiPhotoReading(options: { fresh?: boolean } = {}): Promise<AiPhotoReading | null> {
  if (cached !== undefined && !options.fresh) return cached;
  try {
    const stored = parse(await AsyncStorage.getItem(KEY));
    remember(unsavedOff ? 'off' : stored);
  } catch {
    if (cached === undefined) remember(null);
  }
  return cached ?? null;
}

/** "off" applies at once even if saving fails; "on" only once it is saved. */
export async function saveAiPhotoReading(value: AiPhotoReading): Promise<void> {
  if (value === 'off') {
    unsavedOff = true;
    remember('off');
  }
  await AsyncStorage.setItem(KEY, value);
  unsavedOff = false;
  if (value === 'on') remember('on');
}

/** undefined while loading, null before the first choice. Follows changes made in other browser tabs. */
export function useAiPhotoReading(): AiPhotoReading | null | undefined {
  const [value, setValue] = useState(cached);
  useEffect(() => {
    let alive = true;
    void loadAiPhotoReading().then(loaded => { if (alive) setValue(loaded); });
    listeners.add(setValue);
    const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) remember(parse(event.newValue)); };
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      listeners.delete(setValue);
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }, []);
  return value;
}
