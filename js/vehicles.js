/* Vehicle list: import from Excel/CSV, column mapping, plate normalization, matching. */
(function (global) {
  'use strict';

  const STATES = [
    ['AL', 'ALABAMA'], ['AK', 'ALASKA'], ['AZ', 'ARIZONA'], ['AR', 'ARKANSAS'], ['CA', 'CALIFORNIA'],
    ['CO', 'COLORADO'], ['CT', 'CONNECTICUT'], ['DE', 'DELAWARE'], ['DC', 'DISTRICT OF COLUMBIA'], ['FL', 'FLORIDA'],
    ['GA', 'GEORGIA'], ['HI', 'HAWAII'], ['ID', 'IDAHO'], ['IL', 'ILLINOIS'], ['IN', 'INDIANA'], ['IA', 'IOWA'],
    ['KS', 'KANSAS'], ['KY', 'KENTUCKY'], ['LA', 'LOUISIANA'], ['ME', 'MAINE'], ['MD', 'MARYLAND'],
    ['MA', 'MASSACHUSETTS'], ['MI', 'MICHIGAN'], ['MN', 'MINNESOTA'], ['MS', 'MISSISSIPPI'], ['MO', 'MISSOURI'],
    ['MT', 'MONTANA'], ['NE', 'NEBRASKA'], ['NV', 'NEVADA'], ['NH', 'NEW HAMPSHIRE'], ['NJ', 'NEW JERSEY'],
    ['NM', 'NEW MEXICO'], ['NY', 'NEW YORK'], ['NC', 'NORTH CAROLINA'], ['ND', 'NORTH DAKOTA'], ['OH', 'OHIO'],
    ['OK', 'OKLAHOMA'], ['OR', 'OREGON'], ['PA', 'PENNSYLVANIA'], ['RI', 'RHODE ISLAND'], ['SC', 'SOUTH CAROLINA'],
    ['SD', 'SOUTH DAKOTA'], ['TN', 'TENNESSEE'], ['TX', 'TEXAS'], ['UT', 'UTAH'], ['VT', 'VERMONT'],
    ['VA', 'VIRGINIA'], ['WA', 'WASHINGTON'], ['WV', 'WEST VIRGINIA'], ['WI', 'WISCONSIN'], ['WY', 'WYOMING'],
    ['PR', 'PUERTO RICO'], ['GOV', 'GOVERNMENT'], ['MX', 'MEXICO'], ['CAN', 'CANADA'],
  ];
  const STATE_BY_NAME = Object.fromEntries(STATES.map(([c, n]) => [n.replace(/\s/g, ''), c]));
  const STATE_CODES = new Set(STATES.map(([c]) => c));

  function normPlate(p) { return String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function normState(s) {
    const t = String(s == null ? '' : s).toUpperCase().trim();
    if (!t) return '';
    const compact = t.replace(/[^A-Z]/g, '');
    if (STATE_CODES.has(compact)) return compact;
    if (STATE_BY_NAME[compact]) return STATE_BY_NAME[compact];
    return compact.slice(0, 3);
  }

  // Look for a state name printed on the plate among the OCR'd words.
  function detectState(words) {
    const blob = (words || []).join(' ').toUpperCase().replace(/[^A-Z ]/g, '');
    const compact = blob.replace(/\s/g, '');
    let best = null;
    for (const [code, name] of STATES) {
      const n = name.replace(/\s/g, '');
      if (n.length < 4) continue;
      if (compact.includes(n) && (!best || n.length > best.len)) best = { code, len: n.length };
    }
    return best ? best.code : '';
  }

  /* ---------- fuzzy matching ---------- */
  // Characters OCR commonly swaps on plates. Plates that differ only in these are "look-alikes".
  const CONFUSE = { O: '0', Q: '0', D: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6', A: '4', U: 'V' };
  function canon(p) { return normPlate(p).split('').map((c) => CONFUSE[c] || c).join(''); }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i; let rowMin = cur[0];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /**
   * Suggestions from the vehicle list for a typed/OCR'd plate.
   * Returns [{v (vehicle), score, why}] — exact first, then look-alike characters, then 1-2 edits.
   */
  function suggest(list, plate, limit) {
    const p = normPlate(plate);
    if (!p || !list || !list.vehicles) return [];
    const cp = canon(p);
    const out = [];
    const seen = new Set();
    for (const v of list.vehicles) {
      if (seen.has(v.plateNorm + '|' + v.state)) continue;
      let score = 0, why = '';
      if (v.plateNorm === p) { score = 100; why = 'Exact'; }
      else if (v.plateCanon === cp) { score = 80; why = 'Look-alike characters'; }
      else {
        const d = lev(cp, v.plateCanon, 2);
        if (d === 1 && p.length >= 4) { score = 60; why = 'One character off'; }
        else if (d === 2 && p.length >= 6) { score = 35; why = 'Two characters off'; }
        else if (p.length >= 4 && (v.plateNorm.includes(p) || p.includes(v.plateNorm)) && v.plateNorm.length >= 4) { score = 40; why = 'Partial read'; }
      }
      if (score) { out.push({ v, score, why }); seen.add(v.plateNorm + '|' + v.state); }
    }
    out.sort((a, b) => (b.score - a.score) || (Number(b.v.active) - Number(a.v.active)));
    return out.slice(0, limit || 4);
  }

  /**
   * Validate a confirmed plate. Returns {status, flags[], entries[], primary}
   * status: REGISTERED | NOT_ON_FILE | INACTIVE
   */
  function validate(list, plate, state) {
    const p = normPlate(plate);
    const entries = (list && list.vehicles ? list.vehicles : []).filter((v) => v.plateNorm === p);
    const flags = [];
    if (!entries.length) return { status: 'NOT_ON_FILE', flags, entries, primary: null };
    const active = entries.filter((v) => v.active);
    if (!active.length) return { status: 'INACTIVE', flags, entries, primary: entries[0] };
    const st = normState(state);
    let primary = active[0];
    if (st) {
      const sameState = active.find((v) => !v.state || v.state === st);
      if (sameState) primary = sameState;
      else { flags.push('STATE_MISMATCH'); }
    }
    return { status: 'REGISTERED', flags, entries, primary };
  }

  /* ---------- import ---------- */
  const FIELD_DEFS = [
    { key: 'plate', label: 'License plate', required: true, re: /(license|lic\.?|tag|plate)(?!.*(state|st\b|exp))|plate\s*#|lp\b/i },
    { key: 'state', label: 'Plate state', re: /(plate|license|lic|tag|vehicle).*\b(state|st)\b|^\s*state\s*$|^st$/i },
    { key: 'unit', label: 'Unit / apartment', re: /^(unit|apt|apartment|space|bldg[-\s/]*unit|unit\s*(#|no|number)?)$|\bunit\b|\bapt\b/i },
    { key: 'name', label: 'Resident name', re: /(resident|tenant|lessee|occupant|customer)\s*(name)?|^name$|full\s*name|last\s*name/i },
    { key: 'name2', label: 'Name (second part, optional)', re: /first\s*name/i },
    { key: 'status', label: 'Lease / resident status', re: /(lease|resident|occupant|customer|tenant)?\s*status/i },
    { key: 'make', label: 'Vehicle make', re: /\bmake\b/i },
    { key: 'model', label: 'Vehicle model', re: /\bmodel\b/i },
    { key: 'color', label: 'Vehicle color', re: /colou?r/i },
    { key: 'year', label: 'Vehicle year', re: /(vehicle|veh|car)?\s*year/i },
    { key: 'permit', label: 'Permit / tag #', re: /(permit|sticker|hang\s*tag|decal|parking\s*(tag|pass))/i },
  ];

  const INACTIVE_RE = /(past|former|moved|move[\s-]*out|vacat|cancel|evict|terminat|inactive|denied|expired|skip)/i;

  function readWorkbook(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, dense: false });
    const sheets = wb.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true });
      return { name, rows: rows.map((r) => r.map((c) => String(c == null ? '' : c).trim())) };
    }).filter((s) => s.rows.length);
    return sheets;
  }

  function scoreHeader(row) {
    let s = 0;
    row.forEach((c) => {
      if (!c || c.length > 40) return;
      FIELD_DEFS.forEach((f) => { if (f.re.test(c)) s += f.key === 'plate' ? 3 : 1; });
    });
    return s;
  }

  function guessHeaderRow(rows) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const sc = scoreHeader(rows[i]);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    return best;
  }

  function guessMapping(headers, saved) {
    const map = {};
    // reuse a previously saved mapping when the same header names exist
    if (saved) {
      let ok = true;
      Object.entries(saved).forEach(([k, name]) => {
        if (name == null || name === '') return;
        const idx = headers.indexOf(name);
        if (idx >= 0) map[k] = idx; else if (k === 'plate') ok = false;
      });
      if (ok && map.plate != null) return { map, fromSaved: true };
    }
    const used = new Set();
    FIELD_DEFS.forEach((f) => {
      const idx = headers.findIndex((h, i) => !used.has(i) && h && f.re.test(h));
      if (idx >= 0) { map[f.key] = idx; used.add(idx); }
    });
    // "First name" + "Last name": put last name in name and first in name2 (display "First Last")
    return { map, fromSaved: false };
  }

  function splitPlates(cell) {
    return String(cell || '').split(/[,;/|\n&]+/).map((s) => s.trim()).filter((s) => normPlate(s).length >= 2);
  }

  function buildList(rows, headerRow, map, inactiveValues, meta) {
    const headers = rows[headerRow] || [];
    const vehicles = [];
    let skipped = 0;
    const inact = new Set((inactiveValues || []).map((s) => s.toLowerCase()));
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i];
      const get = (k) => (map[k] != null && map[k] !== '' ? String(r[map[k]] || '').trim() : '');
      const plates = splitPlates(get('plate'));
      if (!plates.length) { skipped++; continue; }
      // skip repeated header rows / report footers
      if (plates.length === 1 && headers[map.plate] && plates[0] === headers[map.plate]) { skipped++; continue; }
      const statusRaw = get('status');
      const nm = [get('name2'), get('name')].filter(Boolean).join(' ');
      plates.forEach((pl) => {
        const plateNorm = normPlate(pl);
        vehicles.push({
          plate: pl.toUpperCase(), plateNorm, plateCanon: canon(plateNorm),
          state: normState(get('state')), unit: get('unit'), name: nm,
          statusRaw, active: !(statusRaw && inact.has(statusRaw.toLowerCase())),
          make: get('make'), model: get('model'), color: get('color'), year: get('year'), permit: get('permit'),
          row: i + 1,
        });
      });
    }
    const namedMap = {};
    Object.entries(map).forEach(([k, idx]) => { if (idx != null && idx !== '') namedMap[k] = headers[idx]; });
    return Object.assign({
      vehicles, skipped, importedAt: new Date().toISOString(), headers, mapping: namedMap,
      inactiveValues: [...inact],
      counts: { total: vehicles.length, active: vehicles.filter((v) => v.active).length, inactive: vehicles.filter((v) => !v.active).length },
    }, meta || {});
  }

  function distinctValues(rows, headerRow, col) {
    const m = new Map();
    for (let i = headerRow + 1; i < rows.length; i++) {
      const v = String(rows[i][col] || '').trim();
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function describe(v) {
    if (!v) return '';
    return [v.year, v.color, v.make, v.model].filter(Boolean).join(' ');
  }

  global.Vehicles = {
    STATES, FIELD_DEFS, INACTIVE_RE, normPlate, normState, canon, detectState, suggest, validate,
    readWorkbook, guessHeaderRow, guessMapping, buildList, distinctValues, describe, lev,
  };
})(window);
