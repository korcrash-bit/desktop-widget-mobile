/* Encryption only. No network, storage, logging, or short-PIN fallback. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaultCrypto = api;
})(globalThis, function () {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const uuid = /^[a-f0-9-]{36}$/;
  function b64(bytes) { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function bytes(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('암호화 자료 형식이 올바르지 않습니다.');
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  }
  const random = () => crypto.getRandomValues(new Uint8Array(32));
  async function key(raw) { if (raw.byteLength !== 32) throw new Error('등록 코드가 올바르지 않습니다.'); return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function seal(k, value, purpose) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose), tagLength: 128 }, k, enc.encode(JSON.stringify(value)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function open(k, box, purpose) {
    if (!box || bytes(box.iv).length !== 12 || typeof box.ct !== 'string' || box.ct.length > 16000000) throw new Error('암호화 자료 형식이 올바르지 않습니다.');
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv), additionalData: enc.encode(purpose), tagLength: 128 }, k, bytes(box.ct));
      return JSON.parse(dec.decode(plain));
    } catch { throw new Error('잠금을 해제할 수 없습니다. 등록 코드 또는 자료 변경 여부를 확인하세요.'); }
  }
  function purpose(doc) {
    if (!doc || doc.v !== 1 || doc.kind !== 'private-directory' || !uuid.test(doc.device) || !uuid.test(doc.keyId) || !Number.isSafeInteger(doc.seq) || doc.seq < 1) throw new Error('지원하지 않는 보관함입니다.');
    return `directory-v1|${doc.device}|${doc.keyId}|${doc.seq}`;
  }
  async function encrypt(raw, id, keyId, seq, data) {
    const doc = { v: 1, kind: 'private-directory', device: id, keyId, seq };
    doc.box = await seal(await key(raw), validateData(data), purpose(doc)); return doc;
  }
  async function decrypt(k, doc) { return validateData(await open(k, doc.box, purpose(doc))); }
  function validateData(data) {
    const out = {};
    for (const kind of ['contacts', 'vehicles']) {
      const t = data?.[kind];
      if (!t) { out[kind] = null; continue; }
      if (!Array.isArray(t.columns) || !t.columns.length || t.columns.length > 64 || !Array.isArray(t.rows) || t.rows.length > 5000) throw new Error('조회 표 형식 또는 크기를 확인하세요.');
      out[kind] = { columns: t.columns.map(v => String(v).slice(0, 200)), rows: t.rows.map(r => {
        if (!Array.isArray(r) || r.length !== t.columns.length) throw new Error('조회 표의 열 수가 맞지 않습니다.');
        return r.map(v => String(v ?? '').slice(0, 2000));
      }), updatedAt: Number(t.updatedAt) || 0 };
    }
    return out;
  }
  function code(id, keyId, raw) { return `D1.${id}.${keyId}.${b64(raw)}`; }
  function parseCode(text) {
    const [tag, id, keyId, secret, ...extra] = String(text).trim().split('.');
    if (tag !== 'D1' || !uuid.test(id) || !uuid.test(keyId) || extra.length || !secret || bytes(secret).length !== 32) throw new Error('PC에서 표시한 등록·복구 코드를 그대로 입력하세요.');
    return { id, keyId, raw: bytes(secret) };
  }
  return { b64, bytes, random, key, seal, open, encrypt, decrypt, code, parseCode, validateData };
});
