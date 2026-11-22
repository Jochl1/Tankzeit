// Live-Abfragen direkt aus dem Browser: Tankerkönig (Preise) und Nominatim (PLZ/Ort -> Koordinaten).
const TK = 'https://creativecommons.tankerkoenig.de/json/list.php';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export const MIN_INTERVAL_MS = 60 * 1000;        // API-Limit laut Tankerkönig: ca. 1 Abfrage/Minute
export const CACHE_MS = 5 * 60 * 1000;           // automatische Aktualisierung höchstens alle 5 Minuten
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidKey = (k) => KEY_RE.test((k || '').trim());

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'key' | 'limit' | 'network' | 'server' | 'nolocation'
  }
}

function translate(msg = '') {
  const m = msg.toLowerCase();
  if (m.includes('apikey') || m.includes('api-key') || m.includes('api key'))
    return new ApiError('key', 'Der API-Key wurde abgelehnt. Bitte in den Einstellungen prüfen.');
  if (m.includes('limit') || m.includes('too many') || m.includes('zu viele'))
    return new ApiError('limit', 'Tankerkönig meldet zu viele Abfragen. Bitte ein paar Minuten warten.');
  if (m.includes('radius') || m.includes('rad'))
    return new ApiError('server', 'Der Suchradius ist ungültig (maximal 25 km).');
  return new ApiError('server', `Tankerkönig meldet einen Fehler: ${msg || 'unbekannt'}`);
}

/** Tankstellen im Umkreis mit allen drei Preisen. */
export async function fetchStations({ lat, lng, radius, apiKey }) {
  const url = `${TK}?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&rad=${Math.min(25, radius)}&sort=dist&type=all&apikey=${encodeURIComponent(apiKey.trim())}`;
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new ApiError('network', 'Keine Verbindung zu Tankerkönig. Bist du offline?');
  }
  if (res.status === 429 || res.status === 503) throw new ApiError('limit', 'Tankerkönig ist gerade überlastet oder meldet ein Abfragelimit. Bitte später erneut versuchen.');
  if (!res.ok) throw new ApiError('server', `Tankerkönig antwortet mit Fehler ${res.status}.`);
  let data;
  try { data = await res.json(); } catch { throw new ApiError('server', 'Antwort von Tankerkönig ist unlesbar.'); }
  if (!data.ok) throw translate(data.message);
  return (data.stations || []).map(normalize);
}

const num = (v) => (typeof v === 'number' && v > 0.5 ? v : null);

function normalize(s) {
  return {
    id: s.id,
    name: (s.name || '').trim(),
    brand: (s.brand || '').trim(),
    street: [s.street, s.houseNumber].filter(Boolean).join(' ').trim(),
    place: (s.place || '').trim(),
    postCode: s.postCode != null ? String(s.postCode).padStart(5, '0') : '',
    lat: s.lat,
    lng: s.lng,
    dist: s.dist,
    isOpen: !!s.isOpen,
    e5: num(s.e5),
    e10: num(s.e10),
    diesel: num(s.diesel),
  };
}

/** PLZ oder Ortsname -> { lat, lng, label } */
export async function geocode(query) {
  const q = query.trim();
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'de', 'accept-language': 'de', addressdetails: '1' });
  if (/^\d{5}$/.test(q)) params.set('postalcode', q); else params.set('q', q);
  let res;
  try {
    res = await fetch(`${NOMINATIM}?${params}`);
  } catch {
    throw new ApiError('network', 'Ortssuche nicht erreichbar. Bist du offline?');
  }
  if (!res.ok) throw new ApiError('server', 'Die Ortssuche ist gerade nicht verfügbar.');
  const [hit] = await res.json();
  if (!hit) throw new ApiError('nolocation', `„${q}“ wurde nicht gefunden.`);
  const a = hit.address || {};
  const town = a.city || a.town || a.village || a.municipality || a.suburb || '';
  const label = [a.postcode || (/^\d{5}$/.test(q) ? q : ''), town].filter(Boolean).join(' ') || hit.display_name.split(',')[0];
  return { lat: +hit.lat, lng: +hit.lon, label };
}

/** Geolocation als Promise mit deutschen Fehlermeldungen. */
export function locate() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new ApiError('nolocation', 'Dein Browser unterstützt keine Standortabfrage.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new ApiError('nolocation', e.code === 1
        ? 'Standortfreigabe abgelehnt. Gib stattdessen eine PLZ oder einen Ort ein.'
        : 'Standort konnte nicht ermittelt werden. Gib stattdessen eine PLZ oder einen Ort ein.')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60 * 1000 },
    );
  });
}
