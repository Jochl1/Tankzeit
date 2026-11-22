// Preisprofile: allgemeines Startprofil (12-Uhr-Regel) -> optional vorberechnete Kacheln
// -> lokal gelernte Korrekturen aus den eigenen Abfragen (IndexedDB).
export const SLOTS = 48;
export const SLOT_MIN = 30;
export const RULE_START = new Date(2026, 3, 1).getTime(); // 12-Uhr-Regel seit 1.4.2026

const K_REGIONAL = 10;   // Schrumpfung: so viele Beobachtungen braucht ein Slot für "halbes Vertrauen"
const K_STATION = 6;
const K_DOW = 20;
const MIN_DOW_DAYS = 14;

export const slotOf = (d) => Math.floor((d.getHours() * 60 + d.getMinutes()) / SLOT_MIN);
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const zeros = (n) => new Array(n).fill(0);
const deci = (arr) => (arr || []).map((v) => (v == null ? 0 : v / 10));

async function getJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function loadGeneric() {
  return getJSON('data/generic-profile.json');
}

/** Lädt nur die Kacheln (2-stellige PLZ), die für die gefundenen Tankstellen gebraucht werden. */
export async function loadTiles(postCodes) {
  const index = await getJSON('data/profiles/index.json');
  if (!index || !index.tiles) return { index: null, tiles: {} };
  const needed = [...new Set(postCodes.filter(Boolean).map((p) => p.slice(0, 2)))].filter((t) => index.tiles[t]);
  const tiles = {};
  await Promise.all(needed.map(async (t) => {
    const data = await getJSON(`data/profiles/${index.tiles[t].file}`);
    if (data) tiles[t] = data;
  }));
  return { index, tiles };
}

export class Profiles {
  constructor({ generic, tiles = {}, tileIndex = null, learned = null, stationTile = {} }) {
    this.generic = generic;
    this.tiles = tiles;
    this.tileIndex = tileIndex;
    this.learned = learned;          // Ergebnis von learn() für den gewählten Kraftstoff
    this.stationTile = stationTile;  // sid -> Kachel
  }

  /** Basisprofil (ohne gelernte Korrektur) für Tankstelle/Kraftstoff/Wochentag, in ct relativ zum Tagesmittel */
  base(sid, fuel, dow) {
    const tile = this.tiles[this.stationTile[sid]];
    const gen = this.generic.fuels[fuel];
    if (!tile || !tile.regional[fuel]) return gen;
    const reg = deci(tile.regional[fuel].hod_dow).slice(dow * SLOTS, dow * SLOTS + SLOTS);
    const st = tile.stations[sid]?.[fuel];
    if (!st) return reg;
    const w = tile.stations[sid].days / (tile.stations[sid].days + 14);
    const sh = deci(st.hod);
    return reg.map((v, i) => w * sh[i] + (1 - w) * v);
  }

  /** Profil inkl. gelernter Korrektur. */
  hod(sid, fuel, dow) {
    const b = this.base(sid, fuel, dow);
    const L = this.learned;
    if (!L) return b;
    const rc = L.regional;
    const sc = L.stations[sid];
    return b.map((v, i) => v + rc[i] + (sc ? sc[i] : 0));
  }

  /** Wochentagseffekt (7 Werte, Mo=0 … So=6 wie in Python; Umrechnung in dowOf). */
  dow(sid, fuel) {
    const tile = this.tiles[this.stationTile[sid]];
    let eff = zeros(7);
    let src = 'none';
    if (tile?.regional[fuel]) {
      const st = tile.stations[sid]?.[fuel];
      eff = deci(st?.dow?.some((v) => v != null) ? st.dow : tile.regional[fuel].dow);
      src = 'tile';
    }
    if (this.learned?.dow.days >= MIN_DOW_DAYS) {
      const w = src === 'tile' ? 0.3 : 1;
      eff = eff.map((v, i) => (1 - w) * v + w * this.learned.dow.eff[i]);
      src = src === 'tile' ? 'tile+learned' : 'learned';
    }
    return { eff, src };
  }

  sources(sid, fuel) {
    const out = [];
    const tile = this.tiles[this.stationTile[sid]];
    if (tile?.stations[sid]?.[fuel]) out.push('tile-station');
    else if (tile?.regional[fuel]) out.push('tile-regional');
    else out.push('generic');
    if (this.learned && this.learned.n > 0) out.push('learned');
    return out;
  }
}

// Nachbar-Slots teilen Information (halbes Gewicht, ±1 und ±2 mit Viertelgewicht) – aber nie über die
// 12-Uhr-Grenze (Slot 23|24), an der sich der Preis sprunghaft ändert.
const JUMP = 24;
function smooth(a) {
  const out = new Array(SLOTS).fill(0);
  for (let i = 0; i < SLOTS; i++) {
    for (const [o, w] of [[0, 1], [-1, 0.5], [1, 0.5], [-2, 0.25], [2, 0.25]]) {
      const j = (i + o + SLOTS) % SLOTS;
      const crosses = o !== 0 && ((i < JUMP) !== (j < JUMP) || Math.abs(i - j) > 2);
      if (!crosses) out[i] += w * a[j];
    }
  }
  return out;
}

/** Python-Wochentag (Mo=0) aus JS-Datum. */
export const dowOf = (d) => (d.getDay() + 6) % 7;

/**
 * Lernt aus eigenen Beobachtungen Korrekturen zum Basisprofil.
 * Idee: Pro Tankstelle und Tag wird das Preisniveau L geschätzt (Mittel von Preis − Basisprofil).
 * Bleibt eine systematische Abweichung zu bestimmten Uhrzeiten übrig, wird sie (geschrumpft) gelernt.
 */
export function learn(obs, fuel, profiles) {
  const groups = new Map();
  let n = 0;
  for (const o of obs) {
    const p = o[fuel];
    if (!p || o.ts < RULE_START) continue;
    const d = new Date(o.ts);
    const slot = slotOf(d);
    const base = profiles.base(o.sid, fuel, dowOf(d))[slot];
    const key = `${o.sid}|${dayKey(d)}`;
    if (!groups.has(key)) groups.set(key, { sid: o.sid, day: new Date(d.getFullYear(), d.getMonth(), d.getDate()), items: [] });
    groups.get(key).items.push({ slot, v: p * 100 - base });
    n++;
  }
  const regSum = zeros(SLOTS), regN = zeros(SLOTS);
  const st = new Map();
  const levels = new Map(); // sid -> [{t, L}]
  for (const g of groups.values()) {
    const L = g.items.reduce((a, b) => a + b.v, 0) / g.items.length;
    if (!levels.has(g.sid)) levels.set(g.sid, []);
    levels.get(g.sid).push({ t: g.day.getTime(), dow: dowOf(g.day), L });
    if (new Set(g.items.map((i) => i.slot)).size < 2) continue;
    if (!st.has(g.sid)) st.set(g.sid, { sum: zeros(SLOTS), n: zeros(SLOTS) });
    const s = st.get(g.sid);
    for (const it of g.items) {
      const r = it.v - L;
      regSum[it.slot] += r; regN[it.slot]++;
      s.sum[it.slot] += r; s.n[it.slot]++;
    }
  }
  const [rS, rN] = [smooth(regSum), smooth(regN)];
  const regional = rS.map((v, i) => v / (rN[i] + K_REGIONAL));
  const stations = {};
  for (const [sid, s] of st) {
    // Tankstellen-Korrektur relativ zur regionalen Korrektur
    const [sS, sN] = [smooth(s.sum), smooth(s.n)];
    stations[sid] = sS.map((v, i) => (v - sN[i] * regional[i]) / (sN[i] + K_STATION));
  }

  // Wochentagseffekt: Tagesniveau ggü. Mittel der Nachbartage (±3) derselben Tankstelle
  const dowSum = zeros(7), dowN = zeros(7);
  const days = new Set();
  for (const series of levels.values()) {
    series.sort((a, b) => a.t - b.t);
    for (const x of series) {
      const nb = series.filter((y) => Math.abs(y.t - x.t) <= 3.5 * 86400000);
      if (nb.length < 3) continue;
      const m = nb.reduce((a, b) => a + b.L, 0) / nb.length;
      dowSum[x.dow] += x.L - m; dowN[x.dow]++;
      days.add(x.t);
    }
  }
  const eff = dowSum.map((v, i) => v / (dowN[i] + K_DOW));
  return {
    n,
    regional,
    regionalN: regN,
    stations,
    dow: { eff, days: days.size, n: dowN },
    daysObserved: new Set([...groups.values()].map((g) => g.day.getTime())).size,
  };
}
