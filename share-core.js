(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShareCore = api;
})(globalThis, function () {
  'use strict';
  const PREFIX = 'desktop-widget-share-v1-';
  const MAX_BYTES = 10 * 1024 * 1024, MAX_PHOTOS = 5, MAX_TEXT = 100000;
  const id = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
  const stable = x => JSON.stringify(x);
  function photo(p) {
    if (!p || !id(p.id) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(p.mime) || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_BYTES) throw Error('사진 정보가 올바르지 않습니다.');
    return { id: p.id, mime: p.mime, size: p.size, name: String(p.name || '사진').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) };
  }
  function validate(e) {
    if (!e || e.v !== 1 || !id(e.id) || !id(e.card) || !Number.isSafeInteger(e.at) || e.at < 0 || !['put', 'delete', 'pin'].includes(e.kind)) throw Error('공유함 변경 기록이 올바르지 않습니다.');
    if (!Array.isArray(e.parents) || e.parents.length > 200 || e.parents.some(p => !id(p) || p === e.id)) throw Error('공유함 변경 이력을 확인하세요.');
    const out = { v: 1, id: e.id, card: e.card, at: e.at, kind: e.kind, parents: [...new Set(e.parents)].sort() };
    if (e.kind === 'put') {
      if (typeof e.text !== 'string' || e.text.length > MAX_TEXT || !Array.isArray(e.photos) || e.photos.length > MAX_PHOTOS) throw Error('텍스트는 10만 자, 사진은 5장까지 보낼 수 있습니다.');
      out.text = e.text; out.photos = e.photos.map(photo);
      if (!out.text.trim() && !out.photos.length) throw Error('보낼 내용이 없습니다.');
    }
    if (e.kind === 'pin') { if (typeof e.pinned !== 'boolean') throw Error('잘못된 고정 정보입니다.'); out.pinned = e.pinned; }
    return out;
  }
  // Immutable operations + causal parents: never replace a device's whole list.
  function merge(...sets) {
    const map = new Map();
    for (const set of sets) for (const raw of set) {
      const e = validate(raw), prior = map.get(e.id);
      if (prior && stable(prior) !== stable(e)) throw Error('같은 전송 ID의 내용이 다릅니다. 자동 덮어쓰기를 중단했습니다.');
      map.set(e.id, e);
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  function cards(events) {
    const all = merge(events), groups = new Map(), result = [];
    for (const e of all) { if (!groups.has(e.card)) groups.set(e.card, []); groups.get(e.card).push(e); }
    for (const [card, group] of groups) {
      const content = group.filter(e => e.kind !== 'pin'), index = new Map(content.map(e => [e.id, e]));
      const superseded = new Set();
      function visit(k, path = new Set()) {
        if (path.has(k)) throw Error('순환된 공유함 변경 이력입니다.');
        if (superseded.has(k)) return;
        const e = index.get(k); if (!e) return;
        const next = new Set(path); next.add(k);
        for (const p of e.parents) visit(p, next);
        superseded.add(k);
      }
      for (const e of content) for (const p of e.parents) visit(p, new Set([e.id]));
      const heads = content.filter(e => !superseded.has(e.id));
      const pin = group.filter(e => e.kind === 'pin').sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))[0];
      for (const e of heads.filter(e => e.kind === 'put')) result.push({ ...e, pinned: !!pin?.pinned,
        conflict: heads.length > 1 ? (heads.some(h => h.kind === 'delete') ? '복구 사본' : '동시 수정 사본') : '', card });
    }
    return result.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at || b.id.localeCompare(a.id));
  }
  function links(text) {
    return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) || []).map(s => s.replace(/[)\],.!?;]+$/, '')).filter(s => {
      try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
    }))];
  }
  function imageType(bytes) {
    const b = new Uint8Array(bytes), ascii = (a, n) => String.fromCharCode(...b.slice(a, a + n));
    if (b[0] === 137 && ascii(1, 3) === 'PNG' && b[4] === 13 && b[5] === 10) return 'image/png';
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
    throw Error('PNG·JPEG·WebP·GIF 사진만 보낼 수 있습니다.');
  }
  return { PREFIX, MAX_BYTES, MAX_PHOTOS, MAX_TEXT, validate, merge, cards, links, photo, imageType };
});
