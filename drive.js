(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MobileDrive = api;
})(globalThis, function () {
  'use strict';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const PREFIX = 'desktop-widget-mobile-v1-';
  function create(getToken, request = fetch, prefix = PREFIX) {
    if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error('잘못된 동기화 이름입니다.');
    async function call(url, opts = {}) {
      const token = await getToken();
      const r = await request(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        const error = new Error(r.status === 401 ? '로그인이 만료됐습니다. 다시 연결하세요.' : r.status === 403 ? '앱 전용 Drive 권한이 필요합니다. 구글 계정을 다시 연결하세요.' : `동기화 통신 실패 (${r.status})`);
        error.status = r.status; throw error;
      }
      return r.json();
    }
    async function readAll() {
      const files = []; let pageToken = '';
      do {
        const q = new URLSearchParams({ spaces: 'appDataFolder', q: `trashed = false and name contains '${prefix}'`, fields: 'nextPageToken,files(id,name)', pageSize: '100' });
        if (pageToken) q.set('pageToken', pageToken);
        const page = await call(API + '?' + q);
        files.push(...(page.files || []).filter(f => f.name.startsWith(prefix))); pageToken = page.nextPageToken || '';
      } while (pageToken);
      // Do not turn a failed read into an empty account, which could overwrite data.
      return Promise.all(files.map(async f => ({ ...f, doc: await call(`${API}/${encodeURIComponent(f.id)}?alt=media`) })));
    }
    async function write(doc, files) {
      const name = prefix + doc.device + '.json';
      const own = files.filter(f => f.name === name);
      if (own.length > 1) throw new Error('같은 기기의 동기화 파일이 중복됐습니다. 파일을 확인해야 합니다.');
      if (own.length) return call(`${UPLOAD}/${encodeURIComponent(own[0].id)}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
      const boundary = 'widget_' + crypto.randomUUID();
      const meta = { name, mimeType: 'application/json', parents: ['appDataFolder'] };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
      return call(UPLOAD + '?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    }
    return { readAll, write };
  }
  return { create, PREFIX };
});
