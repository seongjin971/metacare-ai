import { validateLoadedState, type AppState } from './domain.ts';

/**
 * Changing the preferred clinic, editing a visit and recording a dose are independent writes.
 * Each group is taken from whichever browser tab saved it last.
 */
export function mergeNewerVisitData(state: AppState, saved: AppState): AppState {
  let next = state;
  if (saved.visitsRevision > state.visitsRevision) {
    next = { ...next, visits: saved.visits, visitsRevision: saved.visitsRevision };
  }
  if (saved.hospitalContactsRevision > state.hospitalContactsRevision) {
    next = { ...next, hospitalContact: saved.hospitalContact, otherHospitalContacts: saved.otherHospitalContacts,
      hospitalContactsRevision: saved.hospitalContactsRevision };
  }
  if (saved.dosesRevision > state.dosesRevision) {
    // A day the saved state has not reached yet holds only that day's generated, unrecorded rows.
    const savedDays = new Set(saved.doses.map(dose => dose.date));
    const laterDays = state.doses.filter(dose => !savedDays.has(dose.date) && dose.status === 'pending');
    next = { ...next, doses: [...saved.doses, ...laterDays], medicationSchedule: saved.medicationSchedule,
      dosesRevision: saved.dosesRevision };
  }
  return next;
}

export async function writeWebState(
  key: string,
  state: AppState,
  change?: (state: AppState) => AppState,
  replaceUnreadable = false,
): Promise<AppState> {
  const write = () => {
    // AsyncStorage web uses this same localStorage key. Keep the read and write
    // together so neither a visit nor a clinic selection is lost to a stale tab.
    const raw = window.localStorage.getItem(key);
    let base = state;
    if (raw !== null) {
      try { base = mergeNewerVisitData(state, validateLoadedState(JSON.parse(raw))); }
      catch (error) { if (!replaceUnreadable) throw error; }
    }
    const next = change ? change(base) : base;
    window.localStorage.setItem(key, JSON.stringify(next));
    return next;
  };
  // An async callback turns a rejected change into a rejected lock request, which releases the lock.
  return window.navigator.locks ? window.navigator.locks.request(key, async () => write()) : write();
}

/** The saved state, or null when there is none or it cannot be read. */
export function readWebState(key: string): AppState | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : validateLoadedState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function onWebVisitDataChanged(key: string, accept: (saved: AppState) => void) {
  const listener = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage || event.key !== key || !event.newValue) return;
    try { accept(validateLoadedState(JSON.parse(event.newValue))); }
    catch { /* A malformed write in another tab cannot replace local records. */ }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
