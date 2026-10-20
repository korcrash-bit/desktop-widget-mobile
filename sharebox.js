'use strict';
const C = ShareCore, $ = id => document.getElementById(id), uuid = () => crypto.randomUUID();
const nativeGoogle = window.NativeBridge?.plugin('NativeGoogle'), nativeShare = window.NativeBridge?.plugin('NativeShare');
let store, engine, owner = '', accessToken = '', expires = 0, generation = 0, saveFlight = Promise.resolve(), composingBusy = false;
let draft = fresh(), events = [], objectUrls = [], editorUrls = [], renderRun = 0, incomingBusy = false;
function fresh() { return { id: uuid(), owner, text: '', photos: [], localPhotos: [], parents: [], card: uuid(), at: Date.now() }; }
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function button(text, fn) { const b = el('button', text); b.type = 'button'; b.onclick = () => Promise.resolve().then(fn).catch(fail); return b; }
function message(text) { $('status').textContent = text; }
function fail(e) { message(e.message || String(e)); }
function session() { return { owner, generation }; }
function driveSession() {
  const account = owner, token = accessToken, expiry = expires, run = generation;
  return ShareDrive.create(async () => {
    if (!account || !token || Date.now() >= expiry) throw Error('Google 계정을 다시 연결하세요. 미전송 내용은 이 기기에 남아 있습니다.');
    if (account !== owner || run !== generation) throw Error('계정 연결이 변경되어 전송을 중단했습니다.');
    return token;
  });
}
function saveDraft() {
  if (!store || composingBusy) return saveFlight;
  draft.text = $('text').value; draft.at = Date.now();
  if (!draft.owner && owner) draft.owner = owner;
  if (!draft.text && !draft.photos.length && !draft.localPhotos.length && !draft.parents.length) return saveFlight;
  const saved = structuredClone(draft);
  $('draft-status').textContent = '초안 저장 중…';
  saveFlight = store.saveDraft(saved).then(() => { $('draft-status').textContent = '초안을 이 기기에 보관했습니다.'; return renderDrafts(); });
  saveFlight.catch(e => { $('draft-status').textContent = '초안을 저장하지 못했습니다. 화면을 닫지 마세요.'; fail(e); });
  return saveFlight;
}
async function chooseDraft(next) {
  await saveFlight; draft = structuredClone(next); $('text').value = draft.text;
  $('editor-title').textContent = draft.parents.length ? '항목 수정 · 다른 기기의 동시 수정도 보존됩니다' : '보낼 내용';
  await renderAttachments();
}
async function renderDrafts() {
  if (!store) return;
  const rows = (await store.read('drafts')).filter(d => d.owner === owner || !d.owner).sort((a, b) => b.at - a.at);
  $('draft-count').textContent = '(' + rows.length + ')'; $('drafts').replaceChildren();
  for (const d of rows) { const row = el('div', null, 'draft-row'); row.append(el('span', d.text.slice(0, 70) || `사진 ${d.localPhotos.length + d.photos.length}장`), button('초안 열기', () => chooseDraft(d))); $('drafts').append(row); }
}
async function addPhotos(files) {
  const target = draft.id;
  const selected = Array.from(files); if (draft.photos.length + draft.localPhotos.length + selected.length > C.MAX_PHOTOS) throw Error('사진은 5장까지 첨부하세요.');
  const rows = [], metadata = [];
  for (const file of selected) {
    if (file.size < 1 || file.size > C.MAX_BYTES) throw Error('사진은 한 장당 10MB까지 보낼 수 있습니다.');
    const mime = C.imageType(await file.slice(0, 16).arrayBuffer()), key = uuid();
    rows.push({ id: key, blob: new Blob([file], { type: mime }) }); metadata.push({ key, name: file.name || '사진', size: file.size, mime });
  }
  await saveFlight;
  if (draft.id !== target) throw Error('초안이 바뀌었습니다. 선택한 초안에 사진을 다시 넣어주세요.');
  if (!draft.owner && owner) draft.owner = owner;
  draft.text = $('text').value; draft.localPhotos.push(...metadata); draft.at = Date.now();
  await store.saveDraft(structuredClone(draft), rows); await renderAttachments(); await renderDrafts();
  $('draft-status').textContent = '사진과 초안을 이 기기에 보관했습니다.';
}
async function renderAttachments() {
  editorUrls.forEach(URL.revokeObjectURL); editorUrls = []; $('attachments').replaceChildren();
  for (const p of [...draft.photos, ...draft.localPhotos]) {
    const row = el('div', null, 'draft-row'); row.append(el('span', p.name));
    if (p.key) { const data = await store.read('blobs', p.key); if (data?.blob) { const img = el('img'); img.width = 80; img.alt = p.name; img.src = URL.createObjectURL(data.blob); editorUrls.push(img.src); row.prepend(img); } }
    row.append(button('사진 제외', async () => { draft.photos = draft.photos.filter(x => x !== p); draft.localPhotos = draft.localPhotos.filter(x => x !== p); await saveDraft(); await renderAttachments(); }));
    $('attachments').append(row);
  }
}
async function synchronize() {
  if (!owner || !engine) return;
  const run = generation;
  message('최신 항목을 확인하고 전송 중입니다…');
  try {
    const work = () => engine.sync();
    if (navigator.locks) await navigator.locks.request('personal-share-send', work); else await work();
    if (run !== generation) return;
    await render();
    const pending = (await store.read('outbox')).filter(o => o.owner === owner);
    message(pending.length ? '미전송 항목이 남았습니다. 실패 이유를 확인하고 다시 보내세요.' : '전송·동기화 완료 · ' + new Date().toLocaleTimeString('ko-KR'));
  } catch (e) { if (run === generation) { fail(e); await render(); } }
}
async function submit() {
  if (!owner) { await saveDraft(); throw Error('초안은 보관했습니다. Google 계정을 연결한 뒤 보내세요.'); }
  if (draft.owner && draft.owner !== owner) throw Error('이 초안을 작성한 계정으로 연결하세요.');
  await saveDraft();
  if (!draft.text.trim() && !draft.photos.length && !draft.localPhotos.length) throw Error('안내문·링크 또는 사진을 넣어주세요.');
  const op = { ...structuredClone(draft), id: uuid(), owner, kind: 'put', status: 'pending', error: '', at: Date.now() };
  await store.enqueue(op, draft.id); await chooseDraft(fresh()); await renderDrafts(); await render(); await synchronize();
}
async function operation(card, kind, extra = {}) {
  if (!owner) throw Error('로그인 후 이용하세요.');
  const op = { id: uuid(), owner, card: card.card, parents: kind === 'pin' ? [] : [card.id], kind, at: Date.now(), status: 'pending', localPhotos: [], ...extra };
  await store.enqueue(op); await render(); await synchronize();
}
async function copy(text) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else { const input = el('textarea'); input.value = text; document.body.append(input); input.select(); const ok = document.execCommand('copy'); input.remove(); if (!ok) throw Error('브라우저에서 복사를 허용해주세요.'); }
  message('안내문 전체를 복사했습니다. 학교 메신저에 붙여넣으세요.');
}
async function showPhoto(p, image, download) {
  const run = generation, blob = await driveSession().getPhoto(p); if (run !== generation || !owner) return;
  const url = URL.createObjectURL(blob); objectUrls.push(url);
  if (download && nativeShare) {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let text = ''; for (const b of bytes) text += String.fromCharCode(b);
    await nativeShare.savePhoto({ base64: btoa(text), mime: p.mime, name: p.name }); message('사진을 저장했습니다.');
  } else if (download) { const a = el('a'); a.href = url; a.download = p.name; document.body.append(a); a.click(); a.remove(); }
  else { image.src = url; image.hidden = false; $('preview-image').src = url; $('preview').showModal(); }
}
async function render() {
  if (!store) return; const run = ++renderRun, account = owner;
  const [cached, ops] = await Promise.all([store.read('events'), store.read('outbox')]); if (run !== renderRun || account !== owner) return;
  if (!$('preview').open) { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
  events = cached.filter(r => account && r.owner === account).map(r => r.event);
  $('outbox').replaceChildren();
  for (const op of ops.filter(o => account && o.owner === account)) {
    const row = el('div', null, 'queue-row'); row.append(el('strong', ({ sending: '전송 중', failed: '전송 실패', pending: '전송 대기' })[op.status] || '전송 대기'), el('p', op.text?.slice(0, 100) || (op.kind === 'delete' ? '항목 삭제' : '고정 변경')));
    if (op.error) row.append(el('small', op.error)); row.append(button('다시 시도', synchronize)); $('outbox').append(row);
  }
  if (!$('outbox').children.length) $('outbox').append(el('p', account ? '미전송 항목이 없습니다.' : '로그인하면 이 계정의 전송 상태를 확인할 수 있습니다.'));
  $('cards').replaceChildren(); if (!account) { $('cards').append(el('p', 'Google 계정을 연결해주세요.')); return; }
  const query = $('search').value.toLocaleLowerCase();
  for (const card of C.cards(events).filter(c => (c.text + ' ' + c.photos.map(p => p.name).join(' ')).toLocaleLowerCase().includes(query))) {
    const item = el('article', null, 'card'); item.dataset.event = card.id;
    item.append(el('p', `${card.pinned ? '📌 고정 · ' : ''}전송 완료 · ${new Date(card.at).toLocaleString('ko-KR')}`, 'meta'));
    if (card.conflict) item.append(el('span', card.conflict + ' · 다른 기기의 내용도 보존했습니다.', 'badge'));
    item.append(el('p', card.text, 'card-text'));
    for (const url of C.links(card.text)) { const a = el('a', '링크 열기: ' + url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; item.append(a, el('br')); }
    const grid = el('div', null, 'photo-grid');
    for (const p of card.photos) {
      const tile = el('div', null, 'photo'), img = el('img'); img.alt = p.name;
      img.hidden = true;
      tile.append(el('div', p.name, 'photo-name'), img, button('미리보기', () => showPhoto(p, img, false)), button('다운로드', () => showPhoto(p, img, true))); grid.append(tile);
    }
    item.append(grid);
    const actions = el('div', null, 'actions');
    actions.append(button('안내문 전체 복사', () => copy(card.text)), button(card.pinned ? '고정 해제' : '고정', () => operation(card, 'pin', { pinned: !card.pinned })),
      button('수정', async () => { await saveDraft(); const d = { ...fresh(), owner, card: card.card, parents: [card.id], text: card.text, photos: card.photos }; await store.saveDraft(d); await chooseDraft(d); $('text').focus(); $('dropzone').scrollIntoView({ behavior: 'smooth' }); }),
      button('삭제', async () => { if (confirm('이 항목을 삭제할까요? 동시에 수정된 내용은 복구 사본으로 보존됩니다.')) await operation(card, 'delete'); }));
    item.append(actions); $('cards').append(item);
  }
  if (!$('cards').children.length) $('cards').append(el('p', query ? '검색 결과가 없습니다.' : '보낸 항목이 없습니다. 안내문이나 사진을 보내보세요.'));
}
async function completeLogin(authRun, token, seconds) {
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error('Google 계정을 확인하지 못했습니다. 다시 연결하세요.');
  const user = (await r.json()).user;
  if (!user?.permissionId) throw Error('Google 계정을 확인하지 못했습니다.');
  if (authRun !== generation) return;
  if (owner && owner !== user.permissionId) throw Error('다른 계정으로 바꾸려면 먼저 로그아웃하세요.');
  owner = user.permissionId; accessToken = token; expires = Date.now() + (Number(seconds || 3600) - 60) * 1000;
  $('account').textContent = user.emailAddress || 'Google 계정 연결됨'; $('login').textContent = 'Google 계정 다시 연결'; $('logout').hidden = false; $('refresh').disabled = false;
  if (!draft.text && !draft.localPhotos.length && !draft.photos.length) {
    const latest = (await store.read('drafts')).filter(d => d.owner === owner || !d.owner).sort((a, b) => b.at - a.at)[0]; if (latest) await chooseDraft(latest);
  }
  await saveDraft(); await renderDrafts(); await synchronize();
}
async function login() {
  const run = generation;
  if (nativeGoogle) { const r = await nativeGoogle.authorize(); return completeLogin(run, r.accessToken, r.expiresIn); }
  if (!window.MOBILE_CONFIG?.clientId || !window.google?.accounts?.oauth2) throw Error('Google 로그인 화면을 불러오지 못했습니다. 인터넷 연결 후 다시 시도하세요.');
  google.accounts.oauth2.initTokenClient({ client_id: MOBILE_CONFIG.clientId, scope: 'https://www.googleapis.com/auth/drive.appdata', include_granted_scopes: false,
    error_callback: () => message('로그인 창이 닫혔습니다. 초안은 보관되어 있습니다.'), callback: r => {
      if (r.error) return message('Google 연결을 완료하지 못했습니다.');
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, 'https://www.googleapis.com/auth/drive.appdata')) return message('공유함의 앱 전용 Drive 권한이 필요합니다.');
      completeLogin(run, r.access_token, r.expires_in).catch(fail);
    } }).requestAccessToken({ prompt: 'select_account' });
}
async function incoming() {
  if (!nativeShare || !store || incomingBusy) return; incomingBusy = true;
  try {
    const data = await nativeShare.list();
    for (const item of data.items || []) {
      const key = 'native-' + item.id;
      if (!await store.read('drafts', key)) {
        const d = { ...fresh(), id: key, owner: '', text: item.text || '' }, blobs = [];
        for (let i = 0; i < item.photos.length; i++) {
          const p = await nativeShare.readPhoto({ id: item.id, index: i });
          const bytes = Uint8Array.from(atob(p.base64), c => c.charCodeAt(0)), mime = C.imageType(bytes), blobKey = key + '-' + i;
          if (bytes.length > C.MAX_BYTES) throw Error('공유한 사진이 너무 큽니다.');
          blobs.push({ id: blobKey, blob: new Blob([bytes], { type: mime }) }); d.localPhotos.push({ key: blobKey, name: p.name || '사진', size: bytes.length, mime });
        }
        await store.saveDraft(d, blobs);
        if (!draft.text && !draft.localPhotos.length && !draft.photos.length) await chooseDraft(d);
      }
      await nativeShare.acknowledge({ id: item.id });
    }
    await renderDrafts();
  } catch (e) { fail(e); } finally { incomingBusy = false; }
}
async function init() {
  store = await ShareStore.open(); engine = ShareEngine.create({ store, transport: driveSession, session, notify: () => render().catch(fail) });
  const saved = (await store.read('drafts')).filter(d => !d.owner).sort((a, b) => b.at - a.at)[0]; if (saved) await chooseDraft(saved);
  $('text').oninput = () => saveDraft();
  $('photos').onchange = async e => { try { await addPhotos(e.target.files); } catch (err) { fail(err); } e.target.value = ''; };
  $('dropzone').ondragover = e => { e.preventDefault(); $('dropzone').classList.add('dragging'); };
  $('dropzone').ondragleave = () => $('dropzone').classList.remove('dragging');
  $('dropzone').ondrop = async e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); try { if (e.dataTransfer.files.length) await addPhotos(e.dataTransfer.files); else { $('text').value += e.dataTransfer.getData('text/plain'); await saveDraft(); } } catch (err) { fail(err); } };
  $('text').addEventListener('paste', e => { if (e.clipboardData.files.length) { e.preventDefault(); addPhotos(e.clipboardData.files).catch(fail); } });
  $('login').onclick = () => login().catch(fail); $('refresh').onclick = synchronize; $('retry').onclick = synchronize;
  $('send').onclick = async () => { $('dropzone').inert = true; $('send').disabled = true; try { await submit(); } catch (e) { fail(e); } finally { $('dropzone').inert = false; $('send').disabled = false; } };
  $('new').onclick = async () => { await saveDraft(); await chooseDraft(fresh()); };
  $('discard').onclick = async () => { if (!confirm('이 기기의 초안을 삭제할까요?')) return; await saveFlight; await store.discardDraft(draft); await chooseDraft(fresh()); await renderDrafts(); };
  $('logout').onclick = async () => {
    await saveDraft(); generation++; owner = ''; accessToken = ''; expires = 0;
    await chooseDraft(fresh()); $('account').textContent = '로그아웃했습니다. 초안은 작성한 계정으로 다시 로그인하면 볼 수 있습니다.';
    $('login').textContent = 'Google 계정 연결'; $('logout').hidden = true; $('refresh').disabled = true; $('preview').close(); await render(); await renderDrafts();
    if (nativeGoogle) await nativeGoogle.clearToken();
  };
  $('search').oninput = render; $('close-preview').onclick = () => $('preview').close();
  for (const id of ['new', 'discard', 'logout']) { const fn = $(id).onclick; $(id).onclick = () => Promise.resolve().then(fn).catch(fail); }
  window.addEventListener('online', synchronize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { synchronize(); incoming(); } });
  window.addEventListener('focus', () => { synchronize(); incoming(); });
  setInterval(() => { if (!document.hidden && navigator.onLine) synchronize(); }, 30000);
  if (nativeShare) setInterval(() => { if (!document.hidden) incoming(); }, 5000);
  await renderDrafts(); await render(); await incoming();
}
init().catch(e => { fail(e); $('send').disabled = true; $('text').disabled = true; });
