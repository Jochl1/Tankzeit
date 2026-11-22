// Entscheidungslogik: jetzt tanken oder warten? (Muss zu tools/build_profiles.py::backtest passen.)
import { slotOf, dowOf, SLOT_MIN } from './profile.js';

export const WAIT_THRESHOLD_CT = 1.5;   // Mindest-Ersparnis, damit sich Warten lohnt
export const EXTRA_PER_DAY_CT = 0.7;    // jeder weitere Tag Warten muss sich zusätzlich lohnen
export const HORIZON_DAYS = 7;
export const FUEL_HOURS = [6, 22];      // nur zu "normalen" Zeiten Tanken vorschlagen
const WINDOW_TOL_CT = 0.5;              // Zeitfenster = Slots bis 0,5 ct über dem Minimum
const STEP_MS = SLOT_MIN * 60000;

const inFuelHours = (d) => d.getHours() >= FUEL_HOURS[0] && d.getHours() < FUEL_HOURS[1];

function eventDelta(events, fuel, t) {
  let s = 0;
  for (const e of events || []) {
    if ((!e.fuels || e.fuels.includes(fuel)) && t >= e.fromMs) s += e.delta_ct;
  }
  return s;
}

/** Erwartete Preisänderung (ct/l) relativ zu jetzt, in 30-Min.-Schritten ab der nächsten Slotgrenze. */
export function expectedPath(profiles, sid, fuel, now, events, days = HORIZON_DAYS) {
  const dowEff = profiles.dow(sid, fuel).eff;
  const cache = new Map();
  const hodFor = (d) => {
    const k = dowOf(d);
    if (!cache.has(k)) cache.set(k, profiles.hod(sid, fuel, k));
    return cache.get(k);
  };
  const level = (d) => hodFor(d)[slotOf(d)] + dowEff[dowOf(d)] + eventDelta(events, fuel, d.getTime());
  const p0 = level(now);
  const first = Math.floor(now.getTime() / STEP_MS) * STEP_MS + STEP_MS;
  const out = [{ t: now, delta: 0 }];
  for (let t = first; t <= now.getTime() + days * 86400000; t += STEP_MS) {
    const d = new Date(t);
    out.push({ t: d, delta: level(d) - p0 });
  }
  return out;
}

const daysAhead = (now, t) => (t - now) / 86400000;
const waitPenalty = (now, t) => EXTRA_PER_DAY_CT * Math.max(0, daysAhead(now, t) - 1);

/**
 * @returns {object} Empfehlung inkl. Begründungsdaten für die UI
 */
export function decide({ stations, fuel, profiles, now = new Date(), events = [], tank = 50 }) {
  const priced = stations.filter((s) => s[fuel] != null);
  if (!priced.length) return { kind: 'none', reason: 'noprices' };
  const open = priced.filter((s) => s.isOpen);
  const byPrice = (a, b) => a[fuel] - b[fuel] || a.dist - b.dist;
  const nowBest = open.length ? [...open].sort(byPrice)[0] : null;

  // Bestes zukünftiges Zeitfenster über alle Tankstellen
  let fut = null;
  const paths = new Map();
  for (const s of priced) {
    const path = expectedPath(profiles, s.id, fuel, now, events);
    paths.set(s.id, path);
    for (let k = 1; k < path.length; k++) {
      const { t, delta } = path[k];
      if (!inFuelHours(t)) continue;
      const p = s[fuel] * 100 + delta;
      const score = p + waitPenalty(now, t);
      if (!fut || score < fut.score) fut = { station: s, k, t, price: p, score };
    }
  }

  const avgNearby = open.length ? open.reduce((a, s) => a + s[fuel], 0) / open.length : null;
  const uncertainty = profiles.sources(priced[0].id, fuel).includes('generic') ? 3 : 1.5;

  const nowPriceCt = nowBest ? nowBest[fuel] * 100 : Infinity;
  const savingWait = fut ? nowPriceCt - fut.price : 0;
  const needed = fut ? WAIT_THRESHOLD_CT + waitPenalty(now, fut.t) : Infinity;
  const wait = !nowBest || (fut && savingWait >= needed);

  if (wait && fut) {
    const path = paths.get(fut.station.id);
    const base = fut.station[fuel] * 100;
    const ok = (k) => k > 0 && k < path.length && inFuelHours(path[k].t)
      && path[k].t.getDate() === fut.t.getDate()
      && base + path[k].delta <= fut.price + WINDOW_TOL_CT;
    let a = fut.k, b = fut.k;
    while (ok(a - 1)) a--;
    while (ok(b + 1)) b++;
    const from = path[a].t;
    let to = new Date(path[b].t.getTime() + STEP_MS);
    // Folgt direkt ein Preissprung (z. B. 12 Uhr), Fensterende 5 Min. vorher anzeigen
    if (path[b + 1] && path[b + 1].delta - path[b].delta > 1) to = new Date(to.getTime() - 5 * 60000);
    const saving = Number.isFinite(savingWait) ? savingWait : null;
    // Alternative noch heute (falls die beste Option erst an einem späteren Tag liegt)
    let alt = null;
    if (nowBest && fut.t.getDate() !== now.getDate()) {
      for (const s of priced) {
        const pth = paths.get(s.id);
        for (let k = 1; k < pth.length && pth[k].t.getDate() === now.getDate(); k++) {
          if (!inFuelHours(pth[k].t)) continue;
          const p = s[fuel] * 100 + pth[k].delta;
          if (!alt || p < alt.price) alt = { station: s, t: pth[k].t, price: p };
        }
      }
      if (alt && nowPriceCt - alt.price < WAIT_THRESHOLD_CT) alt = null;
      if (alt) alt.savingCt = nowPriceCt - alt.price;
    }
    return {
      kind: 'wait',
      allClosed: !nowBest,
      station: fut.station,
      nowBest,
      from, to,
      days: Math.floor(daysAhead(new Date(now.getFullYear(), now.getMonth(), now.getDate()), from)),
      expectedPrice: fut.price / 100,
      savingCt: saving,
      savingEur: saving != null ? (saving * tank) / 100 : null,
      uncertainty,
      path: paths.get(fut.station.id),
      chartStation: fut.station,
      avgNearby,
      paths,
      alt,
    };
  }

  // Jetzt tanken: Zeitfenster = bis der erwartete Preis um mehr als 1 ct steigt
  const path = paths.get(nowBest.id);
  let end = null;
  for (let k = 1; k < path.length; k++) {
    if (path[k].delta > 1) { end = new Date(path[k].t.getTime() - 5 * 60000); break; }
  }
  const next24 = path.filter((p, k) => k > 0 && inFuelHours(p.t) && p.t - now <= 86400000);
  const meanLater = next24.length ? next24.reduce((a, p) => a + p.delta, 0) / next24.length : 0;
  const maxGain = fut ? Math.max(0, savingWait) : 0;
  const soonRise = end && end - now < 6 * 3600000;
  const reason = eventAhead(events, fuel, now)
    ? 'event'
    : soonRise ? 'rise'
      : maxGain < 0.5 ? 'cheapest' : 'small-gain';
  return {
    kind: 'now',
    station: nowBest,
    nowBest,
    until: end,
    reason,
    event: eventAhead(events, fuel, now),
    laterMeanCt: meanLater,              // so viel teurer ist es später im Schnitt (24 h)
    savingCt: Math.max(0, meanLater),
    savingEur: (Math.max(0, meanLater) * tank) / 100,
    maxGainWaitingCt: maxGain,           // mögliche Ersparnis durch Warten (unter Schwelle)
    belowAvgCt: avgNearby != null ? (avgNearby - nowBest[fuel]) * 100 : 0,
    uncertainty,
    path,
    chartStation: nowBest,
    avgNearby,
    paths,
  };
}

function eventAhead(events, fuel, now) {
  const t = now.getTime();
  return (events || []).find((e) => (!e.fuels || e.fuels.includes(fuel)) && e.fromMs > t
    && e.fromMs - t < HORIZON_DAYS * 86400000 && e.delta_ct > 0) || null;
}

/** Eigene Trefferquote: frühere Empfehlungen mit später beobachteten Preisen vergleichen. */
export function evaluate(recs, obs) {
  const bySid = new Map();
  for (const o of obs) {
    if (!bySid.has(o.sid)) bySid.set(o.sid, []);
    bySid.get(o.sid).push(o);
  }
  let checked = 0, correct = 0, errSum = 0, errN = 0;
  for (const r of recs) {
    const list = (bySid.get(r.sid) || []).filter((o) => o[r.fuel]);
    if (r.action === 'wait') {
      const hits = list.filter((o) => o.ts >= r.from - 15 * 60000 && o.ts <= r.to + 15 * 60000);
      if (!hits.length) continue;
      const actual = Math.min(...hits.map((o) => o[r.fuel]));
      checked++;
      if (actual < r.priceNow - 0.0005) correct++;
      errSum += Math.abs(actual - r.predicted) * 100; errN++;
    } else {
      const later = list.filter((o) => o.ts > r.ts + 3600000 && o.ts <= r.ts + 86400000 && inFuelHours(new Date(o.ts)));
      if (!later.length) continue;
      checked++;
      if (Math.min(...later.map((o) => o[r.fuel])) * 100 >= r.priceNow * 100 - WAIT_THRESHOLD_CT) correct++;
    }
  }
  return { checked, correct, meanAbsErrCt: errN ? errSum / errN : null, total: recs.length };
}
