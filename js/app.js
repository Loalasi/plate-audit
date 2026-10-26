/* Garage Plate Audit — main app. Everything runs and is stored on this device. */
(function () {
  'use strict';
  const APP_VERSION = '1.0.0';

  /* ================= helpers ================= */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  /* ---------- sheet (modal) ---------- */
  let sheetOnClose = null;
  function openSheet(html, opts) {
    opts = opts || {};
    const sh = $('#sheet');
    sh.innerHTML = html;
    sh.classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
    sh.scrollTop = 0;
    sheetOnClose = opts.onClose || null;
    $('#sheetBackdrop').onclick = opts.modal ? null : () => closeSheet();
    $$('[data-close]', sh).forEach((b) => b.addEventListener('click', () => closeSheet()));
    if (!history.state || !history.state.sheet) history.pushState({ sheet: true }, '');
    return sh;
  }
  function closeSheet(fromPop) {
    const sh = $('#sheet');
    if (sh.classList.contains('hidden')) return;
    sh.classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden');
    sh.innerHTML = '';
    const cb = sheetOnClose; sheetOnClose = null;
    // (the history entry is left in place; the next sheet reuses it so Android "back" still closes sheets)
    if (cb) cb();
  }
  window.addEventListener('popstate', () => closeSheet(true));

  function confirmBox(title, body, okLabel, danger) {
    return new Promise((resolve) => {
      let done = false;
      const sh = openSheet(`<h2>${esc(title)}</h2><p>${body}</p>
        <div class="btn-row"><button class="btn" id="cbNo">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cbYes">${esc(okLabel || 'OK')}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
      $('#cbNo', sh).onclick = () => closeSheet();
      $('#cbYes', sh).onclick = () => { done = true; closeSheet(); resolve(true); };
    });
  }

  /* ================= state ================= */
  const DEFAULTS = {
    title: 'HES Garage Audit',
    auditor: '',
    levels: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6'],
    defaultState: 'CO',
    autoState: true,
    photos: 'nonmatch', // nonmatch | all | off
    sound: true,
    vibrate: true,
    border: 'large', // medium | large | xl
    keepAudits: 10,
    savedMapping: null,
  };
  let S = Object.assign({}, DEFAULTS);
  let LIST = null; // vehicle list
  let AUDIT = null; // current open audit
  let currentLevel = null;
  let pastIndex = new Map(); // plateNorm -> {count, last, lastStatus, badCount}

  async function saveSettings() { await DB.set('settings', S); }
  async function saveAudit() { if (AUDIT) await DB.putAudit(AUDIT); }

  function applyTitle() {
    $('#appTitle').textContent = S.title;
    document.title = S.title;
  }
  function applyBorder() {
    const w = { medium: '18px', large: '30px', xl: '48px' }[S.border] || '30px';
    document.documentElement.style.setProperty('--border-w', w);
  }

  /* ================= navigation ================= */
  let view = 'scan';
  function show(v) {
    view = v;
    $$('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    if (v === 'scan') { Camera.start(); renderScanChrome(); } else Camera.stop();
    if (v === 'log') renderLog();
    if (v === 'reports') renderReports();
    if (v === 'settings') renderSettings();
  }
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#helpBtn').addEventListener('click', () => openHelp());

  /* ================= feedback (sound / vibration / border) ================= */
  const Feedback = (() => {
    let ctx = null;
    function ac() {
      if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (C) ctx = new C(); }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, start, dur, type, gain) {
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime + start);
      g.gain.exponentialRampToValueAtTime(gain, c.currentTime + start + 0.01);
      g.gain.setValueAtTime(gain, c.currentTime + start + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
      o.connect(g).connect(c.destination); o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
    }
    return {
      unlock: () => ac(),
      good() {
        if (S.sound) { tone(988, 0, 0.12, 'sine', 0.5); tone(1319, 0.15, 0.18, 'sine', 0.5); }
        if (S.vibrate && navigator.vibrate) navigator.vibrate(60);
      },
      bad() {
        if (S.sound) { tone(150, 0, 0.55, 'square', 0.35); tone(118, 0, 0.55, 'sawtooth', 0.25); tone(150, 0.7, 0.4, 'square', 0.35); }
        if (S.vibrate && navigator.vibrate) navigator.vibrate([400, 120, 400]);
      },
      warn() { if (S.sound) tone(660, 0, 0.15, 'triangle', 0.4); if (S.vibrate && navigator.vibrate) navigator.vibrate(120); },
      border(kind) { const b = $('#resultBorder'); b.className = kind || ''; },
    };
  })();

  /* ================= camera ================= */
  const Camera = (() => {
    const video = $('#video');
    let stream = null, track = null, starting = null, torchOn = false, wakeLock = null;

    function msg(html) {
      const m = $('#camMsg');
      if (!html) { m.classList.add('hidden'); m.innerHTML = ''; return; }
      m.innerHTML = html; m.classList.remove('hidden');
      const r = $('#camRetry', m); if (r) r.onclick = () => start();
    }

    async function lockScreen() {
      try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* not supported */ }
    }

    async function start() {
      if (stream || starting) return starting;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        msg(`<b>Camera not available.</b><div class="hint">The camera only works when the app is opened from its https:// web address (not a downloaded file). You can still use <b>Type plate</b>.</div>`);
        return;
      }
      starting = (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          });
          track = stream.getVideoTracks()[0];
          video.srcObject = stream;
          await video.play().catch(() => {});
          msg('');
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          // continuous autofocus where supported
          try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* ignore */ }
          $('#torchBtn').classList.toggle('hidden', !caps.torch);
          if (caps.zoom && caps.zoom.max > caps.zoom.min) {
            const z = $('#zoom');
            z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, caps.zoom.min * 8); z.step = caps.zoom.step || 0.1;
            const st = track.getSettings ? track.getSettings() : {};
            z.value = st.zoom || caps.zoom.min;
            z.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(z.value) }] }).catch(() => {});
            $('#zoomWrap').classList.remove('hidden');
          } else $('#zoomWrap').classList.add('hidden');
          if (torchOn) setTorch(true);
          lockScreen();
        } catch (e) {
          stream = null; track = null;
          const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
          msg(denied
            ? `<b>Camera permission is blocked.</b><div class="hint">Allow camera access for this site in your browser settings, then tap Retry.<br>Android Chrome: tap the icon left of the address → Permissions → Camera → Allow.<br>iPhone: Settings → Safari → Camera → Allow (or Ask).</div><button class="btn primary" id="camRetry">Retry</button>`
            : `<b>Couldn't start the camera.</b><div class="hint">${esc(e && e.message || e)}</div><button class="btn primary" id="camRetry">Retry</button>`);
        } finally { starting = null; }
      })();
      return starting;
    }

    function stop() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null; track = null; video.srcObject = null;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }

    async function setTorch(on) {
      torchOn = on;
      $('#torchBtn').setAttribute('aria-pressed', String(on));
      if (!track) return;
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); } catch (e) { toast('Flashlight not supported on this camera'); }
    }

    // Grab the full frame and the region under the guide box (accounts for object-fit: cover).
    function grab() {
      if (!stream || !video.videoWidth) return null;
      const vw = video.videoWidth, vh = video.videoHeight;
      const full = document.createElement('canvas');
      full.width = vw; full.height = vh;
      full.getContext('2d').drawImage(video, 0, 0, vw, vh);
      const wrap = $('#camWrap').getBoundingClientRect(), g = $('#guide').getBoundingClientRect();
      const scale = Math.max(wrap.width / vw, wrap.height / vh);
      const ox = (wrap.width - vw * scale) / 2, oy = (wrap.height - vh * scale) / 2;
      // expand the guide box slightly so a plate touching the edge still reads
      const ex = g.width * 0.04, ey = g.height * 0.06;
      let sx = (g.left - wrap.left - ex - ox) / scale, sy = (g.top - wrap.top - ey - oy) / scale;
      let sw = (g.width + ex * 2) / scale, sh = (g.height + ey * 2) / scale;
      sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
      const crop = document.createElement('canvas');
      crop.width = Math.round(sw); crop.height = Math.round(sh);
      crop.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      return { full, crop };
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop(); else if (view === 'scan') start();
    });

    return { start, stop, grab, setTorch, toggleTorch: () => setTorch(!torchOn), isOn: () => !!stream };
  })();

  $('#torchBtn').addEventListener('click', () => Camera.toggleTorch());

  /* ================= scan chrome (levels, counters) ================= */
  function renderLevels() {
    const bar = $('#levelBar');
    if (!S.levels.includes(currentLevel)) currentLevel = S.levels[0] || null;
    bar.innerHTML = S.levels.map((l) => `<button class="chip ${l === currentLevel ? 'on' : ''}" role="radio" aria-checked="${l === currentLevel}" data-level="${esc(l)}">${esc(l)}</button>`).join('');
    $$('.chip', bar).forEach((b) => b.addEventListener('click', () => {
      currentLevel = b.dataset.level; DB.set('currentLevel', currentLevel); renderLevels();
    }));
  }
  function renderScanChrome() {
    renderLevels();
    const scans = AUDIT ? AUDIT.scans : [];
    const bad = scans.filter((s) => !Exporter.isGood(s)).length;
    $('#counter').innerHTML = AUDIT
      ? `<span class="pill">${scans.length} scanned</span><span class="pill ${bad ? 'bad' : 'good'}">${bad} non-match</span>`
      : '';
    const pill = $('#auditPill');
    if (AUDIT) { pill.textContent = `Audit in progress · ${Exporter.fmtTime(AUDIT.startedAt)}`; pill.className = 'pill warn'; }
    else { pill.textContent = 'No audit started'; pill.className = 'pill muted'; }
    $('#finishBtn').classList.toggle('hidden', !AUDIT);
  }

  /* ================= audits & history ================= */
  async function buildPastIndex() {
    pastIndex = new Map();
    const all = await DB.allAudits();
    all.forEach((a) => {
      if (AUDIT && a.id === AUDIT.id) return;
      const seenHere = new Set();
      (a.scans || []).forEach((s) => {
        if (!s.plateNorm || seenHere.has(s.plateNorm)) return;
        seenHere.add(s.plateNorm);
        const e = pastIndex.get(s.plateNorm) || { count: 0, last: null, lastStatus: null, badCount: 0 };
        e.count++;
        if (!Exporter.isGood(s)) e.badCount++;
        if (!e.last || a.startedAt > e.last) { e.last = a.startedAt; e.lastStatus = s.status; }
        pastIndex.set(s.plateNorm, e);
      });
    });
  }

  async function ensureListLoaded() {
    if (LIST && LIST.vehicles && LIST.vehicles.length) return true;
    const go = await confirmBox('Load your vehicle list first', 'The audit checks plates against your registered vehicle Excel file. Load it now?', 'Load vehicle list');
    if (go) { show('settings'); startImport(); }
    return false;
  }

  function startAuditDialog() {
    return new Promise((resolve) => {
      let ok = false;
      const sh = openSheet(`
        <div class="sheet-head"><h2>Start a new audit</h2><button class="close-x" data-close aria-label="Close">×</button></div>
        <label class="field"><span>Auditor name</span><input id="auName" class="input" value="${esc(S.auditor)}" autocomplete="name"></label>
        <label class="field"><span>Starting level / zone</span><select id="auLevel" class="input">${S.levels.map((l) => `<option ${l === currentLevel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <p class="hint">Vehicle list: <b>${esc(LIST.fileName || 'loaded')}</b> · ${LIST.counts.active} active vehicles · loaded ${Exporter.fmtDate(LIST.importedAt)}</p>
        <div class="btn-row"><button class="btn primary block" id="auGo">Start audit</button></div>`,
      { onClose: () => { if (!ok) resolve(false); } });
      $('#auGo', sh).onclick = async () => {
        const name = $('#auName', sh).value.trim();
        S.auditor = name; await saveSettings();
        currentLevel = $('#auLevel', sh).value; DB.set('currentLevel', currentLevel);
        AUDIT = { id: uid(), title: S.title, auditor: name, startedAt: nowIso(), finishedAt: null, status: 'open', listFile: LIST.fileName, listImportedAt: LIST.importedAt, scans: [] };
        await saveAudit(); await DB.set('openAuditId', AUDIT.id);
        await pruneAudits();
        await buildPastIndex();
        ok = true; closeSheet(); renderScanChrome(); resolve(true);
        toast('Audit started — scan your first plate');
      };
    });
  }

  async function pruneAudits() {
    const all = await DB.allAudits(); // newest first
    const keep = Math.max(1, Number(S.keepAudits) || 10);
    const done = all.filter((a) => a.status === 'done' && (!AUDIT || a.id !== AUDIT.id));
    const openCount = all.length - done.length;
    const removable = done.slice(Math.max(0, keep - openCount));
    for (const a of removable) await DB.delAudit(a.id);
  }

  async function requireAudit() {
    if (AUDIT) return true;
    if (!(await ensureListLoaded())) return false;
    return startAuditDialog();
  }

  async function finishAudit() {
    if (!AUDIT) return;
    const n = AUDIT.scans.length;
    const ok = await confirmBox('Finish this audit?', `${n} vehicle${n === 1 ? '' : 's'} scanned. You'll go to Reports to export the Excel file, photos and PDF summary. You can reopen it later if needed.`, 'Finish audit');
    if (!ok) return;
    AUDIT.finishedAt = nowIso(); AUDIT.status = 'done';
    await saveAudit(); await DB.del('openAuditId');
    const id = AUDIT.id; AUDIT = null;
    await buildPastIndex();
    renderScanChrome();
    show('reports');
    highlightReport = id;
    renderReports();
  }
  $('#finishBtn').addEventListener('click', finishAudit);

  async function reopenAudit(id) {
    if (AUDIT) { toast('Finish the current audit first'); return; }
    const a = await DB.getAudit(id);
    a.status = 'open'; a.finishedAt = null;
    AUDIT = a; await saveAudit(); await DB.set('openAuditId', a.id);
    await buildPastIndex();
    show('scan'); toast('Audit reopened');
  }

  /* ================= capture → confirm → validate ================= */
  let busy = false;
  $('#captureBtn').addEventListener('click', async () => {
    Feedback.unlock();
    if (busy) return;
    if (!(await requireAudit())) return;
    const shot = Camera.grab();
    if (!shot) { toast('Camera is not ready yet'); Camera.start(); return; }
    busy = true;
    try { await confirmFlow({ shot }); } finally { busy = false; }
  });
  $('#manualBtn').addEventListener('click', async () => {
    Feedback.unlock();
    if (!(await requireAudit())) return;
    confirmFlow({ shot: Camera.grab() /* keep a photo if camera is on */, manual: true });
  });
  $('#noPlateBtn').addEventListener('click', async () => {
    Feedback.unlock();
    if (!(await requireAudit())) return;
    noPlateFlow(Camera.grab());
  });

  function stateOptions(sel) {
    const opts = Vehicles.STATES.map(([c, n]) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c} – ${n.charAt(0) + n.slice(1).toLowerCase()}</option>`).join('');
    return `<option value="" ${!sel ? 'selected' : ''}>Unknown / skip state check</option>${opts}`;
  }

  function evBlock(prefix) {
    return `<div class="switch"><div><b>EV charging space</b><div class="hint">Turn on if this car is parked in an EV space</div></div><input type="checkbox" id="${prefix}Ev"></div>
      <div id="${prefix}EvQ" class="hidden"><div class="hint" style="margin-top:8px">Is the vehicle actively charging?</div>
        <div class="chip-row" style="padding-left:0"><button class="chip" data-charging="yes">Yes, charging</button><button class="chip" data-charging="no">No, not charging</button></div></div>`;
  }
  function wireEv(sh, prefix, state) {
    const cb = $(`#${prefix}Ev`, sh), q = $(`#${prefix}EvQ`, sh);
    cb.checked = !!state.space;
    q.classList.toggle('hidden', !cb.checked);
    const paint = () => $$('[data-charging]', q).forEach((b) => b.classList.toggle('on', state.charging === (b.dataset.charging === 'yes')));
    cb.onchange = () => { state.space = cb.checked; if (!cb.checked) state.charging = null; q.classList.toggle('hidden', !cb.checked); paint(); };
    $$('[data-charging]', q).forEach((b) => b.addEventListener('click', () => { state.charging = b.dataset.charging === 'yes'; paint(); }));
    paint();
  }

  /**
   * Confirm sheet. opts: {shot, manual, edit: scan}
   */
  function confirmFlow(opts) {
    return new Promise((resolve) => {
      const editing = opts.edit || null;
      const shot = opts.shot || null;
      const cropUrl = shot && !opts.manual ? shot.crop.toDataURL('image/jpeg', 0.85) : null;
      const ev = editing && editing.ev ? Object.assign({}, editing.ev) : { space: false, charging: null };
      let userTyped = !!editing || !!opts.manual;
      let ocrRead = editing ? editing.ocrRead : '';
      let detectedState = '';
      let settled = false;

      const sh = openSheet(`
        <div class="sheet-head"><h2>${editing ? 'Edit scan' : 'Confirm plate'}</h2><button class="close-x" data-close aria-label="Close">×</button></div>
        ${cropUrl ? `<img class="crop-preview" src="${cropUrl}" alt="Captured plate">` : ''}
        <div class="reading" id="cfReading">${cropUrl ? '<span class="spinner"></span> Reading plate…' : ''}</div>
        <input id="cfPlate" class="input plate-input" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="10" placeholder="ABC123" value="${esc(editing ? editing.plate : '')}">
        <div id="cfAlts" class="chip-row small" style="padding-left:0"></div>
        <div id="cfSuggWrap" class="hidden"><h3>On file — tap if this is the car</h3><div id="cfSugg" class="sugg"></div></div>
        <div class="row">
          <label class="field"><span>Plate state</span><select id="cfState" class="input">${stateOptions(editing ? editing.state : S.defaultState)}</select></label>
          <label class="field"><span>Level / zone</span><select id="cfLevel" class="input">${S.levels.map((l) => `<option ${l === (editing ? editing.level : currentLevel) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        </div>
        <div id="cfStateHint" class="hint"></div>
        ${evBlock('cf')}
        <label class="field"><span>Notes (optional)</span><input id="cfNotes" class="input" value="${esc(editing ? editing.notes : '')}" placeholder="e.g. parked across two spaces"></label>
        <div class="btn-row">
          ${editing ? '<button class="btn danger" id="cfDelete">Delete scan</button>' : `<button class="btn" id="cfRetake">${cropUrl ? 'Retake' : 'Cancel'}</button>`}
          <button class="btn primary" id="cfGo" style="flex:2 1 200px">${editing ? 'Save & re-check' : 'Validate'}</button>
        </div>`, { onClose: () => { if (!settled) resolve(null); } });

      const plateEl = $('#cfPlate', sh), stateEl = $('#cfState', sh);
      wireEv(sh, 'cf', ev);
      if (!cropUrl) setTimeout(() => plateEl.focus(), 50);

      const refresh = () => {
        const p = Vehicles.normPlate(plateEl.value);
        const sug = Vehicles.suggest(LIST, p, 4);
        const box = $('#cfSugg', sh);
        $('#cfSuggWrap', sh).classList.toggle('hidden', !sug.length || !p);
        box.innerHTML = sug.map((x, i) => `<button data-i="${i}"><span><span class="mono">${esc(x.v.plate)}</span> ${x.v.state ? `<span class="pill">${esc(x.v.state)}</span>` : ''}
          <div class="why">${esc(x.why)}${x.v.unit ? ' · Unit ' + esc(x.v.unit) : ''}${Vehicles.describe(x.v) ? ' · ' + esc(Vehicles.describe(x.v)) : ''}${x.v.active ? '' : ' · <b style="color:var(--bad)">inactive</b>'}</div></span><span>›</span></button>`).join('');
        $$('button', box).forEach((b) => b.addEventListener('click', () => {
          const v = sug[Number(b.dataset.i)].v;
          plateEl.value = v.plate; userTyped = true;
          refresh();
        }));
      };
      plateEl.addEventListener('input', () => {
        userTyped = true;
        const pos = plateEl.selectionStart;
        plateEl.value = plateEl.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '');
        try { plateEl.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
        refresh();
      });
      plateEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#cfGo', sh).click(); } });
      refresh();

      // OCR
      if (cropUrl) {
        const t0 = Date.now();
        PlateOCR.read(shot.crop).then((r) => {
          if (!sh.isConnected || $('#sheet').classList.contains('hidden')) return;
          ocrRead = r.best;
          // Prefer a reading that exactly matches a listed plate; otherwise, if the best read
          // differs from a listed plate only by look-alike characters (O/0, I/1, B/8…), use the listed one.
          let pick = r.best, note = '';
          const listed = new Set((LIST && LIST.vehicles || []).map((v) => v.plateNorm));
          const exactAlt = r.candidates.find((c) => listed.has(c.text));
          if (exactAlt && exactAlt.text !== r.best) { pick = exactAlt.text; note = ` (alternate read matches a listed plate)`; }
          else if (r.best && !listed.has(r.best)) {
            const cb = Vehicles.canon(r.best);
            const look = (LIST && LIST.vehicles || []).find((v) => v.plateCanon === cb);
            if (look) { pick = look.plateNorm; note = ` → corrected look-alike characters to listed plate`; }
          }
          $('#cfReading', sh).innerHTML = r.best
            ? `Read <b class="mono">${esc(r.best)}</b>${esc(note)} in ${((Date.now() - t0) / 1000).toFixed(1)}s — check it against the plate.`
            : 'Couldn’t read the plate — type it in, or tap Retake.';
          if (!userTyped && pick) { plateEl.value = pick; refresh(); }
          const alts = r.candidates.filter((c) => c.text !== Vehicles.normPlate(plateEl.value));
          $('#cfAlts', sh).innerHTML = alts.map((c) => `<button class="chip mono" data-t="${esc(c.text)}">${esc(c.text)}</button>`).join('');
          $$('#cfAlts .chip', sh).forEach((b) => b.addEventListener('click', () => { plateEl.value = b.dataset.t; userTyped = true; refresh(); }));
          if (S.autoState && r.words) {
            detectedState = Vehicles.detectState(r.words);
            if (detectedState && !editing) {
              stateEl.value = detectedState;
              $('#cfStateHint', sh).textContent = `State set to ${detectedState} from the plate text — change it if wrong.`;
            }
          }
          if (!r.best) plateEl.focus();
        }).catch((e) => {
          $('#cfReading', sh).textContent = 'Plate reader error — type the plate in. (' + (e && e.message || e) + ')';
        });
      }

      if (!editing) $('#cfRetake', sh).onclick = () => closeSheet();
      else $('#cfDelete', sh).onclick = async () => {
        settled = true; closeSheet();
        if (await confirmBox('Delete this scan?', `Plate <b class="mono">${esc(editing.plate || '(none)')}</b> will be removed from the audit.`, 'Delete', true)) {
          await deleteScan(editing.id); renderLog(); renderScanChrome();
        }
        resolve(null);
      };

      $('#cfGo', sh).onclick = async () => {
        const plate = plateEl.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim();
        if (Vehicles.normPlate(plate).length < 2) { toast('Enter the plate number'); plateEl.focus(); return; }
        if (ev.space && ev.charging == null) { toast('Answer: is the EV actively charging?'); return; }
        const data = {
          plate, plateNorm: Vehicles.normPlate(plate), state: stateEl.value, level: $('#cfLevel', sh).value,
          notes: $('#cfNotes', sh).value.trim(), ev: Object.assign({}, ev), ocrRead,
        };
        settled = true;
        if (editing) {
          closeSheet();
          await updateScan(editing, data);
          renderLog(); renderScanChrome();
          resolve(editing);
          return;
        }
        // duplicate check within this audit
        const dup = AUDIT.scans.find((s) => s.plateNorm === data.plateNorm);
        if (dup) {
          closeSheet();
          const replace = await confirmBox('Already scanned', `<b class="mono">${esc(dup.plate)}</b> was scanned at ${Exporter.fmtTime(dup.time)} on ${esc(dup.level)} (${esc(Exporter.STATUS_LABEL[dup.status])}). It won't be counted twice.<br><br>Replace the earlier entry with this one (new level/notes)?`, 'Replace earlier entry');
          if (replace) { await updateScan(dup, Object.assign(data, { time: nowIso() })); showResult(dup); }
          renderScanChrome();
          resolve(null);
          return;
        }
        closeSheet();
        const scan = await addScan(data, shot);
        showResult(scan);
        resolve(scan);
      };
    });
  }

  function noPlateFlow(shot) {
    const ev = { space: false, charging: null };
    const sh = openSheet(`
      <div class="sheet-head"><h2>Vehicle with no readable plate</h2><button class="close-x" data-close aria-label="Close">×</button></div>
      <p class="hint">Temporary paper tag, dealer plate, covered or missing plate.</p>
      <div class="row">
        <label class="field"><span>Make / model</span><input id="npMake" class="input" placeholder="e.g. Honda Civic"></label>
        <label class="field"><span>Color</span><input id="npColor" class="input" placeholder="e.g. Silver"></label>
      </div>
      <label class="field"><span>Temp tag # (if any)</span><input id="npTag" class="input mono" autocapitalize="characters"></label>
      <label class="field"><span>Level / zone</span><select id="npLevel" class="input">${S.levels.map((l) => `<option ${l === currentLevel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${evBlock('np')}
      <label class="field"><span>Notes</span><input id="npNotes" class="input" placeholder="e.g. paper tag expired, plate covered"></label>
      <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="npGo" style="flex:2 1 200px">Log vehicle</button></div>`);
    wireEv(sh, 'np', ev);
    $('#npGo', sh).onclick = async () => {
      if (ev.space && ev.charging == null) { toast('Answer: is the EV actively charging?'); return; }
      const tag = $('#npTag', sh).value.trim().toUpperCase();
      const data = {
        plate: '', plateNorm: '', state: '', level: $('#npLevel', sh).value, ev: Object.assign({}, ev),
        notes: [tag ? 'Temp tag ' + tag : '', $('#npNotes', sh).value.trim()].filter(Boolean).join(' · '),
        noPlate: { make: $('#npMake', sh).value.trim(), color: $('#npColor', sh).value.trim(), tag },
      };
      closeSheet();
      const scan = await addScan(data, shot);
      showResult(scan);
    };
  }

  function evaluate(data) {
    let status, flags = [], match = null;
    if (data.noPlate) status = 'NO_PLATE';
    else {
      const r = Vehicles.validate(LIST, data.plateNorm, data.state);
      status = r.status; flags = r.flags.slice();
      if (r.primary) {
        const v = r.primary;
        match = { unit: v.unit, name: v.name, state: v.state, vehicle: Vehicles.describe(v), statusRaw: v.statusRaw, permit: v.permit, others: r.entries.length - 1 };
      }
    }
    if (data.ev && data.ev.space && data.ev.charging === false) flags.push('EV_NOT_CHARGING');
    const hist = data.plateNorm ? pastIndex.get(data.plateNorm) : null;
    return { status, flags, match, history: hist ? Object.assign({}, hist) : (data.noPlate ? null : { count: 0 }) };
  }

  function photoName(scan, idx) {
    const short = { REGISTERED: 'OK', NOT_ON_FILE: 'NotOnFile', INACTIVE: 'Inactive', NO_PLATE: 'NoPlate' }[scan.status];
    const t = new Date(scan.time);
    const hm = String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0');
    return `${String(idx).padStart(3, '0')}_${scan.plateNorm || 'NOPLATE'}_${short}${scan.flags.includes('EV_NOT_CHARGING') ? '_EV' : ''}_${Exporter.safe(scan.level)}_${hm}.jpg`;
  }

  const toBlob = (canvas, q, maxW) => new Promise((res) => {
    let c = canvas;
    if (maxW && canvas.width > maxW) {
      c = document.createElement('canvas');
      c.width = maxW; c.height = Math.round(canvas.height * maxW / canvas.width);
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    }
    c.toBlob((b) => res(b), 'image/jpeg', q);
  });

  async function addScan(data, shot) {
    const scan = Object.assign({ id: uid(), time: nowIso() }, data, evaluate(data));
    AUDIT.scans.push(scan);
    const idx = AUDIT.scans.length;
    const wantPhoto = shot && (S.photos === 'all' || (S.photos === 'nonmatch' && !Exporter.isGood(scan)));
    if (wantPhoto) {
      try {
        const blob = await toBlob(shot.full, 0.72, 1600);
        const crop = data.noPlate ? null : await toBlob(shot.crop, 0.85, 900);
        scan.photoId = uid(); scan.photoName = photoName(scan, idx);
        await DB.putPhoto({ id: scan.photoId, auditId: AUDIT.id, blob, crop });
      } catch (e) { console.warn('photo save failed', e); }
    }
    await saveAudit();
    renderScanChrome();
    return scan;
  }

  async function updateScan(scan, data) {
    Object.assign(scan, data, evaluate(Object.assign({}, scan, data)));
    if (scan.photoId) scan.photoName = photoName(scan, AUDIT.scans.indexOf(scan) + 1);
    await saveAudit();
  }

  async function deleteScan(id) {
    const i = AUDIT.scans.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = AUDIT.scans.splice(i, 1);
    if (s.photoId) await DB.delPhoto(s.photoId);
    await saveAudit();
  }

  function showResult(scan) {
    const good = Exporter.isGood(scan);
    Feedback.border(good ? 'good' : 'bad');
    if (good) Feedback.good(); else Feedback.bad();
    const m = scan.match || {};
    const title = { REGISTERED: '✓ REGISTERED', NOT_ON_FILE: '✕ NOT ON FILE', INACTIVE: '✕ MOVED OUT / INACTIVE', NO_PLATE: '✕ NO PLATE' }[scan.status];
    const flags = [];
    if (scan.flags.includes('EV_NOT_CHARGING')) flags.push(`<div class="flag bad">⚡ Parked in an EV space and <b>not charging</b>.</div>`);
    if (scan.flags.includes('STATE_MISMATCH')) flags.push(`<div class="flag warn">⚠ State mismatch — plate entered as <b>${esc(scan.state || '?')}</b>, list says <b>${esc(m.state || '?')}</b>. Logged as a flag.</div>`);
    if (scan.status === 'INACTIVE') flags.push(`<div class="flag bad">Lease status on file: <b>${esc(m.statusRaw || 'inactive')}</b></div>`);
    if (scan.history) {
      if (!scan.history.count) flags.push(`<div class="flag new">★ First time this plate has been seen in an audit.</div>`);
      else flags.push(`<div class="flag ${scan.history.badCount && !good ? 'bad' : 'info'}">Seen in ${scan.history.count} prior audit${scan.history.count > 1 ? 's' : ''} (last ${Exporter.fmtDate(scan.history.last)} — ${esc(Exporter.STATUS_LABEL[scan.history.lastStatus] || '')})${scan.history.badCount && !good ? ' · <b>repeat non-match</b>' : ''}</div>`);
    }
    const details = scan.status === 'NO_PLATE'
      ? `<dl class="kv"><dt>Vehicle</dt><dd>${esc([scan.noPlate.color, scan.noPlate.make].filter(Boolean).join(' ') || '—')}</dd><dt>Level</dt><dd>${esc(scan.level)}</dd></dl>`
      : (scan.match ? `<dl class="kv">
          <dt>Unit</dt><dd>${esc(m.unit || '—')}</dd><dt>Resident</dt><dd>${esc(m.name || '—')}</dd>
          <dt>Vehicle on file</dt><dd>${esc(m.vehicle || '—')}</dd><dt>State on file</dt><dd>${esc(m.state || '—')}</dd>
          ${m.permit ? `<dt>Permit #</dt><dd>${esc(m.permit)}</dd>` : ''}${m.others ? `<dt>Note</dt><dd>${m.others} other list row(s) share this plate</dd>` : ''}
          <dt>Level</dt><dd>${esc(scan.level)}</dd></dl>` : `<dl class="kv"><dt>Level</dt><dd>${esc(scan.level)}</dd></dl>`);
    const sh = openSheet(`
      <div class="result-banner ${good ? 'good' : 'bad'}"><div class="big">${title}</div>${scan.plate ? `<div class="plate mono">${esc(scan.plate)}${scan.state ? ' · ' + esc(scan.state) : ''}</div>` : ''}</div>
      ${flags.join('')}
      ${details}
      <div class="btn-row"><button class="btn" id="rsEdit">Edit</button><button class="btn primary" id="rsNext" style="flex:2 1 200px">Next car ›</button></div>`,
    { onClose: () => Feedback.border('') });
    $('#rsNext', sh).onclick = () => closeSheet();
    $('#rsEdit', sh).onclick = () => { closeSheet(); setTimeout(() => confirmFlow({ edit: scan }), 50); };
  }

  /* ================= log ================= */
  let logFilter = 'all';
  function renderLog() {
    const head = $('#logHead');
    if (!AUDIT) {
      head.innerHTML = `<div class="card"><h2>No audit in progress</h2><p class="hint">Start an audit from the Scan tab. Past audits are under Reports.</p></div>`;
      $('#logList').innerHTML = ''; $('#logFilters').innerHTML = ''; $('#logSearch').classList.add('hidden');
      return;
    }
    $('#logSearch').classList.remove('hidden');
    const sum = Exporter.summarize(AUDIT, LIST);
    head.innerHTML = `
      <div class="stats"><div class="stat"><b>${sum.total}</b><span>Scanned</span></div><div class="stat good"><b>${sum.good}</b><span>Match</span></div>
      <div class="stat bad"><b>${sum.bad}</b><span>Non-match</span></div><div class="stat"><b>${sum.notSeen.length}</b><span>Not seen yet</span></div></div>
      <div class="btn-row" style="margin:0 0 10px"><button class="btn small" id="lgRecheck">Re-check all against list</button><button class="btn small primary" id="lgFinish">Finish audit</button></div>`;
    $('#lgFinish').onclick = finishAudit;
    $('#lgRecheck').onclick = async () => {
      AUDIT.scans.forEach((s) => Object.assign(s, evaluate(s), { history: s.history }));
      await saveAudit(); renderLog(); renderScanChrome(); toast('All scans re-checked against the current vehicle list');
    };
    const filters = [['all', 'All'], ['bad', 'Non-match'], ['good', 'Match'], ['new', 'First seen'], ...S.levels.map((l) => ['L:' + l, l])];
    $('#logFilters').innerHTML = filters.map(([k, l]) => `<button class="chip ${logFilter === k ? 'on' : ''}" data-f="${esc(k)}">${esc(l)}</button>`).join('');
    $$('#logFilters .chip').forEach((b) => b.addEventListener('click', () => { logFilter = b.dataset.f; renderLog(); }));
    const q = Vehicles.normPlate($('#logSearch').value);
    const qRaw = $('#logSearch').value.trim().toLowerCase();
    const items = AUDIT.scans.map((s, i) => ({ s, i })).reverse().filter(({ s }) => {
      if (logFilter === 'bad' && Exporter.isGood(s)) return false;
      if (logFilter === 'good' && !Exporter.isGood(s)) return false;
      if (logFilter === 'new' && !(s.history && !s.history.count)) return false;
      if (logFilter.startsWith('L:') && s.level !== logFilter.slice(2)) return false;
      if (qRaw && !((q && s.plateNorm.includes(q)) || (s.match && String(s.match.unit).toLowerCase().includes(qRaw)) || String(s.level).toLowerCase().includes(qRaw) || String(s.notes).toLowerCase().includes(qRaw))) return false;
      return true;
    });
    $('#logList').innerHTML = items.length ? items.map(({ s, i }) => {
      const good = Exporter.isGood(s);
      const flags = (s.flags || []).map((f) => Exporter.FLAG_LABEL[f]).join(', ');
      return `<li class="${good ? '' : 'bad'}" data-id="${s.id}">
        <div class="main"><div class="plate mono">${esc(s.plate || '(no plate)')} ${s.state ? `<span class="pill">${esc(s.state)}</span>` : ''}${s.history && !s.history.count ? '<span class="new">NEW</span>' : ''}</div>
        <div class="sub">#${i + 1} · ${Exporter.fmtTime(s.time)} · ${esc(s.level)} · ${esc(Exporter.STATUS_LABEL[s.status])}${flags ? ' · ' + esc(flags) : ''}${s.match && s.match.unit ? ' · Unit ' + esc(s.match.unit) : ''}</div></div>
        <span>›</span></li>`;
    }).join('') : `<p class="hint" style="text-align:center;margin-top:30px">Nothing here yet.</p>`;
    $$('#logList li').forEach((li) => li.addEventListener('click', () => {
      const s = AUDIT.scans.find((x) => x.id === li.dataset.id);
      if (s.noPlate) editNoPlate(s); else confirmFlow({ edit: s });
    }));
  }
  $('#logSearch').addEventListener('input', () => renderLog());

  function editNoPlate(s) {
    const sh = openSheet(`<div class="sheet-head"><h2>No-plate vehicle</h2><button class="close-x" data-close>×</button></div>
      <dl class="kv"><dt>Time</dt><dd>${Exporter.fmtTime(s.time)}</dd><dt>Level</dt><dd>${esc(s.level)}</dd><dt>Vehicle</dt><dd>${esc([s.noPlate.color, s.noPlate.make].filter(Boolean).join(' ') || '—')}</dd><dt>Notes</dt><dd>${esc(s.notes || '—')}</dd></dl>
      <div class="btn-row"><button class="btn danger" id="npDel">Delete</button><button class="btn" id="npPlate">It has a plate — enter it</button></div>`);
    $('#npDel', sh).onclick = async () => { closeSheet(); if (await confirmBox('Delete this entry?', '', 'Delete', true)) { await deleteScan(s.id); renderLog(); renderScanChrome(); } };
    $('#npPlate', sh).onclick = () => { closeSheet(); s.noPlate = null; setTimeout(() => confirmFlow({ edit: s }), 50); };
  }

  /* ================= reports ================= */
  let highlightReport = null;
  async function renderReports() {
    const body = $('#reportsBody');
    const all = await DB.allAudits();
    if (!all.length) { body.innerHTML = `<div class="card"><h2>No audits yet</h2><p class="hint">Finished audits appear here with export buttons. The last ${S.keepAudits} audits are kept on this device.</p></div>`; return; }
    body.innerHTML = `<p class="hint">Exports are created on this device. Use <b>Share</b> to send them by email, Teams or Drive, or <b>Download</b> to save to the device.</p>` +
      all.map((a) => {
        const sum = Exporter.summarize(a, LIST);
        const open = a.status === 'open';
        return `<div class="card" data-id="${a.id}" ${a.id === highlightReport ? 'style="border-color:var(--accent)"' : ''}>
          <h2>${Exporter.fmtDate(a.startedAt)} · ${Exporter.fmtTime(a.startedAt)} ${open ? '<span class="pill warn">In progress</span>' : '<span class="pill">Finished</span>'}</h2>
          <div class="hint">${esc(a.auditor || 'No auditor name')} · list: ${esc(a.listFile || '')}</div>
          <div class="stats" style="margin-top:10px"><div class="stat"><b>${sum.total}</b><span>Scanned</span></div><div class="stat good"><b>${sum.good}</b><span>Match</span></div>
          <div class="stat bad"><b>${sum.bad}</b><span>Non-match</span></div><div class="stat"><b>${sum.firstSeen}</b><span>First seen</span></div></div>
          <div class="btn-row">
            <button class="btn small" data-act="xlsx">Excel report</button>
            <button class="btn small" data-act="pdf">PDF summary</button>
            <button class="btn small" data-act="zip">Photos (.zip)</button>
            <button class="btn small primary" data-act="share">Share all…</button>
          </div>
          <div class="btn-row">
            ${open ? '' : '<button class="btn small" data-act="reopen">Reopen audit</button>'}
            <button class="btn small danger" data-act="delete">Delete audit</button>
          </div></div>`;
      }).join('');
    $$('#reportsBody .card[data-id]').forEach((card) => {
      $$('[data-act]', card).forEach((b) => b.addEventListener('click', () => reportAction(card.dataset.id, b.dataset.act, b)));
    });
  }

  async function reportAction(id, act, btn) {
    const a = AUDIT && AUDIT.id === id ? AUDIT : await DB.getAudit(id);
    if (!a) return;
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    try {
      if (act === 'xlsx') Exporter.download(await Exporter.excel(a, LIST, S.title));
      if (act === 'pdf') Exporter.download(Exporter.pdf(a, LIST, S.title));
      if (act === 'zip') {
        const z = await Exporter.photosZip(a, S.title);
        if (!z) toast(S.photos === 'off' ? 'Photos are turned off in Settings' : 'No photos saved for this audit'); else Exporter.download(z);
      }
      if (act === 'share') {
        const files = [await Exporter.excel(a, LIST, S.title), Exporter.pdf(a, LIST, S.title), await Exporter.photosZip(a, S.title)];
        let shared = false;
        try { shared = await Exporter.share(files, S.title + ' audit'); } catch (e) { if (e && e.name === 'AbortError') shared = true; }
        if (!shared) { files.filter(Boolean).forEach((f, i) => setTimeout(() => Exporter.download(f), i * 700)); toast('Sharing isn’t available here — files downloaded instead'); }
      }
      if (act === 'reopen') await reopenAudit(id);
      if (act === 'delete') {
        if (await confirmBox('Delete this audit?', 'Its scans and photos will be permanently removed from this device. Export first if you need a copy.', 'Delete audit', true)) {
          await DB.delAudit(id);
          if (AUDIT && AUDIT.id === id) { AUDIT = null; await DB.del('openAuditId'); renderScanChrome(); }
          await buildPastIndex(); renderReports();
        }
      }
    } catch (e) {
      console.error(e); toast('Export failed: ' + (e && e.message || e), 5000);
    } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  }

  /* ================= settings ================= */
  async function renderSettings() {
    const est = await DB.estimate();
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    const b = $('#settingsBody');
    b.innerHTML = `
      <div class="card"><h2>Vehicle list</h2>
        ${LIST ? `<dl class="kv"><dt>File</dt><dd>${esc(LIST.fileName)}</dd><dt>Loaded</dt><dd>${Exporter.fmtDateTime(LIST.importedAt)}</dd>
          <dt>Vehicles</dt><dd>${LIST.counts.total} (${LIST.counts.active} active, ${LIST.counts.inactive} moved out/inactive)</dd></dl>` : '<p class="hint">No vehicle list loaded yet.</p>'}
        <div class="btn-row"><button class="btn primary" id="stImport">${LIST ? 'Replace with updated list' : 'Load vehicle list'}</button>${LIST ? '<button class="btn" id="stView">View list</button>' : ''}</div>
        <p class="hint">Accepts .xls, .xlsx or .csv. Updating: export the new report from Entrata, put it on this device, tap <b>Replace</b>. Your column choices are remembered.</p>
      </div>

      <div class="card"><h2>General</h2>
        <label class="field"><span>App / report title</span><input id="stTitle" class="input" value="${esc(S.title)}"></label>
        <label class="field"><span>Default auditor name</span><input id="stAuditor" class="input" value="${esc(S.auditor)}"></label>
        <label class="field"><span>Default plate state</span><select id="stState" class="input">${stateOptions(S.defaultState)}</select></label>
        <label class="field"><span>Levels / zones (one per line, in walking order)</span><textarea id="stLevels" class="input">${esc(S.levels.join('\n'))}</textarea></label>
        <div class="btn-row"><button class="btn primary" id="stSave">Save</button></div>
      </div>

      <div class="card"><h2>Scanning</h2>
        <label class="field"><span>Save photos</span><select id="stPhotos" class="input">
          <option value="nonmatch" ${S.photos === 'nonmatch' ? 'selected' : ''}>Non-matches only (recommended)</option>
          <option value="all" ${S.photos === 'all' ? 'selected' : ''}>Every scan</option>
          <option value="off" ${S.photos === 'off' ? 'selected' : ''}>Off</option></select></label>
        <label class="field"><span>Result border size</span><select id="stBorder" class="input">
          <option value="medium" ${S.border === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="large" ${S.border === 'large' ? 'selected' : ''}>Large</option>
          <option value="xl" ${S.border === 'xl' ? 'selected' : ''}>Extra large</option></select></label>
        <div class="switch"><div><b>Sound</b><div class="hint">Beep on match, buzz on non-match</div></div><input type="checkbox" id="stSound" ${S.sound ? 'checked' : ''}></div>
        <div class="switch"><div><b>Vibration</b><div class="hint">Android only — iPhones don't allow web apps to vibrate</div></div><input type="checkbox" id="stVib" ${S.vibrate ? 'checked' : ''}></div>
        <div class="switch"><div><b>Detect state from plate text</b><div class="hint">If "COLORADO", "TEXAS" etc. is read on the plate, set the state automatically</div></div><input type="checkbox" id="stAuto" ${S.autoState ? 'checked' : ''}></div>
        <div class="btn-row"><button class="btn" id="stTestGood">Test match signal</button><button class="btn" id="stTestBad">Test non-match signal</button></div>
      </div>

      <div class="card"><h2>Device &amp; data</h2>
        <dl class="kv">
          <dt>Offline ready</dt><dd>${sw ? '✓ Yes — works without signal' : 'Not yet (open once with internet)'}</dd>
          <dt>Plate reader</dt><dd>${PlateOCR.isReady() ? '✓ Loaded' : 'Loading…'}</dd>
          <dt>Storage used</dt><dd>${est ? (est.usage / 1048576).toFixed(1) + ' MB' : '—'}</dd>
          <dt>Protected storage</dt><dd>${persisted ? '✓ Yes' : 'Not granted (browser may clear data if space runs low)'}</dd>
          <dt>Audits kept</dt><dd>Last ${S.keepAudits} (older finished audits are removed when a new one starts)</dd>
          <dt>Version</dt><dd>${APP_VERSION}</dd>
        </dl>
        <p class="hint">All data (vehicle list, scans, photos) is stored only in this browser on this device. Nothing is uploaded.</p>
        <div class="btn-row"><button class="btn" id="stHelp">Help &amp; instructions</button><button class="btn danger" id="stWipe">Wipe all data…</button></div>
      </div>`;

    $('#stImport').onclick = startImport;
    if ($('#stView')) $('#stView').onclick = viewList;
    $('#stSave').onclick = async () => {
      S.title = $('#stTitle').value.trim() || DEFAULTS.title;
      S.auditor = $('#stAuditor').value.trim();
      S.defaultState = $('#stState').value;
      const lv = $('#stLevels').value.split('\n').map((s) => s.trim()).filter(Boolean);
      S.levels = lv.length ? [...new Set(lv)] : DEFAULTS.levels.slice();
      await saveSettings(); applyTitle(); renderLevels(); toast('Settings saved');
    };
    const quick = async (id, key, transform) => { $(id).onchange = async (e) => { S[key] = transform(e.target); await saveSettings(); applyBorder(); }; };
    quick('#stPhotos', 'photos', (t) => t.value);
    quick('#stBorder', 'border', (t) => t.value);
    quick('#stSound', 'sound', (t) => t.checked);
    quick('#stVib', 'vibrate', (t) => t.checked);
    quick('#stAuto', 'autoState', (t) => t.checked);
    $('#stTestGood').onclick = () => { Feedback.unlock(); Feedback.border('good'); Feedback.good(); setTimeout(() => Feedback.border(''), 1500); };
    $('#stTestBad').onclick = () => { Feedback.unlock(); Feedback.border('bad'); Feedback.bad(); setTimeout(() => Feedback.border(''), 1800); };
    $('#stHelp').onclick = openHelp;
    $('#stWipe').onclick = wipeFlow;
  }

  async function wipeFlow() {
    const sh = openSheet(`<div class="sheet-head"><h2>Wipe data</h2><button class="close-x" data-close>×</button></div>
      <p>This permanently removes data from this device. Export any reports you need first.</p>
      <div class="switch"><div><b>Vehicle list</b></div><input type="checkbox" id="wpList" checked></div>
      <div class="switch"><div><b>All audits and photos</b></div><input type="checkbox" id="wpAudits" checked></div>
      <div class="switch"><div><b>Settings</b> (title, levels, column choices)</div><input type="checkbox" id="wpSettings"></div>
      <label class="field"><span>Type <b>WIPE</b> to confirm</span><input id="wpConfirm" class="input" autocapitalize="characters"></label>
      <div class="btn-row"><button class="btn" data-close>Cancel</button><button class="btn danger" id="wpGo">Wipe selected</button></div>`);
    $('#wpGo', sh).onclick = async () => {
      if ($('#wpConfirm', sh).value.trim().toUpperCase() !== 'WIPE') { toast('Type WIPE to confirm'); return; }
      const wl = $('#wpList', sh).checked, wa = $('#wpAudits', sh).checked, ws = $('#wpSettings', sh).checked;
      if (wl && wa && ws) { await DB.wipeAll(); S = Object.assign({}, DEFAULTS); LIST = null; AUDIT = null; }
      else {
        if (wl) { await DB.del('vehicleList'); LIST = null; }
        if (wa) { for (const a of await DB.allAudits()) await DB.delAudit(a.id); await DB.del('openAuditId'); AUDIT = null; }
        if (ws) { S = Object.assign({}, DEFAULTS); await saveSettings(); }
      }
      await buildPastIndex();
      closeSheet(); applyTitle(); applyBorder(); renderScanChrome(); renderSettings(); toast('Selected data wiped');
    };
  }

  /* ---------- vehicle list import ---------- */
  function startImport() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xls,.xlsx,.xlsm,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        toast('Reading ' + f.name + '…');
        const sheets = Vehicles.readWorkbook(await f.arrayBuffer());
        if (!sheets.length) { toast('That file has no data'); return; }
        importDialog(f.name, sheets);
      } catch (e) { console.error(e); toast('Could not read that file: ' + (e && e.message || e), 5000); }
    };
    inp.click();
  }

  function importDialog(fileName, sheets) {
    // choose the sheet whose best header row scores highest
    let si = 0, bestScore = -1;
    sheets.forEach((s, i) => { const h = Vehicles.guessHeaderRow(s.rows); const sc = s.rows[h].filter(Boolean).length + (s.rows.length / 1000); if (sc > bestScore) { bestScore = sc; si = i; } });
    let headerRow = Vehicles.guessHeaderRow(sheets[si].rows);
    let { map, fromSaved } = Vehicles.guessMapping(sheets[si].rows[headerRow], S.savedMapping);
    let inactive = null; // set of status values considered inactive
    let showCols = !fromSaved;

    const sh = openSheet('<div id="imp"></div>', { modal: true });
    const box = $('#imp', sh);

    function statusValues() {
      if (map.status == null || map.status === '') return [];
      return Vehicles.distinctValues(sheets[si].rows, headerRow, map.status);
    }
    function defaultInactive() {
      const vals = statusValues();
      const saved = S.savedMapping && S.savedMapping.__inactive;
      return new Set(vals.map(([v]) => v).filter((v) => (saved ? saved.includes(v.toLowerCase()) : false) || Vehicles.INACTIVE_RE.test(v)));
    }

    function render() {
      const rows = sheets[si].rows, headers = rows[headerRow] || [];
      if (!inactive) inactive = defaultInactive();
      const list = map.plate != null && map.plate !== '' ? Vehicles.buildList(rows, headerRow, map, [...inactive], { fileName }) : null;
      const opt = (k) => `<option value="">— not in file —</option>` + headers.map((h, i) => `<option value="${i}" ${String(map[k]) === String(i) ? 'selected' : ''}>${esc(h || `(column ${i + 1})`)}</option>`).join('');
      const vals = statusValues();
      box.innerHTML = `
        <div class="sheet-head"><h2>Load vehicle list</h2><button class="close-x" id="impX">×</button></div>
        <p class="hint">${esc(fileName)}${sheets.length > 1 ? '' : ` · ${rows.length} rows`}</p>
        ${fromSaved && !showCols ? `<div class="flag info">✓ Same columns as last time — your saved column choices were applied.</div>` : ''}
        ${sheets.length > 1 ? `<label class="field"><span>Sheet</span><select id="impSheet" class="input">${sheets.map((s, i) => `<option value="${i}" ${i === si ? 'selected' : ''}>${esc(s.name)} (${s.rows.length} rows)</option>`).join('')}</select></label>` : ''}
        <div ${showCols ? '' : 'class="hidden"'}>
          <label class="field"><span>Header row (the row with the column names)</span><select id="impHead" class="input">${rows.slice(0, 30).map((r, i) => `<option value="${i}" ${i === headerRow ? 'selected' : ''}>Row ${i + 1}: ${esc(r.filter(Boolean).slice(0, 5).join(' | ').slice(0, 70))}</option>`).join('')}</select></label>
          <h3>Match the columns</h3>
          ${Vehicles.FIELD_DEFS.map((f) => `<label class="field"><span>${esc(f.label)}${f.required ? ' (required)' : ''}</span><select class="input" data-k="${f.key}">${opt(f.key)}</select></label>`).join('')}
        </div>
        ${!showCols ? '<button class="btn small" id="impShowCols">Review column choices</button>' : ''}
        ${vals.length ? `<h3>Which statuses mean moved out / inactive?</h3><p class="hint">Checked values are flagged red if that car is found in the garage.</p>
          ${vals.map(([v, n]) => `<div class="switch"><div>${esc(v)} <span class="hint">(${n})</span></div><input type="checkbox" data-inact="${esc(v)}" ${inactive.has(v) ? 'checked' : ''}></div>`).join('')}` : ''}
        <h3>Preview</h3>
        ${list ? `<p><b>${list.counts.total}</b> vehicles · <b style="color:var(--good)">${list.counts.active}</b> active · <b style="color:var(--bad)">${list.counts.inactive}</b> inactive${list.skipped ? ` · ${list.skipped} rows without a plate skipped` : ''}</p>
          <div class="tbl-wrap"><table class="tbl"><tr><th>Plate</th><th>State</th><th>Unit</th><th>Resident</th><th>Vehicle</th><th>Status</th></tr>
          ${list.vehicles.slice(0, 8).map((v) => `<tr class="${v.active ? '' : 'inactive'}"><td class="mono">${esc(v.plate)}</td><td>${esc(v.state)}</td><td>${esc(v.unit)}</td><td>${esc(v.name)}</td><td>${esc(Vehicles.describe(v))}</td><td>${esc(v.statusRaw)}</td></tr>`).join('')}</table></div>`
          : '<div class="flag bad">Pick the column that holds the license plate number.</div>'}
        <div class="btn-row"><button class="btn" id="impCancel">Cancel</button><button class="btn primary" id="impSave" ${list && list.counts.total ? '' : 'disabled'}>Save vehicle list</button></div>`;

      $('#impX', box).onclick = $('#impCancel', box).onclick = () => closeSheet();
      if ($('#impSheet', box)) $('#impSheet', box).onchange = (e) => {
        si = Number(e.target.value); headerRow = Vehicles.guessHeaderRow(sheets[si].rows);
        ({ map } = Vehicles.guessMapping(sheets[si].rows[headerRow], null)); inactive = null; showCols = true; render();
      };
      if ($('#impHead', box)) $('#impHead', box).onchange = (e) => {
        headerRow = Number(e.target.value); ({ map } = Vehicles.guessMapping(sheets[si].rows[headerRow], null)); inactive = null; render();
      };
      if ($('#impShowCols', box)) $('#impShowCols', box).onclick = () => { showCols = true; render(); };
      $$('[data-k]', box).forEach((s) => s.addEventListener('change', () => {
        map[s.dataset.k] = s.value === '' ? null : Number(s.value);
        if (s.dataset.k === 'status') inactive = null;
        render();
      }));
      $$('[data-inact]', box).forEach((c) => c.addEventListener('change', () => {
        if (c.checked) inactive.add(c.dataset.inact); else inactive.delete(c.dataset.inact); render();
      }));
      $('#impSave', box).onclick = async () => {
        const fresh = Vehicles.buildList(rows, headerRow, map, [...inactive], { fileName });
        LIST = fresh;
        await DB.set('vehicleList', LIST);
        S.savedMapping = Object.assign({}, fresh.mapping, { __inactive: [...inactive].map((s) => s.toLowerCase()) });
        await saveSettings();
        closeSheet();
        toast(`Vehicle list saved — ${fresh.counts.active} active vehicles`);
        renderSettings(); renderScanChrome();
        if (AUDIT) toast('Tip: Log → "Re-check all against list" to update this audit', 4000);
      };
    }
    render();
  }

  function viewList() {
    const sh = openSheet(`<div class="sheet-head"><h2>Vehicle list</h2><button class="close-x" data-close>×</button></div>
      <input id="vlQ" class="input" type="search" placeholder="Search plate, unit, name…">
      <p class="hint" id="vlCount"></p><div class="tbl-wrap" id="vlTbl"></div>`);
    const draw = () => {
      const q = $('#vlQ', sh).value.trim().toLowerCase(), qp = Vehicles.normPlate(q);
      const rows = LIST.vehicles.filter((v) => !q || (qp && v.plateNorm.includes(qp)) || String(v.unit).toLowerCase().includes(q) || String(v.name).toLowerCase().includes(q));
      $('#vlCount', sh).textContent = `${rows.length} of ${LIST.vehicles.length} vehicles`;
      $('#vlTbl', sh).innerHTML = `<table class="tbl"><tr><th>Plate</th><th>State</th><th>Unit</th><th>Resident</th><th>Vehicle</th><th>Status</th></tr>${rows.slice(0, 400).map((v) => `<tr class="${v.active ? '' : 'inactive'}"><td class="mono">${esc(v.plate)}</td><td>${esc(v.state)}</td><td>${esc(v.unit)}</td><td>${esc(v.name)}</td><td>${esc(Vehicles.describe(v))}</td><td>${esc(v.statusRaw)}</td></tr>`).join('')}</table>`;
    };
    $('#vlQ', sh).addEventListener('input', draw); draw();
  }

  /* ================= help ================= */
  function openHelp() {
    openSheet(`<div class="sheet-head"><h2>How to use</h2><button class="close-x" data-close>×</button></div>
    <div class="help">
      <h3>Before the first audit</h3>
      <ol><li>Open this app once with internet so it saves itself for offline use (Settings shows “Offline ready ✓”).</li>
      <li>Add it to the home screen: Android Chrome ⋮ menu → <b>Add to home screen</b> / <b>Install app</b>. iPhone Safari Share → <b>Add to Home Screen</b>.</li>
      <li>Settings → <b>Load vehicle list</b> → pick the Entrata Excel export → confirm the columns → Save.</li>
      <li>Settings → edit <b>Levels / zones</b> to match the garage.</li></ol>
      <h3>Scanning</h3>
      <ol><li>Tap the capture button — you'll be asked to start an audit the first time.</li>
      <li>Pick the level at the top before you scan that floor.</li>
      <li>Fill the box with the plate, hold steady, tap capture. Use <b>Light</b> in dark areas and the zoom slider (Android) instead of stepping back.</li>
      <li>Check the read. If it's wrong, edit it — or tap a car under “On file” if it's listed there. Set the state if it's not Colorado. Toggle <b>EV charging space</b> when needed.</li>
      <li>Tap <b>Validate</b>: green border + beep = registered; red border + buzz = not on file, moved out, no plate, or EV space not charging.</li>
      <li>No plate or paper tag? Use <b>No plate</b>. Plate unreadable? Use <b>Type plate</b>.</li>
      <li>The audit saves after every scan. If the device locks or the app closes, just reopen it and continue.</li>
      <li>When done, tap <b>Finish</b>, then export from <b>Reports</b>.</li></ol>
      <h3>Updating the vehicle list (new move-ins / move-outs)</h3>
      <ol><li>In Entrata, run the same vehicle report and export it to Excel (.xls or .xlsx).</li>
      <li>Get the file onto this device — email it to yourself, save it to Google Drive/OneDrive, or copy it over USB.</li>
      <li>Here: Settings → <b>Replace with updated list</b> → choose the file. If the columns match last time, just tap <b>Save</b>.</li>
      <li>Updating mid-audit? Then Log → <b>Re-check all against list</b>.</li></ol>
      <h3>Reports</h3>
      <ul><li><b>Excel</b>: Summary, every scan (green = match, red = non-match, yellow History cell = plate never seen in an earlier audit), and registered vehicles that weren't seen.</li>
      <li><b>PDF</b>: one-page summary for regional.</li>
      <li><b>Photos (.zip)</b>: full photo plus a plate close-up for each saved scan. Choose which scans keep photos in Settings.</li>
      <li><b>Share all</b> sends the files to email, Teams, Drive, etc. from the device.</li></ul>
      <h3>Tips for better reads</h3>
      <ul><li>Stand square to the plate — steep angles cause misreads.</li><li>Wipe dirty plates or use the flashlight to cut shadows.</li>
      <li>Common mix-ups: O/0, I/1, B/8, S/5, Z/2. The “On file” list catches most of these.</li>
      <li>If the tablet is slow, the same web address works on an iPhone — run the whole audit on one device.</li></ul>
      <h3>Privacy</h3>
      <p>Your vehicle list, scans and photos stay in this browser on this device. The app is blocked from sending data anywhere. Use Settings → Wipe all data when you're done with a device.</p>
    </div>`);
  }

  /* ================= service worker & init ================= */
  function setEngine(text, cls) { const e = $('#engineStatus'); e.textContent = text; e.className = 'pill ' + (cls || 'muted'); }

  let updateRequested = false;
  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const onWaiting = (w) => {
        if (!w) return;
        $('#updateBar').classList.remove('hidden');
        $('#updateBtn').onclick = () => { updateRequested = true; w.postMessage('skipWaiting'); };
      };
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed') {
            if (navigator.serviceWorker.controller) onWaiting(nw);
            else toast('Saved for offline use ✓');
          }
        });
      });
      // check for updates when online
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch((e) => console.warn('SW registration failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) { updateRequested = false; location.reload(); } });
  }

  async function init() {
    const saved = await DB.get('settings');
    if (saved) S = Object.assign({}, DEFAULTS, saved);
    applyTitle(); applyBorder();
    LIST = (await DB.get('vehicleList')) || null;
    currentLevel = (await DB.get('currentLevel')) || S.levels[0];
    const openId = await DB.get('openAuditId');
    if (openId) { AUDIT = (await DB.getAudit(openId)) || null; if (!AUDIT) await DB.del('openAuditId'); }
    await buildPastIndex();
    DB.persist();
    show('scan');
    if (AUDIT) toast(`Resumed audit — ${AUDIT.scans.length} scans so far`);
    else if (!LIST) setTimeout(() => toast('Start in Settings: load your vehicle list', 4000), 600);
    registerSW();
    setEngine('Reader loading…');
    PlateOCR.init((m) => {
      if (m.status && /loading|initializ/i.test(m.status) && m.progress != null) setEngine(`Reader ${Math.round(m.progress * 100)}%`);
    }).then(() => setEngine('Reader ready', 'good'))
      .catch((e) => { console.error(e); setEngine('Reader failed', 'bad'); toast('Plate reader failed to load — you can still type plates. ' + (e && e.message || e), 6000); });
  }

  window.__app = { get S() { return S; }, get LIST() { return LIST; }, get AUDIT() { return AUDIT; }, confirmFlow, show, evaluate, Camera };
  init();
})();
