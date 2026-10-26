/* Report exports: Excel (color-coded), photo ZIP, one-page PDF summary. All generated on-device. */
(function (global) {
  'use strict';

  const STATUS_LABEL = {
    REGISTERED: 'Registered', NOT_ON_FILE: 'Not on file', INACTIVE: 'Moved out / inactive', NO_PLATE: 'No plate',
  };
  const FLAG_LABEL = { STATE_MISMATCH: 'State mismatch', EV_NOT_CHARGING: 'EV space – not charging', REPEAT: 'Repeat (seen before)' };

  // A scan is a "match" (green) only when registered and not parked in an EV space without charging.
  function isGood(s) { return s.status === 'REGISTERED' && !(s.flags || []).includes('EV_NOT_CHARGING'); }

  const FILL = { green: 'FFC6EFCE', red: 'FFFFC7CE', yellow: 'FFFFEB9C', head: 'FF1F2933', amber: 'FFFCE4D6' };
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : ''; }
  function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function stamp(iso) {
    const d = new Date(iso || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function safe(s) { return String(s || '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_') || 'Audit'; }

  function historyText(s) {
    if (!s.history) return '—';
    const h = s.history;
    if (!h.count) return 'New – not seen before';
    return `Seen in ${h.count} prior audit${h.count > 1 ? 's' : ''} (last ${fmtDate(h.last)})${h.lastStatus ? ' – ' + (STATUS_LABEL[h.lastStatus] || h.lastStatus) : ''}`;
  }

  function summarize(audit, list) {
    const scans = audit.scans || [];
    const by = (k) => scans.filter((s) => s.status === k).length;
    const flag = (f) => scans.filter((s) => (s.flags || []).includes(f)).length;
    const levels = {};
    scans.forEach((s) => {
      const L = s.level || '—';
      levels[L] = levels[L] || { total: 0, good: 0, bad: 0 };
      levels[L].total++; if (isGood(s)) levels[L].good++; else levels[L].bad++;
    });
    const seen = new Set(scans.map((s) => s.plateNorm).filter(Boolean));
    const notSeen = list && list.vehicles ? list.vehicles.filter((v) => v.active && !seen.has(v.plateNorm)) : [];
    return {
      total: scans.length, good: scans.filter(isGood).length, bad: scans.filter((s) => !isGood(s)).length,
      registered: by('REGISTERED'), notOnFile: by('NOT_ON_FILE'), inactive: by('INACTIVE'), noPlate: by('NO_PLATE'),
      stateMismatch: flag('STATE_MISMATCH'), evNotCharging: flag('EV_NOT_CHARGING'),
      firstSeen: scans.filter((s) => s.history && !s.history.count).length,
      repeatViolators: scans.filter((s) => !isGood(s) && s.history && s.history.badCount).length,
      levels, notSeen,
    };
  }

  async function excel(audit, list, title) {
    const wb = new ExcelJS.Workbook();
    wb.creator = title; wb.created = new Date();
    const sum = summarize(audit, list);
    const headStyle = (row) => {
      row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fill(FILL.head); c.alignment = { vertical: 'middle', wrapText: true }; });
      row.height = 22;
    };

    /* Summary */
    const ws0 = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
    ws0.columns = [{ width: 34 }, { width: 18 }, { width: 14 }, { width: 14 }];
    ws0.addRow([title]).font = { bold: true, size: 16 };
    ws0.addRow(['Garage plate audit']).font = { size: 12, color: { argb: 'FF555555' } };
    ws0.addRow([]);
    [['Auditor', audit.auditor || ''], ['Started', fmtDateTime(audit.startedAt)], ['Finished', audit.finishedAt ? fmtDateTime(audit.finishedAt) : 'In progress'],
      ['Vehicle list', (list && list.fileName ? list.fileName : '') + (list && list.importedAt ? ` (loaded ${fmtDate(list.importedAt)})` : '')],
      ['Active vehicles on list', list && list.counts ? list.counts.active : '']].forEach((r) => { const row = ws0.addRow(r); row.getCell(1).font = { bold: true }; });
    ws0.addRow([]);
    headStyle(ws0.addRow(['Result', 'Count']));
    const add = (label, n, color) => { const r = ws0.addRow([label, n]); if (color) r.eachCell((c) => { c.fill = fill(color); }); };
    add('Total vehicles scanned', sum.total);
    add('Registered (match)', sum.registered, FILL.green);
    add('Not on file', sum.notOnFile, FILL.red);
    add('Moved out / inactive', sum.inactive, FILL.red);
    add('No readable plate', sum.noPlate, FILL.red);
    add('EV space – not charging', sum.evNotCharging, FILL.red);
    add('State mismatch (flag only)', sum.stateMismatch, FILL.amber);
    add('First time seen', sum.firstSeen, FILL.yellow);
    add('Repeat non-matches (seen before)', sum.repeatViolators);
    add('Registered vehicles not seen', sum.notSeen.length);
    ws0.addRow([]);
    headStyle(ws0.addRow(['Level / zone', 'Scanned', 'Match', 'Non-match']));
    Object.entries(sum.levels).forEach(([L, v]) => ws0.addRow([L, v.total, v.good, v.bad]));
    ws0.addRow([]);
    const leg = ws0.addRow(['Color key: green = match, red = non-match, yellow History cell = first time this plate was seen.']);
    leg.font = { italic: true, color: { argb: 'FF666666' } };

    /* Scans */
    const ws = wb.addWorksheet('Scans', { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = [
      ['#', 6], ['Time', 10], ['Level / zone', 14], ['Plate', 12], ['State', 7], ['Result', 22], ['Flags', 26],
      ['Unit', 10], ['Resident', 24], ['Vehicle on file', 26], ['State on file', 9], ['EV space', 9], ['Charging', 9],
      ['History', 34], ['Notes', 30], ['OCR read', 12], ['Photo file', 30],
    ];
    ws.columns = cols.map(([header, width]) => ({ header, width }));
    headStyle(ws.getRow(1));
    (audit.scans || []).forEach((s, i) => {
      const m = s.match || {};
      const row = ws.addRow([
        i + 1, fmtTime(s.time), s.level || '', s.plate || (s.status === 'NO_PLATE' ? '(none)' : ''), s.state || '',
        STATUS_LABEL[s.status] || s.status, (s.flags || []).map((f) => FLAG_LABEL[f] || f).join('; '),
        m.unit || '', m.name || '', m.vehicle || (s.noPlate ? [s.noPlate.color, s.noPlate.make].filter(Boolean).join(' ') : ''), m.state || '',
        s.ev && s.ev.space ? 'Yes' : '', s.ev && s.ev.space ? (s.ev.charging ? 'Yes' : 'No') : '',
        historyText(s), s.notes || '', s.ocrRead || '', s.photoName || '',
      ]);
      const color = isGood(s) ? FILL.green : FILL.red;
      row.eachCell({ includeEmpty: true }, (c) => { c.fill = fill(color); c.alignment = { vertical: 'top', wrapText: true }; });
      if (s.history && !s.history.count) row.getCell(14).fill = fill(FILL.yellow);
      row.getCell(4).font = { bold: true, name: 'Consolas' };
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

    /* Registered but not seen */
    const ws2 = wb.addWorksheet('Registered Not Seen', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws2.columns = [['Plate', 12], ['State', 7], ['Unit', 10], ['Resident', 26], ['Vehicle', 28], ['Lease status', 16], ['Permit #', 12], ['List row', 9]]
      .map(([header, width]) => ({ header, width }));
    headStyle(ws2.getRow(1));
    sum.notSeen.forEach((v) => ws2.addRow([v.plate, v.state, v.unit, v.name, Vehicles.describe(v), v.statusRaw, v.permit, v.row]));
    if (sum.notSeen.length) ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };

    const buf = await wb.xlsx.writeBuffer();
    return {
      blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      name: `${safe(title)}_Audit_${stamp(audit.startedAt)}.xlsx`,
    };
  }

  async function photosZip(audit, title) {
    const photos = await DB.photosFor(audit.id);
    const zip = new JSZip();
    const byId = new Map(photos.map((p) => [p.id, p]));
    let n = 0;
    (audit.scans || []).forEach((s) => {
      const p = s.photoId && byId.get(s.photoId);
      if (!p) return;
      zip.file(s.photoName, p.blob); n++;
      if (p.crop) zip.file(s.photoName.replace(/\.jpg$/, '_plate.jpg'), p.crop);
    });
    if (!n) return null;
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    return { blob, name: `${safe(title)}_Photos_${stamp(audit.startedAt)}.zip`, count: n };
  }

  function pdf(audit, list, title) {
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const sum = summarize(audit, list);
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
    doc.setFillColor(31, 41, 51); doc.rect(0, 0, W, 70, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(title, M, 32);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text('Garage plate audit summary', M, 52);
    doc.setTextColor(30, 30, 30); doc.setFontSize(10);
    let y = 92;
    const meta = [
      ['Auditor', audit.auditor || '—'], ['Date', fmtDate(audit.startedAt)],
      ['Time', `${fmtTime(audit.startedAt)} – ${audit.finishedAt ? fmtTime(audit.finishedAt) : 'in progress'}`],
      ['Vehicle list', `${list && list.fileName ? list.fileName : '—'}${list && list.counts ? ` · ${list.counts.active} active vehicles` : ''}`],
    ];
    meta.forEach(([k, v], i) => {
      const x = M + (i % 2) * (W / 2 - M / 2), yy = y + Math.floor(i / 2) * 16;
      doc.setFont('helvetica', 'bold'); doc.text(k + ':', x, yy);
      doc.setFont('helvetica', 'normal'); doc.text(String(v).slice(0, 60), x + 62, yy);
    });
    y += 42;

    // headline tiles
    const tiles = [['Scanned', sum.total, [55, 65, 81]], ['Match', sum.good, [22, 128, 61]], ['Non-match', sum.bad, [185, 28, 28]], ['Not seen', sum.notSeen.length, [100, 100, 100]]];
    const tw = (W - M * 2 - 30) / 4;
    tiles.forEach(([lab, n, c], i) => {
      const x = M + i * (tw + 10);
      doc.setFillColor(...c); doc.roundedRect(x, y, tw, 52, 6, 6, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text(String(n), x + 12, y + 30);
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text(lab.toUpperCase(), x + 12, y + 44);
    });
    doc.setTextColor(30, 30, 30);
    y += 68;

    const left = [
      ['Registered (match)', sum.registered], ['Not on file', sum.notOnFile], ['Moved out / inactive', sum.inactive],
      ['No readable plate', sum.noPlate], ['EV space – not charging', sum.evNotCharging], ['State mismatch (flag)', sum.stateMismatch],
      ['First time seen', sum.firstSeen], ['Repeat non-matches', sum.repeatViolators],
    ];
    doc.autoTable({
      startY: y, margin: { left: M, right: W / 2 + 5 }, head: [['Result', 'Count']], body: left,
      theme: 'grid', styles: { fontSize: 9, cellPadding: 3 }, headStyles: { fillColor: [31, 41, 51] },
      columnStyles: { 1: { halign: 'right', cellWidth: 50 } },
    });
    const yL = doc.lastAutoTable.finalY;
    doc.autoTable({
      startY: y, margin: { left: W / 2 + 5, right: M }, head: [['Level / zone', 'Scanned', 'Match', 'Non-match']],
      body: Object.entries(sum.levels).map(([L, v]) => [L, v.total, v.good, v.bad]),
      theme: 'grid', styles: { fontSize: 9, cellPadding: 3 }, headStyles: { fillColor: [31, 41, 51] },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    y = Math.max(yL, doc.lastAutoTable.finalY) + 18;

    // non-match list, fitted to the remaining page
    const bad = (audit.scans || []).filter((s) => !isGood(s));
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text(`Non-matches (${bad.length})`, M, y);
    y += 6;
    const rowH = 15.5, room = Math.floor((H - y - 50) / rowH) - 1;
    const shown = bad.slice(0, Math.max(0, room));
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [['Plate', 'State', 'Level', 'Result', 'Flags', 'History', 'Time']],
      body: shown.map((s) => [s.plate || '(none)', s.state || '', s.level || '', STATUS_LABEL[s.status] || s.status,
        (s.flags || []).map((f) => FLAG_LABEL[f] || f).join('; '), !s.history ? '—' : s.history.count ? `Seen ${s.history.count}x` : 'New', fmtTime(s.time)]),
      theme: 'striped', styles: { fontSize: 8.5, cellPadding: 3, overflow: 'ellipsize' }, headStyles: { fillColor: [185, 28, 28] },
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === 5 && d.cell.raw === 'New') d.cell.styles.fillColor = [255, 235, 156]; },
    });
    if (bad.length > shown.length) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(9);
      doc.text(`+ ${bad.length - shown.length} more — see the Excel report for the full list.`, M, doc.lastAutoTable.finalY + 14);
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120, 120, 120);
    doc.text(`Generated ${fmtDateTime(new Date().toISOString())} on device · ${title}`, M, H - 24);
    return { blob: doc.output('blob'), name: `${safe(title)}_Summary_${stamp(audit.startedAt)}.pdf` };
  }

  function download(file) {
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function share(files, title) {
    const fs = files.filter(Boolean).map((f) => new File([f.blob], f.name, { type: f.blob.type }));
    if (!navigator.canShare || !navigator.canShare({ files: fs })) return false;
    await navigator.share({ files: fs, title });
    return true;
  }

  global.Exporter = { excel, photosZip, pdf, download, share, summarize, isGood, STATUS_LABEL, FLAG_LABEL, historyText, stamp, safe, fmtTime, fmtDate, fmtDateTime };
})(window);
