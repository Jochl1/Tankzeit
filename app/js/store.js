// Einstellungen (localStorage) und eigene Preisbeobachtungen (IndexedDB).
const SETTINGS_KEY = 'tz-settings';
const THEME_KEY = 'tz-theme';
const LAST_KEY = 'tz-last-result';

export const DEFAULTS = Object.freeze({
  apiKey: '',
  demo: false,
  fuel: 'e10',
  radius: 5,
  tank: 50,
  location: null, // { lat, lng, label, source: 'gps' | 'plz' }
});

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try {
    if (val == null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch { /* privater Modus o. Ä. – App funktioniert trotzdem */ }
}

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(safeGet(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(s) {
  safeSet(SETTINGS_KEY, JSON.stringify(s));
}

/** 'light' | 'dark' | 'auto' */
export const getThemeChoice = () => safeGet(THEME_KEY) || 'auto';
export const setThemeChoice = (v) => safeSet(THEME_KEY, v === 'auto' ? null : v);

export function loadLast() {
  try { return JSON.parse(safeGet(LAST_KEY) || 'null'); } catch { return null; }
}
export const saveLast = (r) => safeSet(LAST_KEY, r ? JSON.stringify(r) : null);

export function clearAll() {
  for (const k of [SETTINGS_KEY, LAST_KEY]) safeSet(k, null);
}

// ------------------------------------------------------------- IndexedDB

const DB_NAME = 'tankzeit';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IndexedDB nicht verfügbar'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('obs')) {
        const s = d.createObjectStore('obs', { keyPath: ['sid', 'ts'] });
        s.createIndex('ts', 'ts');
      }
      if (!d.objectStoreNames.contains('recs')) {
        d.createObjectStore('recs', { keyPath: 'ts' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

/** Preise einer Abfrage speichern (eine Zeile pro Tankstelle). */
export async function addObservations(stations, ts) {
  const rows = stations
    .filter((s) => s.e5 || s.e10 || s.diesel)
    .map((s) => ({ sid: s.id, ts, e5: s.e5 || null, e10: s.e10 || null, diesel: s.diesel || null, open: !!s.isOpen }));
  if (!rows.length) return 0;
  try {
    await tx('obs', 'readwrite', (s) => rows.forEach((r) => s.put(r)));
  } catch { return 0; }
  return rows.length;
}

/** Alle Beobachtungen seit `since` (ms). */
export async function getObservations(since) {
  try {
    return await tx('obs', 'readonly', (s) => s.index('ts').getAll(IDBKeyRange.lowerBound(since)));
  } catch { return []; }
}

export async function addRecommendation(rec) {
  try { await tx('recs', 'readwrite', (s) => s.put(rec)); } catch { /* egal */ }
}
export async function getRecommendations() {
  try { return await tx('recs', 'readonly', (s) => s.getAll()); } catch { return []; }
}

export async function clearDatabase() {
  try {
    await tx('obs', 'readwrite', (s) => s.clear());
    await tx('recs', 'readwrite', (s) => s.clear());
  } catch { /* egal */ }
}

export async function countObservations() {
  try { return await tx('obs', 'readonly', (s) => s.count()); } catch { return 0; }
}
