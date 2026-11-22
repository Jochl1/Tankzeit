// Kleine SVG-Charts. Farben kommen ausschließlich aus CSS-Klassen/Variablen,
// dadurch schalten sie beim Theme-Wechsel automatisch mit um.
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function svgRoot(w, h, label) {
  const s = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'chart', role: 'img', 'aria-label': label });
  s.appendChild(el('title', {}, label));
  return s;
}

function niceRange(min, max, pad = 0.08) {
  if (min === max) { min -= 1; max += 1; }
  const p = (max - min) * pad;
  return [min - p, max + p];
}

function ticks(min, max, count = 3) {
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/**
 * Linienchart.
 * series: [{ points: [{x, y}], cls: 'line-main' | 'line-alt' | ..., step?: bool, label? }]
 * opts: { xFmt, yFmt, xTicks: [{x, label}], marker: {x, label}, band: {x0, x1, label}, height, yTickCount }
 */
export function lineChart(series, opts = {}) {
  const W = 340, H = opts.height || 170;
  const m = { l: 44, r: 10, t: 14, b: 24 };
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = opts.yRange || niceRange(Math.min(...ys), Math.max(...ys));
  const X = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (y) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const svg = svgRoot(W, H, opts.label || 'Diagramm');

  if (opts.band) {
    const bx0 = X(Math.max(x0, opts.band.x0)), bx1 = X(Math.min(x1, opts.band.x1));
    svg.appendChild(el('rect', { x: bx0, y: m.t, width: Math.max(2, bx1 - bx0), height: H - m.t - m.b, class: 'band' }));
  }
  for (const v of ticks(y0, y1, opts.yTickCount || 3)) {
    svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    svg.appendChild(el('text', { x: m.l - 6, y: Y(v) + 3.5, class: 'tick', 'text-anchor': 'end' }, opts.yFmt ? opts.yFmt(v) : v));
  }
  for (const t of opts.xTicks || []) {
    if (t.x < x0 || t.x > x1) continue;
    svg.appendChild(el('text', { x: X(t.x), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, t.label));
  }
  for (const s of series) {
    if (s.dots) {
      for (const p of s.points) {
        if (Number.isFinite(p.y)) svg.appendChild(el('circle', { cx: X(p.x), cy: Y(p.y), r: 2.6, class: `dot ${s.cls || ''}` }));
      }
      continue;
    }
    let d = '';
    s.points.forEach((p, i) => {
      if (!Number.isFinite(p.y)) return;
      const cmd = d === '' ? 'M' : 'L';
      if (s.step && i > 0 && d) d += `L${X(p.x).toFixed(1)},${Y(s.points[i - 1].y).toFixed(1)}`;
      d += `${cmd}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
    });
    svg.appendChild(el('path', { d, class: `line ${s.cls || 'line-main'}` }));
  }
  if (opts.marker && opts.marker.x >= x0 && opts.marker.x <= x1) {
    const mx = X(opts.marker.x);
    svg.appendChild(el('line', { x1: mx, x2: mx, y1: m.t - 4, y2: H - m.b, class: 'marker' }));
    if (opts.marker.y != null) svg.appendChild(el('circle', { cx: mx, cy: Y(opts.marker.y), r: 3.5, class: 'marker-dot' }));
    if (opts.marker.label) {
      const anchor = mx > W - 60 ? 'end' : mx < m.l + 30 ? 'start' : 'middle';
      svg.appendChild(el('text', { x: mx, y: m.t - 5, class: 'tick marker-label', 'text-anchor': anchor }, opts.marker.label));
    }
  }
  return svg;
}

/** Balken um eine Nulllinie (z. B. Wochentagseffekt in ct). */
export function barChart(values, labels, opts = {}) {
  const W = 340, H = opts.height || 130;
  const m = { l: 10, r: 10, t: 18, b: 22 };
  const maxAbs = Math.max(0.5, ...values.map((v) => Math.abs(v)));
  const bw = (W - m.l - m.r) / values.length;
  const mid = m.t + (H - m.t - m.b) / 2;
  const scale = (H - m.t - m.b) / 2 / maxAbs;
  const svg = svgRoot(W, H, opts.label || 'Balkendiagramm');
  svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: mid, y2: mid, class: 'grid' }));
  values.forEach((v, i) => {
    const h = Math.abs(v) * scale;
    const x = m.l + i * bw + bw * 0.22;
    const cls = opts.highlight === i ? 'bar bar-hi' : v < 0 ? 'bar bar-neg' : 'bar';
    svg.appendChild(el('rect', { x, y: v >= 0 ? mid - h : mid, width: bw * 0.56, height: Math.max(1, h), rx: 2, class: cls }));
    svg.appendChild(el('text', { x: x + bw * 0.28, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, labels[i]));
    if (opts.fmt) svg.appendChild(el('text', { x: x + bw * 0.28, y: v >= 0 ? mid - h - 4 : mid + h + 11, class: 'tick', 'text-anchor': 'middle' }, opts.fmt(v)));
  });
  return svg;
}

/** Kleine Legende als HTML. */
export function legend(items) {
  const div = document.createElement('div');
  div.className = 'legend';
  for (const it of items) {
    const s = document.createElement('span');
    s.innerHTML = `<i class="sw ${it.cls}"></i>`;
    s.append(it.label);
    div.appendChild(s);
  }
  return div;
}
