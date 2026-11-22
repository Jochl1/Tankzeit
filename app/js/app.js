// Tanken oder Warten? – App-Steuerung
import * as fmt from './format.js';
import * as store from './store.js';
import { fetchStations, geocode, locate, isValidKey, ApiError, MIN_INTERVAL_MS, CACHE_MS } from './api.js';
import { loadGeneric, loadTiles, Profiles, learn, RULE_START, dowOf } from './profile.js';
import { decide, evaluate, WAIT_THRESHOLD_CT } from './decision.js';
import { lineChart, barChart, legend } from './charts.js';
import { demoStations, DEMO_LOCATION } from './demo.js';

const $ = (id) => document.getElementById(id);
const FUEL_NAME = { e5: 'Super E5', e10: 'Super E10', diesel: 'Diesel' };
const STALE_MS = 30 * 60 * 1000;
const corrText = (c) => (Math.abs(c ?? 0) < 0.05 ? '≈ 0' : fmt.num1(c).replace('-', '−'));

const state = {
  settings: store.loadSettings(),
  generic: null,
  oil: null,
  events: [],
  stations: [],
  fetchedAt: 0,
  lastFetchTry: 0,
  notices: [],
  tileIndex: null,
};

// ------------------------------------------------------------------ Theme
const mqLight = window.matchMedia('(prefers-color-scheme: light)');

function effectiveTheme(choice = store.getThemeChoice()) {
  if (choice === 'light' || choice === 'dark') return choice;
  return mqLight.matches ? 'light' : 'dark';
}
function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
  $('btn-theme').setAttribute('aria-label', t === 'dark' ? 'Zu hellem Design wechseln' : 'Zu dunklem Design wechseln');
}
mqLight.addEventListener('change', () => { if (store.getThemeChoice() === 'auto') applyTheme(); });
$('btn-theme').addEventListener('click', () => {
  store.setThemeChoice(effectiveTheme() === 'dark' ? 'light' : 'dark');
  applyTheme();
  syncThemeRadios();
});
function syncThemeRadios() {
  const c = store.getThemeChoice();
  document.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === c; });
}

// ------------------------------------------------------------------ Views
function show(view) {
  for (const v of ['onboarding', 'location', 'main']) $(`view-${v}`).hidden = v !== view;
  $('btn-settings').hidden = view === 'onboarding';
  window.scrollTo(0, 0);
}

function persist() { store.saveSettings(state.settings); }

// ------------------------------------------------------------------ Onboarding
$('form-key').addEventListener('submit', (e) => {
  e.preventDefault();
  const k = $('input-key').value.trim();
  if (!isValidKey(k)) {
    $('key-error').textContent = 'Das sieht nicht wie ein Tankerkönig-Key aus (Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
    $('key-error').hidden = false;
    return;
  }
  $('key-error').hidden = true;
  state.settings.apiKey = k;
  state.settings.demo = false;
  if (state.settings.location?.source === 'demo') state.settings.location = null;
  persist();
  startLocation(true);
});
$('btn-demo').addEventListener('click', () => {
  state.settings.demo = true;
  state.settings.location = { ...DEMO_LOCATION };
  persist();
  goMain(true);
});

// ------------------------------------------------------------------ Standort
function locError(msg) {
  $('loc-error').textContent = msg;
  $('loc-error').hidden = !msg;
}
function startLocation(auto) {
  show('location');
  locError('');
  $('btn-loc-cancel').hidden = !state.settings.location;
  if (auto) useGps();
}
async function useGps() {
  locError('');
  const b = $('btn-gps');
  b.disabled = true;
  b.textContent = 'Standort wird ermittelt …';
  try {
    const p = await locate();
    state.settings.location = { ...p, label: 'Aktueller Standort', source: 'gps' };
    if (state.settings.demo && state.settings.apiKey) state.settings.demo = false;
    persist();
    goMain(true);
  } catch (e) {
    locError(e.message);
    $('input-plz').focus();
  } finally {
    b.disabled = false;
    b.textContent = 'Aktuellen Standort verwenden';
  }
}
$('btn-gps').addEventListener('click', useGps);
$('form-plz').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('input-plz').value.trim();
  if (q.length < 3) return locError('Bitte eine PLZ oder einen Ortsnamen eingeben.');
  locError('');
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  try {
    const g = await geocode(q);
    state.settings.location = { ...g, source: 'plz' };
    persist();
    goMain(true);
  } catch (err) {
    locError(err.message);
  } finally {
    btn.disabled = false;
  }
});
$('btn-loc-cancel').addEventListener('click', () => goMain(false));
$('btn-location').addEventListener('click', () => {
  if (state.settings.demo && !state.settings.apiKey) {
    notice('Im Demo-Modus ist der Standort fest. Für echte Preise bitte einen API-Key eintragen.', 'warn', true);
    return;
  }
  startLocation(false);
});

// ------------------------------------------------------------------ Hauptansicht
function goMain(forceRefresh) {
  show('main');
  const s = state.settings;
  $('fuel-label').textContent = `${FUEL_NAME[s.fuel]} · ${s.radius} km`;
  if (!state.stations.length) {
    const last = store.loadLast();
    if (last && !s.demo && sameQuery(last)) {
      state.stations = last.stations;
      state.fetchedAt = last.fetchedAt;
    }
  }
  const stale = Date.now() - state.fetchedAt > CACHE_MS;
  if (forceRefresh || stale || s.demo) refresh(); else compute();
}

function sameQuery(last) {
  const l = state.settings.location;
  return l && last.location && Math.abs(last.location.lat - l.lat) < 1e-4 && Math.abs(last.location.lng - l.lng) < 1e-4
    && last.radius === state.settings.radius;
}

function notice(text, kind = 'info', transient = false) {
  state.notices.push({ text, kind, transient });
  renderNotices();
}
function renderNotices() {
  const box = $('notices');
  box.replaceChildren(...state.notices.map((n) => {
    const p = document.createElement('p');
    p.className = `notice ${n.kind}`;
    p.textContent = n.text;
    return p;
  }));
}

async function refresh(manual = false) {
  const s = state.settings;
  state.notices = [];
  if (s.demo) {
    state.stations = demoStations(state.generic, new Date());
    state.fetchedAt = Date.now();
    return compute();
  }
  if (!s.location) return startLocation(true);
  const since = Date.now() - state.lastFetchTry;
  if (since < MIN_INTERVAL_MS) {
    notice(`Bitte noch ${Math.ceil((MIN_INTERVAL_MS - since) / 1000)} Sekunden warten – Tankerkönig erlaubt etwa eine Abfrage pro Minute.`, 'warn');
    return compute();
  }
  state.lastFetchTry = Date.now();
  setLoading(true);
  try {
    const stations = await fetchStations({ ...s.location, radius: s.radius, apiKey: s.apiKey });
    state.stations = stations;
    state.fetchedAt = Date.now();
    store.saveLast({ stations, fetchedAt: state.fetchedAt, location: s.location, radius: s.radius });
    await store.addObservations(stations, state.fetchedAt);
  } catch (e) {
    const kind = e instanceof ApiError && e.kind === 'limit' ? 'warn' : 'err';
    notice(e.message, kind);
    if (e instanceof ApiError && e.kind === 'key') {
      notice('Tipp: Neue Keys werden von Tankerkönig erst nach Prüfung freigeschaltet.', 'info');
    }
  } finally {
    setLoading(false);
  }
  compute();
}

function setLoading(on) {
  $('btn-refresh').disabled = on;
  $('btn-refresh').textContent = on ? 'Lade …' : 'Preise aktualisieren';
  if (on && !state.stations.length) {
    $('banner').className = 'banner';
    $('banner-kicker').textContent = 'Empfehlung';
    $('banner-title').textContent = 'Lade Preise …';
    $('banner-sub').textContent = '';
  }
}
$('btn-refresh').addEventListener('click', () => refresh(true));

async function compute() {
  const s = state.settings;
  const now = new Date();
  if (s.demo) notice('Demo-Modus: ausgedachte Tankstellen und Preise – nicht zum Tanken verwenden.', 'warn');
  if (!state.stations.length) {
    renderEmpty();
    return;
  }
  const age = Date.now() - state.fetchedAt;
  if (!s.demo && age > STALE_MS) {
    notice(`Die Preise sind ${fmt.ago(state.fetchedAt)} abgefragt worden und könnten veraltet sein.${navigator.onLine ? '' : ' Du bist offline.'}`, 'warn');
  }

  // Profile: Startprofil -> Kacheln -> eigene Beobachtungen
  const { index, tiles } = await loadTiles(state.stations.map((x) => x.postCode));
  state.tileIndex = index;
  const stationTile = Object.fromEntries(state.stations.map((x) => [x.id, x.postCode.slice(0, 2)]));
  const profiles = new Profiles({ generic: state.generic, tiles, tileIndex: index, stationTile });
  const obs = s.demo ? [] : await store.getObservations(Math.max(RULE_START, Date.now() - 180 * 86400000));
  profiles.learned = obs.length ? learn(obs, s.fuel, profiles) : null;

  const dec = decide({ stations: state.stations, fuel: s.fuel, profiles, now, events: state.events, tank: s.tank });
  if (dec.kind !== 'none' && dec.allClosed) notice('Gerade hat keine Tankstelle im Umkreis geöffnet.', 'warn');

  renderNotices();
  renderBanner(dec, now);
  renderSummary(dec, now);
  renderDay(dec, now, profiles, obs);
  renderStations(dec);
  renderDow(dec, profiles, now);
  renderOil();
  renderBacktest(obs);
  renderLocationLabel();
  if (!s.demo && dec.kind !== 'none') recordRecommendation(dec, now);
}

function renderEmpty() {
  renderNotices();
  $('banner').className = 'banner';
  $('banner-kicker').textContent = 'Keine Daten';
  $('banner-title').textContent = 'Keine Preise verfügbar';
  $('banner-sub').textContent = 'Im Umkreis wurden keine Tankstellen gefunden oder die Abfrage ist fehlgeschlagen. Vergrößere den Radius oder versuche es später erneut.';
  $('summary').hidden = false;
  $('fact-price').textContent = '–';
  $('fact-saving').textContent = '–';
  $('fact-station').textContent = '';
  $('fact-meta').textContent = '';
}

function renderLocationLabel() {
  const l = state.settings.location;
  let label = l?.label || 'Standort';
  if (l?.source === 'gps' && state.stations[0]?.place) label = `Nahe ${state.stations[0].place}`;
  $('loc-label').textContent = label;
  $('fuel-label').textContent = `${FUEL_NAME[state.settings.fuel]} · ${state.settings.radius} km`;
}

// ------------------------------------------------------------------ Banner & Zusammenfassung
function stationName(s) {
  const brand = s.brand && !s.name.toLowerCase().includes(s.brand.toLowerCase()) ? `${s.brand} ` : '';
  return `${brand}${s.name}`.trim();
}

function renderBanner(dec, now) {
  const b = $('banner');
  const t = $('banner-title'), sub = $('banner-sub'), kick = $('banner-kicker');
  if (dec.kind === 'none') {
    b.className = 'banner';
    kick.textContent = 'Keine Daten';
    t.textContent = `Keine ${FUEL_NAME[state.settings.fuel]}-Preise`;
    sub.textContent = 'Keine Tankstelle im Umkreis meldet gerade einen Preis für diesen Kraftstoff.';
    return;
  }
  kick.textContent = 'Empfehlung';
  if (dec.kind === 'now') {
    b.className = 'banner go';
    t.textContent = 'Jetzt tanken';
    const reasons = {
      event: `Preiserhöhung erwartet: ${dec.event?.title || 'bekannter Termin'}.`,
      rise: dec.until ? `Ab ca. ${fmt.hm(new Date(dec.until.getTime() + 5 * 60000))} Uhr wird es voraussichtlich teurer.` : 'Später wird es voraussichtlich teurer.',
      cheapest: 'Günstiger wird es in den nächsten Stunden voraussichtlich nicht.',
      'small-gain': `Warten bringt höchstens ca. ${fmt.ct(dec.maxGainWaitingCt)} – lohnt sich kaum.`,
    };
    const day = dec.until ? fmt.relDay(now, dec.until) : '';
    const until = dec.until && dec.reason !== 'rise' ? `Günstig bis ${day === 'heute' ? '' : `${day} `}ca. ${fmt.hm(dec.until)} Uhr. ` : '';
    sub.textContent = `${until}${reasons[dec.reason]}`;
    return;
  }
  b.className = 'banner wait';
  if (dec.days >= 2) {
    t.textContent = `Warten bis ${fmt.weekdayLong(dec.from)}`;
    sub.textContent = `Am besten ${fmt.dayShort(dec.from)}, ${fmt.hm(dec.from)}–${fmt.hm(dec.to)} Uhr.`;
  } else {
    t.textContent = `Warten – am besten ${fmt.window(now, dec.from, dec.to)}`;
    sub.textContent = dec.allClosed
      ? 'Gerade ist alles geschlossen.'
      : `Dann voraussichtlich ca. ${fmt.ct(dec.savingCt)} günstiger.${dec.alt ? ` Heute geht es ab ca. ${fmt.hm(dec.alt.t)} Uhr auch schon ca. ${fmt.ct(dec.alt.savingCt)} günstiger.` : ''}`;
  }
}

function navUrl(s) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;
}

function renderSummary(dec, now) {
  $('summary').hidden = dec.kind === 'none';
  if (dec.kind === 'none') return;
  const fuel = state.settings.fuel;
  const tank = state.settings.tank;
  if (dec.kind === 'now') {
    $('fact-price-label').textContent = 'Günstigster Preis jetzt';
    $('fact-price').innerHTML = `${fmt.price(dec.station[fuel])}<small>${fmt.km(dec.station.dist)} entfernt</small>`;
    $('fact-saving').innerHTML = dec.savingCt >= 0.5
      ? `ca. ${fmt.ct(dec.savingCt)}<small>${fmt.euro(dec.savingEur)} pro ${tank}‑l‑Tankfüllung ggü. später</small>`
      : `ca. ${fmt.ct(Math.max(0, dec.belowAvgCt))}<small>unter dem Schnitt in der Nähe (${fmt.euro(Math.max(0, dec.belowAvgCt) * tank / 100)} bei ${tank} l)</small>`;
  } else {
    $('fact-price-label').textContent = `Erwartet ${fmt.relDay(now, dec.from)} ${fmt.hm(dec.from)} Uhr`;
    $('fact-price').innerHTML = `ca. ${fmt.price(dec.expectedPrice)}<small>${dec.nowBest ? `jetzt ab ${fmt.price(dec.nowBest[fuel])}` : 'jetzt alles geschlossen'}</small>`;
    $('fact-saving').innerHTML = dec.savingCt != null
      ? `ca. ${fmt.ct(dec.savingCt)}<small>${fmt.euro(dec.savingEur)} pro ${tank}‑l‑Tankfüllung · ± ${fmt.num1(dec.uncertainty)} ct</small>`
      : '–';
  }
  const st = dec.station;
  const a = $('fact-station');
  a.textContent = `${stationName(st)}, ${st.street}`;
  a.href = navUrl(st);
  a.setAttribute('aria-label', `Navigation zu ${stationName(st)} starten`);
  const src = state.settings.demo ? 'Demo-Daten' : 'Tankerkönig';
  $('fact-meta').textContent = `Stand: ${fmt.dateTime(new Date(state.fetchedAt))} · ${src}`;
}

// ------------------------------------------------------------------ Warum: Tagesverlauf
function renderDay(dec, now, profiles, obs) {
  const box = $('chart-day');
  box.replaceChildren();
  if (dec.kind === 'none') { $('day-text').textContent = ''; return; }
  const fuel = state.settings.fuel;
  const st = dec.chartStation;
  const base = st[fuel];
  let hours = 24;
  if (dec.kind === 'wait') hours = Math.min(7 * 24, Math.max(24, (dec.to - now) / 3600000 + 3));
  const future = dec.path.filter((p) => p.t - now <= hours * 3600000)
    .map((p) => ({ x: (p.t - now) / 3600000, y: base + p.delta / 100 }));
  // Rückblick: typisches Profil der letzten 12 Stunden (gestrichelt), ausgerichtet auf den aktuellen Preis
  const past = [];
  const h0 = profiles.hod(st.id, fuel, dowOf(now));
  const p0 = h0[slotIndex(now)];
  for (let k = 24; k >= 0; k--) {
    const t = new Date(now.getTime() - k * 30 * 60000);
    const v = profiles.hod(st.id, fuel, dowOf(t))[slotIndex(t)];
    past.push({ x: -k / 2, y: base + (v - p0) / 100 });
  }
  const seen = obs.filter((o) => o.sid === st.id && o[fuel] && now - o.ts <= 12 * 3600000)
    .map((o) => ({ x: (o.ts - now) / 3600000, y: o[fuel] }));

  const ticks = [];
  const step = hours > 30 ? 12 : 6;
  for (let h = -12; h <= hours; h += 1) {
    const t = new Date(now.getTime() + h * 3600000);
    if (t.getHours() % step === 0) {
      const label = hours > 30 ? `${fmt.weekdayShort(t.getDay())} ${t.getHours()}` : `${t.getHours()} Uhr`;
      ticks.push({ x: (new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours()) - now) / 3600000, label });
    }
  }
  const series = [
    { points: past, cls: 'line-alt' },
    { points: future, cls: 'line-main' },
  ];
  if (seen.length) series.push({ points: seen, cls: '', dots: true });
  const svg = lineChart(series, {
    label: `Erwarteter Preisverlauf für ${stationName(st)}`,
    yFmt: (v) => v.toFixed(2).replace('.', ','),
    xTicks: ticks,
    marker: { x: 0, y: base, label: 'jetzt' },
    band: dec.kind === 'wait'
      ? { x0: (dec.from - now) / 3600000, x1: (dec.to - now) / 3600000 }
      : dec.until ? { x0: 0, x1: (dec.until - now) / 3600000 } : null,
    height: 180,
  });
  if (dec.kind === 'now') svg.classList.add('go-band');
  box.appendChild(svg);
  const items = [{ cls: 'line-alt', label: 'typischer Verlauf (zurück)' }, { cls: 'line-main', label: 'erwartet' }];
  if (seen.length) items.push({ cls: 'line-go', label: 'deine Abfragen' });
  box.appendChild(legend(items));

  const g = state.generic.fuels[fuel];
  const jump = g[24] - g[23];
  const srcs = profiles.sources(st.id, fuel);
  const learned = profiles.learned;
  let srcText = srcs.includes('tile-station')
    ? 'Basis: gemessenes Profil dieser Tankstelle (Tankerkönig-Historie).'
    : srcs.includes('tile-regional') ? 'Basis: gemessenes Profil der Region (Tankerkönig-Historie).'
      : 'Basis: allgemeines Profil nach ADAC-Auswertung (Mai 2026).';
  if (learned?.n) srcText += ` Verfeinert mit ${fmt.int(learned.n)} eigenen Preisbeobachtungen an ${learned.daysObserved} Tagen.`;
  else if (!state.settings.demo) srcText += ' Mit jeder Abfrage lernt die App dazu.';
  $('day-text').textContent = `Seit dem 1. April 2026 dürfen Tankstellen die Preise nur noch um 12 Uhr erhöhen. Typisch: Sprung um 12 Uhr (ca. +${fmt.ct(jump)}), danach sinkt der Preis bis zum Abend, am günstigsten ist es meist kurz vor 12 Uhr. ${srcText}`;
}

const slotIndex = (d) => Math.floor((d.getHours() * 60 + d.getMinutes()) / 30);

// ------------------------------------------------------------------ Tankstellenliste
function renderStations(dec) {
  const ul = $('station-list');
  const fuel = state.settings.fuel;
  const list = state.stations.filter((s) => s[fuel] != null)
    .sort((a, b) => (b.isOpen - a.isOpen) || a[fuel] - b[fuel] || a.dist - b.dist)
    .slice(0, 10);
  const bestId = dec.nowBest?.id;
  ul.replaceChildren(...list.map((s) => {
    const li = document.createElement('li');
    if (s.id === bestId) li.className = 'st-best';
    if (!s.isOpen) li.classList.add('st-closed');
    const a = document.createElement('a');
    a.href = navUrl(s);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `<span class="st-name"></span><span class="st-meta"></span><span class="st-price"></span>`;
    a.querySelector('.st-name').textContent = stationName(s);
    a.querySelector('.st-meta').textContent = `${fmt.km(s.dist)} · ${s.street}${s.isOpen ? '' : ' · geschlossen'}`;
    const p = a.querySelector('.st-price');
    p.textContent = fmt.price(s[fuel]);
    if (dec.kind === 'wait' && dec.paths?.has(s.id)) {
      const path = dec.paths.get(s.id);
      const pt = path.find((x) => x.t >= dec.from);
      if (pt) {
        const small = document.createElement('small');
        small.textContent = `dann ca. ${fmt.price(s[fuel] + pt.delta / 100)}`;
        p.appendChild(small);
      }
    } else if (s.id === bestId) {
      const small = document.createElement('small');
      small.textContent = 'am günstigsten';
      p.appendChild(small);
    }
    li.appendChild(a);
    return li;
  }));
}

// ------------------------------------------------------------------ Wochentag
function renderDow(dec, profiles, now) {
  const box = $('chart-dow');
  box.replaceChildren();
  if (dec.kind === 'none') return;
  const { eff, src } = profiles.dow(dec.chartStation.id, state.settings.fuel);
  const days = profiles.learned?.dow.days || 0;
  if (src === 'none') {
    $('dow-text').textContent = state.settings.demo
      ? 'Im Demo-Modus gibt es keine Wochentagsdaten.'
      : `Zu Wochentagen gibt es seit der 12-Uhr-Regel noch keine verlässlichen Auswertungen. Die App lernt den Effekt aus deinen Abfragen – bisher ${days} von mindestens 14 Tagen. Bis dahin wird jeder Wochentag gleich behandelt.`;
    return;
  }
  const labels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  box.appendChild(barChart(eff, labels, {
    label: 'Wochentagseffekt in Cent pro Liter',
    highlight: dowOf(now),
    fmt: (v) => `${v > 0 ? '+' : ''}${fmt.num1(v)}`,
  }));
  const min = eff.indexOf(Math.min(...eff)), max = eff.indexOf(Math.max(...eff));
  const spread = eff[max] - eff[min];
  const srcText = { tile: 'Tankerkönig-Historie', learned: 'deinen eigenen Abfragen', 'tile+learned': 'Tankerkönig-Historie und deinen Abfragen' }[src];
  $('dow-text').textContent = spread < 0.8
    ? `Der Wochentag macht hier kaum einen Unterschied (Spanne ${fmt.ct(spread)}). Quelle: ${srcText}.`
    : `Am günstigsten im Schnitt: ${labels[min]}, am teuersten: ${labels[max]} (Unterschied ca. ${fmt.ct(spread)}). Quelle: ${srcText}.`;
}

// ------------------------------------------------------------------ Ölpreis
function renderOil() {
  const oil = state.oil;
  const box = $('chart-oil'), rf = $('chart-rf');
  box.replaceChildren(); rf.replaceChildren();
  if (!oil) {
    $('oil-text').textContent = 'Die Ölpreis-Auswertung konnte nicht geladen werden.';
    $('rf-text').textContent = '';
    return;
  }
  const key = state.settings.fuel === 'diesel' ? 'diesel' : 'e5';
  const f = oil.fuels[key];
  const S = oil.series;
  const t0 = new Date(S.dates[0]).getTime();
  const X = (d) => (new Date(d).getTime() - t0) / 86400000;
  const pump = S.dates.map((d, i) => ({ x: X(d), y: S[key][i] }));
  const brent = S.dates.map((d, i) => ({ x: X(d), y: S.brent[i] }));
  const ticks = [];
  S.dates.forEach((d) => {
    const dt = new Date(d);
    if (dt.getDate() <= 7 && dt.getMonth() % 6 === 0) ticks.push({ x: X(d), label: `${dt.getMonth() === 0 ? 'Jan' : 'Jul'} ${String(dt.getFullYear()).slice(2)}` });
  });
  box.appendChild(lineChart([
    { points: pump, cls: 'line-main' },
    { points: brent, cls: 'line-alt' },
  ], { label: 'Spritpreis ohne Steuern und Rohölpreis in Cent pro Liter', yFmt: (v) => fmt.int(v), xTicks: ticks, height: 160 }));
  box.appendChild(legend([
    { cls: 'line-main', label: `${key === 'e5' ? 'Super' : 'Diesel'} ohne Steuern (ct/l)` },
    { cls: 'line-alt', label: 'Rohöl Brent in Euro (ct/l)' },
  ]));
  const lastDate = new Date(oil.last_bulletin);
  $('oil-text').textContent = `Wöchentliche Werte für Deutschland bis ${fmt.dayShort(lastDate)}${lastDate.getFullYear()}. Ölpreis-Anstiege kommen hier nach wenigen Tagen an der Säule an (in der ersten Woche ca. ${fmt.pct(Math.min(1, f.first_week_up))}). Rückgänge kommen viel langsamer an: in der ersten Woche nur ca. ${fmt.pct(f.first_week_down)}, 80 % erst nach ca. ${fmt.num1(f.weeks_to_80pct_down)} Wochen („Rockets and Feathers“).`;

  const up = f.cum_response_up.map((v, i) => ({ x: i, y: Math.min(v, 1.6) * 100 }));
  const dn = f.cum_response_down.map((v, i) => ({ x: i, y: v * 100 }));
  rf.appendChild(lineChart([
    { points: up, cls: 'line-main' },
    { points: dn, cls: 'line-alt' },
  ], {
    label: 'Weitergabe von Ölpreisänderungen in Prozent nach Wochen',
    yFmt: (v) => `${fmt.int(v)} %`, yRange: [0, Math.max(110, ...up.map((p) => p.y)) + 5],
    xTicks: [0, 2, 4, 6, 8, 10].map((w) => ({ x: w, label: w === 0 ? 'sofort' : `${w} Wo.` })), height: 140,
  }));
  rf.appendChild(legend([{ cls: 'line-main', label: 'Öl wird teurer' }, { cls: 'line-alt', label: 'Öl wird billiger' }]));
  const ft = f.forecast_test.brent;
  $('rf-text').textContent = `Warum kein Live-Ölpreis in der Empfehlung? Getestet auf Daten seit 2020: Frei verfügbare Ölpreise kommen 3–5 Tage verzögert. Bis dahin hat die Säule schon reagiert – die Vorhersagekraft für die nächste Woche ist dann praktisch null (Korrelation ${corrText(ft.find((r) => r.delay_workdays === 4)?.corr)}). Der Ölpreis dient hier deshalb nur als Erklärung, nicht als Signal.`;
}

// ------------------------------------------------------------------ Backtest / Trefferquote
async function renderBacktest(obs) {
  const box = $('backtest');
  box.replaceChildren();
  const fuel = state.settings.fuel;
  const parts = [];
  const bt = state.tileIndex?.backtest?.[fuel];
  if (bt && !bt.error) {
    parts.push(`<p><strong>Backtest mit Tankerkönig-Historie</strong> (${bt.test_period.map((d) => fmt.dayShort(new Date(d))).join(' – ')}):</p>
      <dl class="kv">
        <dt>Ø Ersparnis ggü. sofort tanken</dt><dd>${fmt.ct(bt.mean_saving_ct)}</dd>
        <dt>Bestmöglich (im Nachhinein)</dt><dd>${fmt.ct(bt.oracle_mean_saving_ct)}</dd>
        <dt>Fälle, in denen Warten teurer war</dt><dd>${fmt.pct(bt.share_worse_than_now)}</dd>
        <dt>Empfehlung „Warten“ in</dt><dd>${fmt.pct(bt.share_wait)}</dd>
      </dl>`);
  } else {
    parts.push('<p>Ein Backtest der Tageszeit-Regel mit echten Tankerkönig-Daten folgt, sobald die Preishistorie verfügbar ist. Bis dahin beruht das Tagesprofil auf der ADAC-Auswertung und deinen eigenen Abfragen.</p>');
  }
  if (!state.settings.demo) {
    const ev = evaluate(await store.getRecommendations(), obs);
    parts.push(ev.checked
      ? `<p><strong>Deine bisherigen Empfehlungen:</strong> ${ev.correct} von ${ev.checked} überprüfbaren lagen richtig${ev.meanAbsErrCt != null ? `, Prognose im Schnitt ±${fmt.ct(ev.meanAbsErrCt)} daneben` : ''}.</p>`
      : `<p><strong>Deine bisherigen Empfehlungen:</strong> noch keine überprüfbar. Fragst du später erneut ab, vergleicht die App ihre Empfehlung mit dem tatsächlichen Preis.</p>`);
  }
  const oil = state.oil?.fuels?.[fuel === 'diesel' ? 'diesel' : 'e5'];
  if (oil) {
    const r = oil.forecast_test.brent.find((x) => x.delay_workdays === 4);
    parts.push(`<p><strong>Ölpreis-Faktor:</strong> mit verzögerten Daten keine Vorhersagekraft (Korrelation ${corrText(r?.corr)}) – deshalb mit Gewicht 0.</p>`);
  }
  parts.push(`<p class="note">Regel: „Warten“ nur, wenn die erwartete Ersparnis mindestens ${fmt.ct(WAIT_THRESHOLD_CT)} beträgt; jeder weitere Tag muss sich zusätzlich lohnen.</p>`);
  box.innerHTML = parts.join('');
}

async function recordRecommendation(dec, now) {
  const recs = await store.getRecommendations();
  const last = recs.sort((a, b) => b.ts - a.ts)[0];
  if (last && now - last.ts < 30 * 60000) return;
  const fuel = state.settings.fuel;
  await store.addRecommendation({
    ts: now.getTime(),
    fuel,
    action: dec.kind,
    sid: dec.station.id,
    priceNow: dec.nowBest ? dec.nowBest[fuel] : dec.station[fuel],
    predicted: dec.kind === 'wait' ? dec.expectedPrice : dec.station[fuel],
    from: dec.kind === 'wait' ? dec.from.getTime() : now.getTime(),
    to: dec.kind === 'wait' ? dec.to.getTime() : (dec.until || now).getTime(),
  });
}

// ------------------------------------------------------------------ Einstellungen
const dlg = $('dlg-settings');
$('btn-settings').addEventListener('click', async () => {
  const s = state.settings;
  const f = $('form-settings');
  f.fuel.value = s.fuel;
  f.radius.value = s.radius;
  $('out-radius').textContent = `${s.radius} km`;
  f.tank.value = s.tank;
  f.apiKey.value = s.apiKey;
  $('set-key-error').hidden = true;
  syncThemeRadios();
  const n = await store.countObservations();
  $('learn-info').textContent = n
    ? `${fmt.int(n)} Preisbeobachtungen auf diesem Gerät gespeichert. Daraus lernt die App die Preisverläufe in deiner Gegend.`
    : 'Noch keine eigenen Preisbeobachtungen gespeichert.';
  dlg.showModal();
});
$('set-radius').addEventListener('input', (e) => { $('out-radius').textContent = `${e.target.value} km`; });
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
  store.setThemeChoice(r.value);
  applyTheme();
}));
$('form-settings').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = e.target;
  const key = f.apiKey.value.trim();
  if (key && !isValidKey(key)) {
    e.preventDefault();
    $('set-key-error').textContent = 'Ungültiges Format. Erwartet: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
    $('set-key-error').hidden = false;
    return;
  }
  const s = state.settings;
  const before = JSON.stringify([s.fuel, s.radius, s.apiKey]);
  s.fuel = f.fuel.value;
  s.radius = Math.max(1, Math.min(25, +f.radius.value || 5));
  s.tank = Math.max(5, Math.min(200, +f.tank.value || 50));
  s.apiKey = key;
  if (!key) {
    s.demo = false;
    persist();
    state.stations = [];
    show('onboarding');
    return;
  }
  const keyChanged = before !== JSON.stringify([s.fuel, s.radius, s.apiKey]) && JSON.parse(before)[2] !== key;
  if (s.demo && key) { s.demo = false; s.location = null; }
  persist();
  if (!s.location) return startLocation(true);
  const radiusChanged = JSON.parse(before)[1] !== s.radius;
  if (keyChanged || radiusChanged) { state.lastFetchTry = 0; state.stations = []; goMain(true); } else goMain(false);
});
$('btn-delete-key').addEventListener('click', async () => {
  if (!confirm('API-Key, Einstellungen und alle gespeicherten Preisbeobachtungen von diesem Gerät löschen?')) return;
  store.clearAll();
  await store.clearDatabase();
  state.settings = store.loadSettings();
  state.stations = [];
  state.fetchedAt = 0;
  dlg.close();
  $('input-key').value = '';
  show('onboarding');
});

// ------------------------------------------------------------------ Start
async function init() {
  applyTheme();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const [generic, oil, events] = await Promise.all([
    loadGeneric(),
    fetch('data/oil-model.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('data/events.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  if (!generic) {
    document.getElementById('app').innerHTML = '<div class="card"><h2>Fehler</h2><p>Die App-Daten konnten nicht geladen werden. Bitte Seite neu laden.</p></div>';
    return;
  }
  state.generic = generic;
  state.oil = oil;
  state.events = (events.events || events || []).map((e) => ({ ...e, fromMs: new Date(e.from).getTime() }));

  // Beim Zurückkehren in die App: nur aktualisieren, wenn die Daten älter als 5 Minuten sind (kein Dauer-Polling)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('view-main').hidden && Date.now() - state.fetchedAt > CACHE_MS) refresh();
  });

  const s = state.settings;
  if (!s.apiKey && !s.demo) return show('onboarding');
  if (!s.location) return startLocation(true);
  goMain(false);
}

init();
