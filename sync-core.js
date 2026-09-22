/* Shared by Electron and the static companion page. No credentials belong here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileSync = api;
})(globalThis, function () {
  'use strict';
  const EDITABLE = ['todos', 'memos', 'progress'];
  const FIELDS = {
    todos: ['id', 'text', 'cat', 'done', 'date', 'time', 'when'],
    memos: ['id', 'text'], progress: ['date', 'subject', 'klass', 'body', 'memo'],
    roster: ['cls', 'no', 'name']
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function clean(kind, row) {
    if (!row || typeof row !== 'object') throw new Error('잘못된 모바일 데이터입니다.');
    const out = {};
    for (const field of FIELDS[kind]) {
      if (row[field] == null) continue;
      if (field === 'done') out[field] = !!row[field];
      else if (field === 'id' && typeof row[field] === 'number') out[field] = row[field];
      else out[field] = String(row[field]).slice(0, 20000);
    }
    if (EDITABLE.includes(kind)) key(kind, out);
    return out;
  }
  function key(kind, row) {
    if (kind === 'progress') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !row.subject || !row.klass) throw new Error('진도의 날짜·과목·반을 확인하세요.');
      return JSON.stringify([row.date, row.subject, row.klass]);
    }
    if (row.id == null || String(row.id) === '') throw new Error('항목 ID가 없습니다.');
    return String(row.id);
  }
  function empty(device, role) { return { v: 1, device, role, records: {}, snapshot: null }; }
  const rev = e => e ? `${e.at}:${e.writer}` : '';
  const compare = (a, b) => a.at - b.at || a.writer.localeCompare(b.writer);
  function history(...records) {
    const map = new Map();
    for (const e of records.filter(Boolean)) {
      for (const [writer, at] of Object.entries(e.seen || {})) map.set(writer, Math.max(map.get(writer) || 0, at));
      map.set(e.writer, Math.max(map.get(e.writer) || 0, e.at));
    }
    return Object.fromEntries(map);
  }
  const saw = (a, b) => a.parent === rev(b) || Object.hasOwn(a.seen || {}, b.writer) && a.seen[b.writer] >= b.at;
  function entries(doc, kind) { return doc.records[kind] || {}; }
  function rows(doc, kind) { return Object.values(entries(doc, kind)).filter(e => !e.deleted).map(e => clone(e.value)); }
  function sortTodos(input) {
    const dated = /^\d{4}-\d{2}-\d{2}$/, timed = /^\d{2}:\d{2}$/;
    return input.map((row, index) => ({ row, index })).sort((a, b) => {
      const done = Number(!!a.row.done) - Number(!!b.row.done);
      if (done) return done;
      if (a.row.done) return a.index - b.index;
      const ad = dated.test(a.row.date || '') ? a.row.date : '';
      const bd = dated.test(b.row.date || '') ? b.row.date : '';
      if (!ad && bd) return -1;
      if (ad && !bd) return 1;
      if (ad !== bd) return ad.localeCompare(bd);
      const at = timed.test(a.row.time || '') ? a.row.time : '';
      const bt = timed.test(b.row.time || '') ? b.row.time : '';
      if (at !== bt) return (at || '99:99').localeCompare(bt || '99:99');
      return a.index - b.index;
    }).map(x => x.row);
  }
  function capture(doc, kind, next, at = Date.now()) {
    const prior = entries(doc, kind), map = new Map(next.map(r => { const v = clean(kind, r); return [key(kind, v), v]; }));
    const out = new Map(Object.entries(prior)), changed = [];
    for (const k of new Set([...Object.keys(prior), ...map.keys()])) {
      const old = Object.hasOwn(prior, k) ? prior[k] : undefined, value = map.get(k), deleted = !map.has(k);
      if (old && old.deleted === deleted && (deleted || equal(old.value, value))) continue;
      if (!old && deleted) continue;
      out.set(k, { at: Math.max(at, (old?.at || 0) + 1), writer: doc.device, parent: rev(old), seen: history(old), deleted, ...(deleted ? {} : { value }) });
      changed.push(`${kind}:${k}`);
    }
    doc.records[kind] = Object.fromEntries(out);
    return changed;
  }
  function validate(raw) {
    if (!raw || raw.v !== 1 || !['desktop', 'mobile'].includes(raw.role) || typeof raw.device !== 'string' || !raw.records) throw new Error('지원하지 않거나 손상된 모바일 동기화 파일입니다.');
    const doc = empty(raw.device, raw.role);
    for (const kind of EDITABLE) {
      const out = new Map();
      for (const [k, e] of Object.entries(raw.records[kind] || {})) {
        if (!e || !Number.isSafeInteger(e.at) || e.at < 0 || typeof e.writer !== 'string' || typeof e.deleted !== 'boolean') throw new Error('손상된 변경 기록입니다.');
        const value = e.deleted ? undefined : clean(kind, e.value);
        if (value && key(kind, value) !== k) throw new Error('항목 키가 일치하지 않습니다.');
        const seen = Object.fromEntries(Object.entries(e.seen || {}).map(([writer, at]) => {
          if (!Number.isSafeInteger(at) || at < 0) throw new Error('손상된 변경 이력입니다.');
          return [writer, at];
        }));
        out.set(k, { at: e.at, writer: e.writer, parent: String(e.parent || ''), seen, deleted: e.deleted, ...(value ? { value } : {}) });
      }
      doc.records[kind] = Object.fromEntries(out);
    }
    if (raw.role === 'desktop' && raw.snapshot) {
      const s = raw.snapshot;
      if (!Number.isSafeInteger(s.at) || !s.data) throw new Error('조회 데이터가 손상됐습니다.');
      doc.snapshot = { at: s.at, data: {
        roster: (s.data.roster || []).map(r => clean('roster', r)),
        timetable: sanitizeTimetable(s.data.timetable), meal: sanitizeMeal(s.data.meal)
      } };
    }
    return doc;
  }
  function sanitizeTimetable(t) {
    if (!t) return null;
    const cells = {};
    for (const [k, v] of Object.entries(t.cells || {})) if (/^[1-5]-\d{1,2}$/.test(k) && v) cells[k] = { subject: String(v.subject || ''), klass: String(v.klass || ''), teacher: String(v.teacher || ''), changed: !!v.changed };
    return { at: Number(t.at) || 0, schoolName: String(t.schoolName || ''), updatedAt: String(t.updatedAt || ''), cells };
  }
  function sanitizeMeal(m) {
    if (!m) return null;
    return { at: Number(m.at) || 0, ymd: String(m.ymd || ''), meals: (m.meals || []).map(x => ({ nm: String(x.nm || ''), items: (x.items || []).map(String), kcal: String(x.kcal || '') })) };
  }
  function merge(local, remotes, pending = new Set()) {
    const result = clone(local), conflicts = [];
    for (const raw of remotes) {
      const remote = validate(raw);
      for (const kind of EDITABLE) {
        const map = new Map(Object.entries(entries(result, kind)));
        for (const [k, r] of Object.entries(entries(remote, kind))) {
          const l = map.get(k);
          if (l && rev(l) !== rev(r) && l.at > 1 && r.at > 1 && !saw(r, l) && !saw(l, r) && !equal(l.value, r.value)) conflicts.push(kind);
          if (!l) map.set(k, r);
          else map.set(k, { ...(compare(r, l) > 0 ? r : l), seen: history(l, r) });
        }
        result.records[kind] = Object.fromEntries(map);
      }
      // Mobile files cannot provide roster or school snapshots.
      if (remote.snapshot && (!result.snapshot || remote.snapshot.at > result.snapshot.at)) result.snapshot = remote.snapshot;
    }
    return { doc: result, conflicts: [...new Set(conflicts)] };
  }
  function payload(doc) {
    const out = clone(doc);
    if (out.role === 'mobile') out.snapshot = null;
    return out;
  }
  return { EDITABLE, clean, key, empty, rows, sortTodos, capture, merge, validate, payload, equal, rev, sanitizeMeal, sanitizeTimetable };
});
