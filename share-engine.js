(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('./share-core') : root.ShareCore;
  const api = factory(C);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ShareEngine = api;
})(globalThis, function (C) {
  function create({ store, transport, session, notify = () => {} }) {
    let flight;
    async function run() {
      const start = session();
      if (!start.owner) throw Error('Google 계정을 먼저 연결하세요.');
      const activeTransport = typeof transport === 'function' ? transport(start) : transport;
      const check = () => { const now = session(); if (now.owner !== start.owner || now.generation !== start.generation) throw Error('계정 연결이 변경되어 중단했습니다.'); };
      const cached = (await store.read('events')).filter(r => r.owner === start.owner).map(r => r.event);
      check(); const remote = await activeTransport.readEvents(cached); check();
      await store.cache(start.owner, remote); notify();
      for (const initial of (await store.read('outbox')).filter(o => o.owner === start.owner)) {
        let op = initial;
        try {
          check(); op = { ...op, status: 'sending', error: '' }; await store.putOp(op); notify();
          const photos = [...(op.photos || [])];
          op.uploadedPhotos = { ...(op.uploadedPhotos || {}) };
          for (const p of op.localPhotos || []) {
            if (op.uploadedPhotos[p.key]) { photos.push(op.uploadedPhotos[p.key]); continue; }
            check(); const data = await store.read('blobs', p.key);
            if (!data?.blob) throw Error('이 기기의 사진 초안을 찾을 수 없습니다.');
            const uploaded = await activeTransport.putPhoto(data.blob, p.name); check();
            op.uploadedPhotos[p.key] = uploaded; await store.putOp(op); photos.push(uploaded);
          }
          const event = C.validate({ v: 1, id: op.id, card: op.card, at: op.at, parents: op.parents, kind: op.kind,
            ...(op.kind === 'put' ? { text: op.text, photos } : {}), ...(op.kind === 'pin' ? { pinned: op.pinned } : {}) });
          check(); await activeTransport.putEvent(event); check();
          await store.complete(op, event); notify();
        } catch (e) {
          await store.putOp({ ...op, status: 'failed', error: e.message }); notify();
          if (session().owner !== start.owner || session().generation !== start.generation) throw e;
        }
      }
      check();
      const latest = (await store.read('events')).filter(r => r.owner === start.owner).map(r => r.event);
      const fresh = await activeTransport.readEvents(latest); check(); await store.cache(start.owner, fresh); notify();
    }
    function sync() { if (!flight) flight = run().finally(() => { flight = null; }); return flight; }
    return { sync };
  }
  return { create };
});
