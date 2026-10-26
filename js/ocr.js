/* Plate OCR — runs fully on-device with Tesseract.js (no network calls).
 * Takes a canvas cropped to the framing box and returns ranked plate-text candidates. */
(function (global) {
  'use strict';

  const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let worker = null;
  let initPromise = null;

  function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      worker = await Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: new URL('vendor/worker.min.js', document.baseURI).href,
        corePath: new URL('vendor/core/', document.baseURI).href,
        langPath: new URL('vendor/lang', document.baseURI).href,
        gzip: true,
        workerBlobURL: false,
        logger: (m) => { if (onProgress && m && m.status) onProgress(m); },
      });
      await worker.setParameters({
        tessedit_char_whitelist: WHITELIST,
        user_defined_dpi: '300',
        debug_file: '/dev/null', // silence engine diagnostics
      });
      return worker;
    })();
    initPromise.catch(() => { initPromise = null; });
    return initPromise;
  }

  /* ---------- image helpers ---------- */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  // Grayscale + percentile contrast stretch. Returns {canvas, gray(Uint8Array)}
  function toGray(src, targetH) {
    const scale = targetH / src.height;
    const c = makeCanvas(src.width * scale, src.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data, n = c.width * c.height;
    const g = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      // weight toward the darkest channel: helps colored text (green/blue/red) on light plates
      const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      const mn = Math.min(d[p], d[p + 1], d[p + 2]);
      const v = (lum * 0.5 + mn * 0.5) | 0;
      g[i] = v; hist[v]++;
    }
    let lo = 0, hi = 255, acc = 0;
    const cut = n * 0.01;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) {
      let v = ((g[i] - lo) * 255) / span;
      g[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return { w: c.width, h: c.height, g };
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Local (Bradley) adaptive threshold — copes with uneven garage lighting / shadows
  function adaptive(gr, win, pct) {
    const { w, h, g } = gr;
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += g[(y - 1) * w + (x - 1)];
        integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + row;
      }
    }
    const out = new Uint8Array(w * h);
    const r = Math.max(4, (win / 2) | 0);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s = integ[(y1 + 1) * (w + 1) + (x1 + 1)] - integ[y0 * (w + 1) + (x1 + 1)]
          - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        out[y * w + x] = g[y * w + x] * cnt < s * (1 - pct) ? 0 : 255;
      }
    }
    return { w, h, g: out };
  }

  function binarize(gr, thr) {
    const out = new Uint8Array(gr.g.length);
    for (let i = 0; i < gr.g.length; i++) out[i] = gr.g[i] > thr ? 255 : 0;
    return { w: gr.w, h: gr.h, g: out };
  }

  // Plates are dark text on light background. If the majority is dark, invert.
  // Judged on the center of the frame (the plate), not the car body around it.
  function ensureDarkOnLight(b) {
    let dark = 0, n = 0;
    const x0 = (b.w * 0.2) | 0, x1 = (b.w * 0.8) | 0, y0 = (b.h * 0.2) | 0, y1 = (b.h * 0.8) | 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; if (b.g[y * b.w + x] < 128) dark++; }
    if (dark > n * 0.6) for (let i = 0; i < b.g.length; i++) b.g[i] = 255 - b.g[i];
    return b;
  }

  // Whiten every dark region touching the frame edge (car body, bumper, plate frame,
  // background) so only characters floating on the plate remain.
  function clearBorder(b) {
    const { w, h } = b;
    const g = new Uint8Array(b.g);
    const stack = [];
    const push = (x, y) => { const i = y * w + x; if (g[i] === 0) { g[i] = 255; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
    let dark = 0;
    for (let i = 0; i < g.length; i++) if (g[i] === 0) dark++;
    // if almost nothing is left the text itself touched the edge — keep original
    return dark > g.length * 0.01 ? { w, h, g } : b;
  }

  function toCanvas(gr, pad) {
    pad = pad || 0;
    const c = makeCanvas(gr.w + pad * 2, gr.h + pad * 2);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const img = ctx.createImageData(gr.w, gr.h);
    for (let i = 0, p = 0; i < gr.g.length; i++, p += 4) {
      img.data[p] = img.data[p + 1] = img.data[p + 2] = gr.g[i]; img.data[p + 3] = 255;
    }
    ctx.putImageData(img, pad, pad);
    return c;
  }

  function cropGray(gr, x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(gr.w, x1 | 0); y1 = Math.min(gr.h, y1 | 0);
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(gr.g.subarray((y0 + y) * gr.w + x0, (y0 + y) * gr.w + x0 + w), y * w);
    return { w, h, g: out };
  }

  /* ---------- tesseract helpers ---------- */
  function parseTSV(tsv) {
    const words = [];
    (tsv || '').split('\n').forEach((line) => {
      const f = line.split('\t');
      if (f.length < 12 || f[0] !== '5') return;
      const text = (f[11] || '').replace(/[^A-Z0-9]/g, '');
      if (!text) return;
      words.push({
        line: f[2] + '.' + f[3] + '.' + f[4],
        x: +f[6], y: +f[7], w: +f[8], h: +f[9], conf: +f[10], text,
      });
    });
    return words;
  }

  async function rec(canvas, psm) {
    await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    const r = await worker.recognize(canvas, {}, { text: true, tsv: true });
    return r.data;
  }

  // Pick the main plate characters: the tallest text on the plate (state name and
  // slogans are smaller). Words of similar height on the same row are joined (e.g. "ZZE 4021").
  function mainLine(words) {
    const good = words.filter((w) => w.h > 0 && w.text.length >= 1);
    if (!good.length) return null;
    const maxH = Math.max(...good.map((w) => w.h));
    const big = good.filter((w) => w.h >= maxH * 0.62);
    // anchor = the tallest word; keep words vertically overlapping it
    const anchor = big.reduce((a, b) => (b.h > a.h ? b : a));
    const cy = anchor.y + anchor.h / 2;
    const row = big.filter((w) => Math.abs((w.y + w.h / 2) - cy) < anchor.h * 0.5).sort((a, b) => a.x - b.x);
    const text = row.map((w) => w.text).join('');
    const conf = row.reduce((s, w) => s + w.conf * w.text.length, 0) / Math.max(1, text.length);
    const x0 = Math.min(...row.map((w) => w.x)), y0 = Math.min(...row.map((w) => w.y));
    const x1 = Math.max(...row.map((w) => w.x + w.w)), y1 = Math.max(...row.map((w) => w.y + w.h));
    return { text, conf, box: { x0, y0, x1, y1 }, charH: maxH };
  }

  function plausible(t) { return t.length >= 2 && t.length <= 8; }

  /**
   * read(srcCanvas) -> { best, candidates:[{text,conf,src}], ms }
   * srcCanvas: color canvas cropped to the framing box.
   */
  async function read(src) {
    await init();
    const t0 = performance.now();
    const cands = [];
    const add = (text, conf, s) => {
      if (!text) return;
      text = text.replace(/[^A-Z0-9]/g, '');
      if (!plausible(text)) return;
      cands.push({ text, conf: Math.round(conf), src: s });
    };

    const gray = toGray(src, 360);

    // Pass 1: sparse text on the whole crop (two binarizations) to locate the main row.
    const bin1 = clearBorder(ensureDarkOnLight(adaptive(gray, Math.round(gray.h / 3), 0.15)));
    const bin2 = clearBorder(ensureDarkOnLight(binarize(gray, otsu(gray.g))));
    let line = null;
    const allWords = [];
    for (const [b, name] of [[bin1, 'adaptive'], [bin2, 'otsu']]) {
      const d = await rec(toCanvas(b, 10), 11);
      const ws = parseTSV(d.tsv);
      ws.forEach((w) => allWords.push(w.text));
      const ml = mainLine(ws);
      if (ml) {
        add(ml.text, ml.conf, name + '-sparse');
        if (!line || ml.conf * ml.text.length > line.conf * line.text.length) line = Object.assign({ bin: b }, ml);
      }
    }

    // Pass 2: crop tightly to the detected main row and read it as a single line.
    if (line) {
      const bx = line.box, padX = line.charH * 0.6, padY = line.charH * 0.25;
      const x0 = bx.x0 - 10 - padX, y0 = bx.y0 - 10 - padY, x1 = bx.x1 - 10 + padX, y1 = bx.y1 - 10 + padY;
      const sub = cropGray(gray, x0, y0, x1, y1);
      // normalize char height to ~70px for the single-line pass
      const scale = 90 / Math.max(1, sub.h);
      const sc = toCanvas(sub);
      const tmp = makeCanvas(sub.w * scale, sub.h * scale);
      tmp.getContext('2d').drawImage(sc, 0, 0, tmp.width, tmp.height);
      const g2 = toGray(tmp, tmp.height);
      for (const [b, name] of [
        [clearBorder(ensureDarkOnLight(binarize(g2, otsu(g2.g)))), 'line-otsu'],
        [clearBorder(ensureDarkOnLight(adaptive(g2, Math.round(g2.h * 0.9), 0.12))), 'line-adaptive'],
      ]) {
        const d = await rec(toCanvas(b, 16), 7);
        const ws = parseTSV(d.tsv);
        const txt = ws.map((w) => w.text).join('');
        const conf = ws.reduce((s, w) => s + w.conf * w.text.length, 0) / Math.max(1, txt.length);
        add(txt, conf, name);
      }
    }

    // Pass 3: the user centers the plate in a 2:1 box, so the main characters sit in the
    // middle band. Read that band as one line — catches plates where pass 1 latched onto
    // the state name or slogan instead.
    {
      const y0 = Math.round(gray.h * 0.22), y1 = Math.round(gray.h * 0.80);
      const x0 = Math.round(gray.w * 0.04), x1 = Math.round(gray.w * 0.96);
      const band = cropGray(gray, x0, y0, x1, y1);
      const b = clearBorder(ensureDarkOnLight(binarize(band, otsu(band.g))));
      const d = await rec(toCanvas(b, 16), 7);
      const ws = parseTSV(d.tsv);
      const txt = ws.map((w) => w.text).join('');
      const conf = ws.reduce((s, w) => s + w.conf * w.text.length, 0) / Math.max(1, txt.length);
      add(txt, conf, 'band');
    }

    // Rank: vote across passes (agreement counts), then confidence.
    const byText = new Map();
    cands.forEach((c) => {
      const e = byText.get(c.text) || { text: c.text, conf: 0, votes: 0, srcs: [] };
      e.votes++; e.conf = Math.max(e.conf, c.conf); e.srcs.push(c.src);
      byText.set(c.text, e);
    });
    // A short read contained in a longer one is often a truncated version of it (e.g. "CBT1"
    // vs "CBT1098" on a tilted plate), so the longer read gets partial credit. The reverse also
    // happens: a plate edge or bolt read as a stray I/1/L at either end ("HTG5523I"), so offer
    // the trimmed version too.
    const all = [...byText.values()];
    const base = new Map(all.map((e) => [e.text, e.votes]));
    all.forEach((l) => {
      all.forEach((sh) => {
        if (sh !== l && l.text.length > sh.text.length && l.text.includes(sh.text)) l.votes += base.get(sh.text) * 0.5;
      });
    });
    all.slice().forEach((e) => {
      let t = e.text;
      while (t.length > 5 && /[I1L]/.test(t[t.length - 1])) t = t.slice(0, -1);
      while (t.length > 5 && /[I1L]/.test(t[0])) t = t.slice(1);
      if (t === e.text) return;
      const ex = all.find((x) => x.text === t);
      if (ex) ex.votes += base.get(e.text) * 0.5;
      else all.push({ text: t, conf: e.conf, votes: base.get(e.text) * 0.5, srcs: ['trimmed'] });
    });
    // most plates are 5-8 characters; short fragments (often the state name) rank lower
    const fit = (e) => e.votes + (e.text.length >= 5 && e.text.length <= 8 ? 0.6 : 0);
    const ranked = all.filter((e) => e.votes > 0)
      .sort((a, b) => (fit(b) - fit(a)) || (b.conf - a.conf) || (b.text.length - a.text.length));
    return { best: ranked[0] ? ranked[0].text : '', candidates: ranked.slice(0, 5), words: allWords, ms: Math.round(performance.now() - t0) };
  }

  global.PlateOCR = { init, read, isReady: () => !!worker };
})(window);
