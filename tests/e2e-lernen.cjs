const { chromium, devices } = require('playwright');
// Aufruf: python3 -m http.server 8765 -d app  &  TZ=Europe/Berlin node tests/e2e-lernen.cjs [Screenshot-Ordner]
const S = process.argv[2] || require('os').tmpdir();
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const gen = require('../app/data/generic-profile.json');
const KEY = '12345678-1234-1234-1234-123456789abc';
let calls = 0;
function stationsAt(ts) {
  const d = new Date(ts); const slot = Math.floor((d.getHours()*60+d.getMinutes())/30);
  const mk = (i, name, off, profile) => ({ id: `st-${i}`, name, brand: 'TEST', street: 'Hauptstr.', houseNumber: String(i), place: 'Leipzig', postCode: 4178,
    lat: 51.35 + i*0.002, lng: 12.27, dist: 0.5 + i, isOpen: true,
    e5: +(1.85 + off + profile(slot)/100).toFixed(3), e10: +(1.79 + off + profile(slot)/100).toFixed(3), diesel: +(1.72 + off + gen.fuels.diesel[slot]/100).toFixed(3) });
  // st-3: "Regelbrecher" – am günstigsten abends 19-21 Uhr statt vor 12
  const odd = (s) => (s >= 38 && s <= 42 ? -6 : gen.fuels.e10[s] * 0.3);
  return [mk(1, 'Normal A', 0.01, (s) => gen.fuels.e10[s]), mk(2, 'Normal B', 0.03, (s) => gen.fuels.e10[s]), mk(3, 'Abendbillig', 0.0, odd)];
}
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'], locale: 'de-DE', timezoneId: 'Europe/Berlin', geolocation: { latitude: 51.35, longitude: 12.27 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await ctx.route('https://creativecommons.tankerkoenig.de/**', async (route) => {
    calls++;
    const u = new URL(route.request().url());
    if (u.searchParams.get('apikey') !== KEY) return route.fulfill({ json: { ok: false, status: 'error', message: 'apikey nicht angegeben, falsch, oder im falschen Format' }, headers: { 'access-control-allow-origin': '*' } });
    const now = await p.evaluate(() => Date.now());
    route.fulfill({ json: { ok: true, status: 'ok', stations: stationsAt(now) }, headers: { 'access-control-allow-origin': '*' } });
  });
  await p.clock.install({ time: new Date('2026-11-02T10:30:00+01:00') });
  await p.goto(BASE);
  // falscher Key
  await p.fill('#input-key', 'abc'); await p.click('#form-key button[type=submit]');
  console.log('KEY ERR:', await p.textContent('#key-error'));
  await p.fill('#input-key', KEY); await p.click('#form-key button[type=submit]');
  await p.waitForSelector('#view-main:not([hidden])'); await p.waitForTimeout(600);
  console.log('10:30 ->', (await p.textContent('#banner')).replace(/\s+/g, ' ').trim());
  await p.screenshot({ path: S + '/r1-1030.png', fullPage: false });
  // Lernphase: 14 Tage, Abfragen zu verschiedenen Zeiten
  const times = ['07:40', '11:20', '12:40', '15:10', '19:30', '20:30', '21:40'];
  for (let day = 3; day <= 16; day++) {
    for (const t of times) {
      const ts = new Date(`2026-11-${String(day).padStart(2,'0')}T${t}:00+01:00`);
      await p.clock.setSystemTime(ts);
      await Promise.all([p.waitForResponse(/tankerkoenig/), p.click('#btn-refresh')]); await p.waitForTimeout(120);
    }
  }
  for (const t of ['10:30', '14:10', '18:00', '21:50']) {
    await p.clock.setSystemTime(new Date(`2026-11-17T${t}:00+01:00`));
    await p.click('#btn-refresh'); await p.waitForTimeout(500);
    console.log(t, '->', (await p.textContent('#banner')).replace(/\s+/g, ' ').trim(), '|', (await p.textContent('#fact-station')));
  }
  console.log('DAY TEXT:', await p.textContent('#day-text'));
  console.log('DOW TEXT:', await p.textContent('#dow-text'));
  console.log('BACKTEST:', (await p.textContent('#backtest')).replace(/\s+/g, ' '));
  await p.screenshot({ path: S + '/r2-learned.png', fullPage: true });
  // Rate limit: sofort nochmal
  await p.click('#btn-refresh'); await p.waitForTimeout(200);
  console.log('NOTICES:', await p.textContent('#notices'));
  console.log('API calls', calls, 'ERRORS', errs);
  await b.close();
})();
