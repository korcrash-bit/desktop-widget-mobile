(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('./share-core') : root.ShareCore;
  const api = factory(C);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ShareDrive = api;
})(globalThis, function (C) {
  'use strict';
  const API = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  function create(token, request = fetch) {
    async function call(url, opts = {}) {
      const r = await request(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + await token() }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw Error(r.status === 401 ? '로그인을 다시 연결하세요. 초안은 보관되어 있습니다.' : r.status === 403 ? '공유함 Drive 권한을 확인하세요. 초안은 보관되어 있습니다.' : `전송 실패 (${r.status}) · 다시 시도할 수 있습니다.`);
      return r;
    }
    async function list(q) {
      const files = []; let pageToken = '';
      do {
        const p = new URLSearchParams({ spaces: 'appDataFolder', q: 'trashed = false and ' + q, fields: 'nextPageToken,files(id,name,size,mimeType,appProperties)', pageSize: '100' });
        if (pageToken) p.set('pageToken', pageToken);
        const page = await (await call(API + '?' + p)).json(); files.push(...(page.files || [])); pageToken = page.nextPageToken || '';
      } while (pageToken);
      return files;
    }
    async function content(id) { return call(API + '/' + encodeURIComponent(id) + '?alt=media'); }
    async function upload(name, blob, extra = {}) {
      const boundary = 'share_' + crypto.randomUUID();
      const meta = { name, mimeType: blob.type, parents: ['appDataFolder'], ...extra };
      const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`, blob, `\r\n--${boundary}--`], { type: 'multipart/related; boundary=' + boundary });
      return (await call(UPLOAD + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': body.type }, body })).json();
    }
    return {
      async readEvents(cached = []) {
        const known = new Map(cached.map(e => [e.id, C.validate(e)])), received = [];
        const prefix = C.PREFIX + 'event-';
        for (const f of await list(`name contains '${prefix}'`)) {
          if (!f.name.startsWith(prefix) || !f.name.endsWith('.json')) continue;
          const eventId = f.name.slice(prefix.length, -5);
          const event = known.get(eventId) || C.validate(await (await content(f.id)).json());
          if (event.id !== eventId) throw Error('공유함 파일의 전송 ID가 다릅니다.');
          received.push(event);
        }
        return C.merge(cached, received);
      },
      async putEvent(raw) {
        const event = C.validate(raw), name = C.PREFIX + 'event-' + event.id + '.json';
        const existing = await list(`name = '${name}'`);
        if (existing.length) { for (const f of existing) C.merge([event], [await (await content(f.id)).json()]); return event; }
        await upload(name, new Blob([JSON.stringify(event)], { type: 'application/json' })); return event;
      },
      async putPhoto(blob, filename) {
        if (!blob || blob.size < 1 || blob.size > C.MAX_BYTES) throw Error('사진은 한 장당 10MB까지 보낼 수 있습니다.');
        const bytes = await blob.arrayBuffer(), mime = C.imageType(bytes);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        const name = C.PREFIX + 'image-' + hash;
        const existing = await list(`name = '${name}'`);
        let file;
        if (existing.length) {
          file = existing[0];
          if (Number(file.size) !== blob.size || file.appProperties?.sha256 !== hash || file.mimeType !== mime) throw Error('사진 파일의 무결성을 확인하지 못했습니다.');
        } else file = await upload(name, new Blob([bytes], { type: mime }), { appProperties: { sha256: hash } });
        return C.photo({ id: file.id, name: filename, mime, size: blob.size });
      },
      async getPhoto(raw) {
        const p = C.photo(raw), meta = await (await call(API + '/' + encodeURIComponent(p.id) + '?fields=name,size,spaces,mimeType')).json();
        if (!meta.name?.startsWith(C.PREFIX + 'image-') || !meta.spaces?.includes('appDataFolder') || Number(meta.size) !== p.size || meta.mimeType !== p.mime) throw Error('공유함 사진 파일이 아닙니다.');
        const blob = await (await content(p.id)).blob();
        const bytes = await blob.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (blob.size !== p.size || C.imageType(bytes) !== p.mime || meta.name !== C.PREFIX + 'image-' + hash) throw Error('사진이 손상됐습니다.');
        return new Blob([blob], { type: p.mime });
      }
    };
  }
  return { create };
});
