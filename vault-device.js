/* Only a PRF-wrapped secret is persisted. Never persist raw keys or plaintext. */
(function () {
  'use strict';
  const V = window.VaultCrypto;
  async function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('widget-private-devices-v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('devices');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('기기 등록 정보를 저장할 수 없습니다. 일반 브라우저 창을 사용하세요.'));
    });
  }
  async function storage(id, value, remove = false) {
    const conn = await db();
    try {
      return await new Promise((resolve, reject) => {
        const tx = conn.transaction('devices', value === undefined && !remove ? 'readonly' : 'readwrite');
        const store = tx.objectStore('devices');
        const req = remove ? store.delete(id) : value === undefined ? store.get(id) : store.put(value, id);
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(new Error('기기 등록 정보를 저장하지 못했습니다.'));
        tx.onabort = tx.onerror;
      });
    } finally { conn.close(); }
  }
  const address = (account, id) => JSON.stringify([account, id]);
  const purpose = (account, id, keyId) => `device-wrap-v1|${account}|${id}|${keyId}`;
  function verify(credential, challenge, type) {
    if (!credential) throw new Error('기기 인증을 취소했습니다.');
    const client = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
    if (client.type !== type || client.origin !== location.origin || client.challenge !== V.b64(challenge) || client.crossOrigin) throw new Error('기기 인증 응답이 일치하지 않습니다.');
    const authData = type === 'webauthn.get' ? credential.response.authenticatorData : credential.response.getAuthenticatorData?.();
    if (!authData || !(new Uint8Array(authData)[32] & 4)) throw new Error('기기에서 본인 확인을 완료해야 합니다.');
  }
  async function prfFor(record) {
    const challenge = V.random();
    const credential = await navigator.credentials.get({ publicKey: {
      challenge, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: V.bytes(record.credentialId) }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { evalByCredential: { [record.credentialId]: { first: V.bytes(record.salt) } } } }
    } });
    verify(credential, challenge, 'webauthn.get');
    if (V.b64(credential.rawId) !== record.credentialId) throw new Error('등록된 인증 수단과 다릅니다.');
    const output = credential.getClientExtensionResults()?.prf?.results?.first;
    if (!output || output.byteLength !== 32) throw new Error('이 기기는 보관함용 기기 인증을 지원하지 않습니다. 이번 탭에서만 등록·복구 코드로 열 수 있습니다.');
    const bytes = new Uint8Array(output);
    try { return await V.key(bytes); } finally { bytes.fill(0); }
  }
  async function enroll(account, parsed, stillCurrent = () => true) {
    if (!isSecureContext || !window.PublicKeyCredential || !navigator.credentials) throw new Error('HTTPS의 지원 브라우저에서 등록하세요. 이번 탭에서만 코드로 열기도 가능합니다.');
    const challenge = V.random(), salt = V.random();
    const credential = await navigator.credentials.create({ publicKey: {
      challenge, rp: { name: '나의 교무수첩 개인정보 보관함', id: location.hostname },
      user: { id: V.random(), name: '내 개인정보 보관함', displayName: '내 개인정보 보관함' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      attestation: 'none', timeout: 60000, extensions: { prf: { eval: { first: salt } } }
    } });
    verify(credential, challenge, 'webauthn.create');
    const record = { v: 1, id: parsed.id, keyId: parsed.keyId, credentialId: V.b64(credential.rawId), salt: V.b64(salt), lastSeq: 0 };
    // A real assertion proves PRF works before any secret is persisted.
    const wrapping = await prfFor(record);
    if (!stillCurrent()) throw new Error('연결 상태가 바뀌어 등록을 중단했습니다.');
    record.box = await V.seal(wrapping, { secret: V.b64(parsed.raw) }, purpose(account, parsed.id, parsed.keyId));
    if (!stillCurrent()) throw new Error('연결 상태가 바뀌어 등록을 중단했습니다.');
    await storage(address(account, parsed.id), record);
    if (!stillCurrent()) { await storage(address(account, parsed.id), undefined, true); throw new Error('연결 상태가 바뀌어 등록을 취소했습니다.'); }
    return record;
  }
  async function unlock(account, record) {
    const wrapping = await prfFor(record);
    const { secret } = await V.open(wrapping, record.box, purpose(account, record.id, record.keyId));
    const raw = V.bytes(secret);
    try { return await V.key(raw); } finally { raw.fill(0); }
  }
  window.VaultDevice = {
    enroll, unlock,
    load: (account, id) => storage(address(account, id)),
    forget: (account, id) => storage(address(account, id), undefined, true),
    checkpoint: (account, record, seq) => storage(address(account, record.id), { ...record, lastSeq: seq })
  };
})();
