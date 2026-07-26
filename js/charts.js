/** Small dependency-free SVG line chart with hover readout. */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param opts.series [{label, color, points:[[x,y],…]}]  x ascending, shared grid
 * @param opts.log    log-scale the y axis (values <= 0 are dropped)
 * @param opts.fmtY   (v) => string
 * @param opts.fmtX   (x) => string
 * @param opts.marks  [{x, label}] vertical reference lines
 */
export function lineChart(opts) {
  const {
    series, log = false, fmtY = (v) => String(v), fmtX = (x) => String(x),
    marks = [], height = 260, yTicks = 5,
  } = opts;

  const W = 1000; // viewBox units; the SVG scales to its container
  const H = height;
  const pad = { l: 66, r: 14, t: 12, b: 30 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const visible = series.filter((s) => s.points.length);
  if (!visible.length) return `<p class="muted small">No data in this range.</p>`;

  const xs = visible.flatMap((s) => s.points.map((p) => p[0]));
  const ysRaw = visible.flatMap((s) => s.points.map((p) => p[1])).filter((v) => isFinite(v) && (!log || v > 0));
  if (!ysRaw.length) return `<p class="muted small">No data in this range.</p>`;

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ysRaw);
  let yMax = Math.max(...ysRaw);
  if (log) {
    yMin = Math.max(yMin, yMax / 1e7);
  } else {
    yMin = Math.min(0, yMin);
  }
  if (yMax === yMin) yMax = yMin + 1;

  const tx = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * plotW;
  const ty = (y) => {
    if (log) {
      const a = Math.log10(Math.max(y, yMin));
      const lo = Math.log10(yMin);
      const hi = Math.log10(yMax);
      return pad.t + plotH - ((a - lo) / (hi - lo || 1)) * plotH;
    }
    return pad.t + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH;
  };

  // y gridlines
  const gridVals = [];
  for (let i = 0; i <= yTicks; i++) {
    gridVals.push(log
      ? 10 ** (Math.log10(yMin) + (i / yTicks) * (Math.log10(yMax) - Math.log10(yMin)))
      : yMin + (i / yTicks) * (yMax - yMin));
  }

  const grid = gridVals
    .map(
      (v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${ty(v).toFixed(1)}" y2="${ty(v).toFixed(1)}"
        stroke="currentColor" stroke-opacity=".10"/>
      <text x="${pad.l - 8}" y="${(ty(v) + 3.5).toFixed(1)}" text-anchor="end"
        fill="currentColor" fill-opacity=".55" font-size="11">${escXml(fmtY(v))}</text>`
    )
    .join('');

  // x labels (5 across)
  const xLabels = Array.from({ length: 5 }, (_, i) => xMin + (i / 4) * (xMax - xMin))
    .map(
      (x) => `<text x="${tx(x).toFixed(1)}" y="${H - 9}" text-anchor="middle"
        fill="currentColor" fill-opacity=".55" font-size="11">${escXml(fmtX(x))}</text>`
    )
    .join('');

  const markEls = marks
    .filter((m) => m.x >= xMin && m.x <= xMax)
    .map(
      (m) => `<line x1="${tx(m.x).toFixed(1)}" x2="${tx(m.x).toFixed(1)}" y1="${pad.t}" y2="${pad.t + plotH}"
        stroke="var(--gold)" stroke-opacity=".55" stroke-dasharray="3 3"/>
      <text x="${(tx(m.x) + 4).toFixed(1)}" y="${pad.t + 11}" fill="var(--gold)" fill-opacity=".85"
        font-size="10.5">${escXml(m.label)}</text>`
    )
    .join('');

  const paths = visible
    .map((s) => {
      let d = '';
      let open = false;
      for (const [x, y] of s.points) {
        if (!isFinite(y) || (log && y <= 0)) {
          open = false;
          continue;
        }
        d += `${open ? 'L' : 'M'}${tx(x).toFixed(1)} ${ty(y).toFixed(1)}`;
        open = true;
      }
      return `<path d="${d}" fill="none" stroke="${escXml(s.color)}" stroke-width="1.8"
        stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    })
    .join('');

  const payload = escXml(
    JSON.stringify({
      pad, plotW, plotH, xMin, xMax,
      series: visible.map((s) => ({ label: s.label, color: s.color, points: s.points })),
    })
  );

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" data-chart="${payload}" style="height:${H}px">
    ${grid}${markEls}${xLabels}${paths}
    <g class="cursor" style="display:none">
      <line y1="${pad.t}" y2="${pad.t + plotH}" stroke="currentColor" stroke-opacity=".45"/>
    </g>
    <rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="transparent" class="hit"/>
  </svg>
  <div class="chart-readout muted small"></div>`;
}

const escXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Attach hover readouts to every chart inside root.
 * @param fmt ({x, values:[{label,color,value}]}) => html
 */
export function attachHover(root, fmt) {
  root.querySelectorAll('svg.chart-svg').forEach((svg) => {
    let cfg;
    try {
      cfg = JSON.parse(svg.dataset.chart);
    } catch {
      return;
    }
    const cursor = svg.querySelector('.cursor');
    const line = cursor.querySelector('line');
    const readout = svg.parentElement.querySelector('.chart-readout');
    const hit = svg.querySelector('.hit');

    const move = (evt) => {
      const rect = svg.getBoundingClientRect();
      const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      const vx = ((clientX - rect.left) / rect.width) * 1000;
      const frac = Math.max(0, Math.min(1, (vx - cfg.pad.l) / cfg.plotW));
      const x = cfg.xMin + frac * (cfg.xMax - cfg.xMin);

      const values = cfg.series.map((s) => {
        let best = null;
        let bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p[0] - x);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        return { label: s.label, color: s.color, value: best ? best[1] : null, x: best ? best[0] : null };
      });
      const snapX = values.find((v) => v.x != null)?.x ?? x;
      const px = cfg.pad.l + ((snapX - cfg.xMin) / (cfg.xMax - cfg.xMin || 1)) * cfg.plotW;
      line.setAttribute('x1', px);
      line.setAttribute('x2', px);
      cursor.style.display = '';
      readout.innerHTML = fmt({ x: snapX, values });
    };

    const leave = () => {
      cursor.style.display = 'none';
      readout.innerHTML = '';
    };

    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchend', leave);
  });
}
