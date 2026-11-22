const { chromium, devices } = require('playwright');
// Aufruf: python3 -m http.server 8765 -d app  &  TZ=Europe/Berlin node tests/e2e-ablauf.cjs [Screenshot-Ordner]
const S = process.argv[2] || require('os').tmpdir();
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const KEY = '12345678-1234-1234-1234-123456789abc';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'light' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await ctx.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ json: [{ lat: '51.3533', lon: '12.2708', display_name: '04178, Leipzig', address: { postcode: '04178', city: 'Leipzig' } }], headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://creativecommons.tankerkoenig.de/**', (r) => r.fulfill({ json: { ok: true, stations: [
    { id: 'a', name: 'Alpha', brand: 'ARAL', street: 'Weg', houseNumber: '1', place: 'Leipzig', postCode: 4178, lat: 51.35, lng: 12.27, dist: 1.2, isOpen: true, e5: 1.899, e10: 1.839, diesel: 1.769 },
    { id: 'b', name: 'Beta', brand: 'JET', street: 'Weg', houseNumber: '2', place: 'Leipzig', postCode: 4178, lat: 51.36, lng: 12.28, dist: 2.2, isOpen: true, e5: 1.889, e10: false, diesel: 1.759 }] }, headers: { 'access-control-allow-origin': '*' } }));
  await p.goto(BASE);
  console.log('theme(light system):', await p.getAttribute('html', 'data-theme'));
  await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100);
  console.log('theme after system->dark (auto):', await p.getAttribute('html', 'data-theme'));
  await p.fill('#input-key', KEY); await p.click('#form-key button[type=submit]');
  await p.waitForTimeout(800); // Geolocation ohne Berechtigung -> Fehler
  console.log('LOC ERROR:', await p.textContent('#loc-error'));
  await p.screenshot({ path: S + '/t3-location.png' });
  await p.fill('#input-plz', '04178'); await p.click('#form-plz button');
  await p.waitForSelector('#view-main:not([hidden])'); await p.waitForTimeout(600);
  console.log('LOC LABEL:', await p.textContent('#loc-label'), '| BANNER:', (await p.textContent('#banner-title')).trim());
  // Einstellungen
  await p.click('#btn-settings'); await p.waitForSelector('#dlg-settings[open]'); await p.waitForTimeout(300);
  await p.screenshot({ path: S + '/t3-settings0.png' });
  await p.check('input[name=fuel][value=diesel]', { force: true });
  await p.check('input[name=theme][value=light]', { force: true });
  console.log('theme manual light:', await p.getAttribute('html', 'data-theme'));
  await p.waitForTimeout(500); await p.screenshot({ path: S + '/t3-settings.png' }); console.log('tank', await p.inputValue('#set-tank'), 'key', await p.inputValue('#set-key'));
  await p.click('#btn-save');
  await p.waitForTimeout(500);
  console.log('FUEL LABEL:', await p.textContent('#fuel-label'));
  await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100);
  console.log('manual wins over system:', await p.getAttribute('html', 'data-theme'));
  // Offline: Service Worker
  await p.waitForTimeout(800);
  await ctx.setOffline(true);
  await p.reload(); await p.waitForTimeout(800);
  console.log('OFFLINE BANNER:', (await p.textContent('#banner-title')).trim(), '| NOTICES:', await p.textContent('#notices'));
  await ctx.setOffline(false);
  // Löschen
  p.once('dialog', (d) => d.accept());
  await p.click('#btn-settings'); await p.click('#btn-delete-key'); await p.waitForTimeout(400);
  console.log('after delete onboarding visible:', await p.isVisible('#view-onboarding'), 'LS:', await p.evaluate(() => localStorage.getItem('tz-settings')));
  console.log('ERRORS', errs);
  await b.close();
})();
