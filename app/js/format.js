// Deutsche Formatierung: Preise, Zeiten, Daten.
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

const pad = (n) => String(n).padStart(2, '0');

/** 1.789 -> "1,789 €" */
export const price = (eur) => (eur == null || !isFinite(eur) ? '–' : `${eur.toFixed(3).replace('.', ',')} €`);
/** 6.24 -> "6,2 ct/l" */
export const ct = (c, unit = ' ct/l') => `${nf1.format(c)}${unit}`;
/** 3.1 -> "3,10 €" */
export const euro = (e) => `${nf2.format(e)} €`;
export const num1 = (v) => nf1.format(v);
export const int = (v) => nf0.format(v);
export const km = (d) => (d < 10 ? `${nf1.format(d)} km` : `${nf0.format(d)} km`);
export const pct = (v) => `${nf0.format(v * 100)} %`;

export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "Do., 26.11." */
export const dayShort = (d) => `${WD[d.getDay()]}., ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
/** "Do., 26.11., 19:30 Uhr" */
export const dateTime = (d) => `${dayShort(d)}, ${hm(d)} Uhr`;
export const weekdayLong = (d) => WD_LONG[d.getDay()];
export const weekdayShort = (i) => WD[i];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

/** relativer Tag: "heute", "morgen", "übermorgen", sonst Wochentag */
export function relDay(now, d) {
  const n = dayDiff(now, d);
  if (n === 0) return 'heute';
  if (n === 1) return 'morgen';
  if (n === 2) return 'übermorgen';
  return weekdayLong(d);
}

/** "heute 19:00–21:30 Uhr" bzw. "morgen 10:00–11:30 Uhr" */
export function window(now, from, to) {
  const day = relDay(now, from);
  const span = hm(from) === hm(to) ? `${hm(from)} Uhr` : `${hm(from)}–${hm(to)} Uhr`;
  return `${day} ${span}`;
}

/** "vor 3 Min." / "vor 2 Std." / Datum */
export function ago(ts, now = Date.now()) {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  return dateTime(new Date(ts));
}
