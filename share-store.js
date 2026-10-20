(function (root) {
  'use strict';
  function open(factory = indexedDB) {
    return new Promise((resolve, reject) => {
      const r = factory.open('desktop-widget-personal-share-v1', 1);
      r.onupgradeneeded = () => { for (const name of ['drafts', 'blobs', 'outbox', 'events']) r.result.createObjectStore(name, { keyPath: 'id' }); };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error('다른 공유함 탭을 닫고 다시 열어주세요.'));
      r.onsuccess = () => resolve(api(r.result));
    });
  }
  function api(db) {
    function write(names, fn) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readwrite');
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('초안을 저장하지 못했습니다.'));
        try { fn(tx); } catch (e) { tx.abort(); reject(e); }
      });
    }
    function read(name, key) {
      return new Promise((resolve, reject) => {
        const r = db.transaction(name).objectStore(name)[key === undefined ? 'getAll' : 'get'](key);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
    }
    return {
      read, close: () => db.close(),
      saveDraft: (draft, blobs = []) => write(['drafts', 'blobs'], tx => { tx.objectStore('drafts').put(draft); blobs.forEach(b => tx.objectStore('blobs').put(b)); }),
      discardDraft: draft => write(['drafts', 'blobs'], tx => { tx.objectStore('drafts').delete(draft.id); draft.localPhotos.forEach(p => tx.objectStore('blobs').delete(p.key)); }),
      enqueue: (op, draftId) => write(['outbox', 'drafts'], tx => { tx.objectStore('outbox').put(op); if (draftId) tx.objectStore('drafts').delete(draftId); }),
      putOp: op => write(['outbox'], tx => tx.objectStore('outbox').put(op)),
      cache: (owner, events) => write(['events'], tx => events.forEach(event => tx.objectStore('events').put({ id: owner + ':' + event.id, owner, event }))),
      complete: (op, event) => write(['outbox', 'events', 'blobs'], tx => {
        tx.objectStore('events').put({ id: op.owner + ':' + event.id, owner: op.owner, event });
        tx.objectStore('outbox').delete(op.id); (op.localPhotos || []).forEach(p => tx.objectStore('blobs').delete(p.key));
      })
    };
  }
  root.ShareStore = { open };
})(globalThis);
