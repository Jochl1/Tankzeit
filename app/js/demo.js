// Demo-Modus: ausgedachte Tankstellen rund um Rückmarsdorf, Preise aus dem Startprofil berechnet.
// Keine echten Daten – wird in der App deutlich als Demo gekennzeichnet.
import { slotOf } from './profile.js';

export const DEMO_LOCATION = { lat: 51.3447, lng: 12.2572, label: 'Rückmarsdorf (Demo)', source: 'demo' };

const STATIONS = [
  ['Tankstelle Am Anger', 'Demo-Tank', 0.6, -0.4, 1.0, 1],
  ['Autohof West', 'Demo-Tank', 2.1, 1.8, 0.8, 1],
  ['Freie Tankstelle Lindenallee', 'Freie', 1.4, -2.6, 1.2, 1],
  ['Station Merseburger Straße', 'Demo-Oil', 3.2, 0.9, 1.1, 1],
  ['Tankpunkt Gewerbegebiet', 'Demo-Oil', 4.0, -1.5, 0.9, 1],
  ['Tankstelle Bahnhofstraße', 'Freie', 4.6, 3.1, 0.7, 0],
  ['Service-Station Nord', 'Demo-Tank', 2.8, 2.4, 1.3, 1],
];

function rnd(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function demoStations(generic, now = new Date()) {
  const slot = slotOf(now);
  const day = Math.floor(now.getTime() / 86400000);
  const base = { e5: 185.9, e10: 179.9, diesel: 171.9 };
  return STATIONS.map(([name, brand, dist, off, amp, open], i) => {
    const angle = (i / STATIONS.length) * Math.PI * 2;
    const s = {
      id: `demo-${i + 1}`, name, brand, street: 'Musterstraße ' + (i + 3), place: 'Leipzig (Demo)', postCode: '04178',
      lat: DEMO_LOCATION.lat + Math.sin(angle) * dist / 111,
      lng: DEMO_LOCATION.lng + Math.cos(angle) * dist / 70,
      dist, isOpen: !!open,
    };
    for (const f of ['e5', 'e10', 'diesel']) {
      const c = base[f] + off + generic.fuels[f][slot] * amp + (rnd(day * 13 + i) - 0.5) * 1.5;
      s[f] = Math.floor(c) / 100 + 0.009;  // typisch: x,xx9 €
    }
    return s;
  });
}
