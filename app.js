'use strict';
const C = window.MobileSync;
const $ = id => document.getElementById(id);
const titles = { todos: '할 일', memos: '메모', progress: '수업 진도', school: '시간표·급식', roster: '학생 명렬', contacts: '비상연락망', vehicles: '차량현황' };
const demoMode = new URLSearchParams(location.search).get('demo') === '1';
const nativeGoogle = window.NativeBridge?.plugin('NativeGoogle');
const nativeUpdate = window.NativeBridge?.plugin('NativeUpdate');
function takePrivateInviteFromUrl() {
  const params = new URLSearchParams(location.hash.slice(1)), value = params.get('private') || '';
  if (params.has('private')) history.replaceState(null, '', location.pathname + location.search);
  if (!value) return '';
  try { const parsed = VaultCrypto.parseCode(value); parsed.raw.fill(0); return value; }
  catch { return ''; }
}
let privateInvite = demoMode ? '' : takePrivateInviteFromUrl();
let doc = C.empty(crypto.randomUUID(), 'mobile'), pending = new Set();
let accessToken = '', expires = 0, subject = '', email = '', ready = false, busy = false, generation = 0;
let tab = privateInvite ? 'contacts' : 'todos', editing = null, formDirty = false, tokenClient;
const privateUI = PrivateMobile.create({
  root: $('private-panel'), session: () => ({ subject, token: accessToken, expires }), demo: demoMode,
  hasInvite: () => !!privateInvite,
  takeInvite: () => { const value = privateInvite; privateInvite = ''; return value; }
});
setTimeout(() => { privateInvite = ''; }, 5 * 60 * 1000);
window.Capacitor?.Plugins?.App?.addListener('appUrlOpen', event => {
  try {
    const value = new URL(event.url).hash.slice(1), code = new URLSearchParams(value).get('private') || '';
    const parsed = VaultCrypto.parseCode(code); parsed.raw.fill(0);
    privateInvite = code; tab = 'contacts'; render();
  } catch { /* Ignore unrelated or invalid links. */ }
});
const transport = MobileDrive.create(async () => {
  if (!accessToken || Date.now() >= expires) throw new Error('구글 계정 연결을 눌러 다시 로그인하세요. 작성 내용은 이 탭에 남아 있습니다.');
  return accessToken;
});
function message(text) { $('status').textContent = text; }
function element(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function action(label, fn, cls = 'quiet') { const b = element('button', label, cls); b.type = 'button'; b.onclick = fn; return b; }
async function checkAppUpdate(manual = false) {
  if (!nativeUpdate) return;
  const panel = $('update-panel'), status = $('update-status'), check = $('check-update'), install = $('install-update');
  panel.hidden = false; check.disabled = true; install.hidden = true;
  status.textContent = 'GitHub에서 최신 버전을 확인하는 중…';
  try {
    const result = await nativeUpdate.check();
    localStorage.setItem('app-update-last-check', String(Date.now()));
    $('app-version').textContent = '현재 ' + result.currentVersion;
    panel.classList.toggle('available', !!result.hasUpdate);
    if (result.hasUpdate) {
      status.textContent = `새 버전 ${result.latestVersion}을 설치할 수 있습니다.`;
      install.hidden = false;
    } else status.textContent = '최신 버전을 사용하고 있습니다.';
  } catch (e) {
    status.textContent = manual ? (e.message || '업데이트를 확인하지 못했습니다.') : '자동 업데이트 확인은 인터넷 연결 시 다시 시도합니다.';
  } finally { check.disabled = false; }
}
async function installAppUpdate() {
  const button = $('install-update'), status = $('update-status');
  button.disabled = true; status.textContent = '업데이트 APK를 안전하게 확인하며 내려받는 중…';
  try {
    const result = await nativeUpdate.installLatest();
    if (result.permissionRequired) status.textContent = '열린 설정에서 이 앱의 설치 권한을 허용한 뒤, 돌아와 업데이트 설치를 다시 눌러주세요.';
    else status.textContent = 'Android 설치 화면에서 업데이트를 확인해 주세요.';
  } catch (e) { status.textContent = e.message || '업데이트 설치를 시작하지 못했습니다.'; }
  finally { button.disabled = false; }
}
function date() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); }
$('today').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
function changed(kind, rows) {
  C.capture(doc, kind, rows).forEach(k => pending.add(k));
  message('저장 대기 중 · 이 탭을 닫지 마세요.');
  render();
  if (navigator.onLine) synchronize();
}
async function synchronize() {
  if (demoMode) { pending.clear(); message('예시 화면입니다. 변경은 이 탭에서만 보이며 실제 계정에 저장되지 않습니다.'); return; }
  if (busy || !accessToken) return;
  busy = true; $('sync').disabled = true;
  const run = generation;
  try {
    message('PC 자료와 맞추는 중…');
    const files = await transport.readAll();
    if (run !== generation) return;
    const valid = files.map(f => C.validate(f.doc));
    if (!valid.some(d => d.role === 'desktop' && d.snapshot)) throw new Error('PC에서 모바일 동기화를 먼저 켜고, 같은 계정인지 확인하세요.');
    const result = C.merge(doc, valid, pending);
    doc = result.doc; ready = true;
    if (result.conflicts.length) {
      $('conflict').hidden = false;
      $('conflict').textContent = '같은 항목이 다른 기기에서도 수정되어 최신 저장을 적용했습니다: ' + result.conflicts.map(k => titles[k]).join(', ');
    }
    if (pending.size) {
      const uploaded = C.payload(doc);
      await transport.write(uploaded, files);
      if (run !== generation) return;
      for (const kind of C.EDITABLE) for (const [k, e] of Object.entries(uploaded.records[kind] || {})) {
        if (C.rev(doc.records[kind]?.[k]) === C.rev(e)) pending.delete(`${kind}:${k}`);
      }
    }
    message(pending.size ? '새 변경을 저장 대기 중입니다.' : '동기화 완료 · ' + new Date().toLocaleTimeString('ko-KR'));
    render();
  } catch (e) {
    if (run === generation) { message(e.message + (pending.size ? ' · 아직 전송하지 못한 변경이 있습니다.' : '')); render(); }
  } finally {
    busy = false; $('sync').disabled = !accessToken;
  }
}
async function accountFromToken(token) {
  const options = { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) };
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', options);
  if (response.ok) {
    const user = await response.json();
    if (user.sub) return { subject: user.sub, email: user.email || '' };
  }
  const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)', options);
  if (about.ok) {
    const user = (await about.json()).user || {};
    if (user.permissionId) return { subject: 'drive:' + user.permissionId, email: user.emailAddress || '' };
  }
  throw new Error('로그인 계정을 확인하지 못했습니다. Google 계정 권한을 다시 연결하세요.');
}
async function completeLogin(authRun, token, expiresIn) {
  const user = await accountFromToken(token);
  if (authRun !== generation) return;
  if (subject && subject !== user.subject) throw new Error('다른 계정으로 바꾸려면 먼저 로그아웃하세요. 작성 내용이 섞이지 않도록 연결을 중단했습니다.');
  subject = user.subject; email = user.email; accessToken = token; expires = Date.now() + (Number(expiresIn || 3600) - 60) * 1000;
  $('account').textContent = email; $('logout').hidden = false; $('login').textContent = '구글 계정 다시 연결';
  await synchronize();
}
$('login').onclick = async () => {
  const authRun = generation;
  if (nativeGoogle) {
    try {
      message('Android에서 Google Drive 권한을 확인하는 중…');
      const r = await nativeGoogle.authorize();
      await completeLogin(authRun, r.accessToken, r.expiresIn);
    } catch (e) { message(e.message || 'Google 계정 연결을 완료하지 못했습니다.'); }
    return;
  }
  if (!MOBILE_CONFIG.clientId) { message('웹용 구글 로그인 설정이 아직 없습니다. mobile/config.js의 clientId를 설정하세요.'); return; }
  if (!window.google?.accounts?.oauth2) { message('구글 로그인 화면을 불러오지 못했습니다. 인터넷 연결 후 다시 눌러주세요.'); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: MOBILE_CONFIG.clientId, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.appdata',
    include_granted_scopes: false,
    error_callback: () => message('로그인 창이 닫혔거나 차단됐습니다. 다시 연결하세요.'),
    callback: async r => {
      if (r.error) { message('로그인을 완료하지 못했습니다: ' + r.error); return; }
      try {
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, 'https://www.googleapis.com/auth/drive.appdata')) throw new Error('앱 전용 Drive 권한에 동의해야 합니다.');
        await completeLogin(authRun, r.access_token, r.expires_in);
      } catch (e) { message(e.message); }
    }
  });
  tokenClient.requestAccessToken({ prompt: 'select_account' });
};
$('logout').onclick = () => {
  if ((pending.size || formDirty) && !confirm('아직 저장하지 못한 내용이 있습니다. 이 탭의 내용을 지우고 로그아웃할까요?')) return;
  generation++; accessToken = ''; expires = 0; subject = ''; email = ''; ready = false;
  privateUI.lock();
  doc = C.empty(crypto.randomUUID(), 'mobile'); pending.clear(); resetForm();
  $('account').textContent = 'PC에서 쓰는 구글 계정으로 연결하세요.'; $('logout').hidden = true; $('sync').disabled = true;
  $('conflict').hidden = true; $('login').textContent = '구글 계정 연결'; message('이 탭의 자료와 토큰을 지웠습니다.'); render();
  if (nativeGoogle) nativeGoogle.clearToken().catch(() => {});
};
$('sync').onclick = synchronize;
$('check-update').onclick = () => checkAppUpdate(true);
$('install-update').onclick = installAppUpdate;
$('search').oninput = render;
for (const b of $('tabs').children) b.onclick = () => {
  if (formDirty && !confirm('작성 중인 입력을 취소하고 메뉴를 바꿀까요?')) return;
  tab = b.dataset.tab; $('search').value = ''; resetForm(); render();
};
function field(name, label, value = '', type = 'text') {
  const wrap = element('label', label), input = element(type === 'textarea' ? 'textarea' : 'input');
  input.name = name; if (type !== 'textarea') input.type = type;
  input.value = value; input.maxLength = name === 'text' && tab === 'todos' ? 80 : 20000;
  if (['text', 'date', 'subject', 'klass'].includes(name)) input.required = true;
  wrap.append(input); $('fields').append(wrap);
}
function resetForm(row = null) {
  editing = row ? C.key(tab, row) : null; formDirty = false; $('fields').replaceChildren();
  $('editor-title').textContent = row ? '항목 수정' : '새 항목';
  if (tab === 'todos') { field('text', '할 일', row?.text); field('cat', '분류', row?.cat || '업무'); }
  if (tab === 'memos') field('text', '메모 내용', row?.text, 'textarea');
  if (tab === 'progress') {
    field('date', '수업 날짜', row?.date || date(), 'date'); field('subject', '과목', row?.subject || ''); field('klass', '반', row?.klass || '');
    field('body', '진도 내용', row?.body || '', 'textarea'); field('memo', '추가 메모', row?.memo || '');
    if (row) for (const name of ['date', 'subject', 'klass']) $('fields').querySelector(`[name="${name}"]`).readOnly = true;
  }
}
$('editor').oninput = () => { formDirty = true; };
$('cancel').onclick = () => resetForm();
$('editor').onsubmit = e => {
  e.preventDefault(); if (!ready) return;
  const values = Object.fromEntries(new FormData($('editor')));
  for (const k of Object.keys(values)) values[k] = values[k].trim();
  const rows = C.rows(doc, tab), prior = rows.find(r => C.key(tab, r) === editing);
  if (editing && !prior) { message('다른 기기에서 삭제된 항목입니다. 입력 취소 후 새로 작성하세요.'); return; }
  const row = { ...(prior || (tab === 'progress' ? {} : { id: crypto.randomUUID(), ...(tab === 'todos' ? { done: false } : {}) })), ...values };
  if (tab === 'progress' && !row.body && !row.memo) { message('진도 내용이나 메모를 입력하세요.'); return; }
  const k = C.key(tab, row), i = rows.findIndex(r => C.key(tab, r) === k);
  if (!editing && i >= 0 && !confirm('같은 날짜·과목·반의 진도가 있습니다. 덮어쓸까요?')) return;
  if (i >= 0) rows[i] = row; else rows.push(row);
  resetForm(); changed(tab, rows);
};
function render() {
  $('heading').textContent = titles[tab];
  for (const b of $('tabs').children) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  const isPrivate = tab === 'contacts' || tab === 'vehicles';
  document.querySelector('.workspace').hidden = isPrivate;
  if (isPrivate) { privateUI.show(tab); return; }
  privateUI.hide();
  $('search-label').hidden = !ready || tab !== 'roster';
  $('editor').hidden = !ready || !C.EDITABLE.includes(tab);
  $('content').replaceChildren(); $('count').textContent = '';
  $('hint').textContent = demoMode ? '연습용 예시 자료입니다. 자유롭게 둘러보세요.' : C.EDITABLE.includes(tab) ? '변경 내용은 PC가 켜져 있을 때 위젯에도 반영됩니다.' : 'PC에서 마지막으로 보낸 자료 · 조회 전용';
  if (!ready) { $('content').append(element('p', '구글 계정을 연결하면 수첩이 열립니다.', 'empty')); return; }
  if (tab === 'school') { renderSchool(); return; }
  const query = $('search').value.trim().toLowerCase();
  let rows = C.EDITABLE.includes(tab) ? C.rows(doc, tab) : doc.snapshot?.data[tab] || [];
  if (tab === 'todos') rows = C.sortTodos(rows);
  if (tab === 'progress') rows.sort((a, b) => b.date.localeCompare(a.date));
  if (query) rows = rows.filter(r => Object.values(r).join(' ').toLowerCase().includes(query));
  $('count').textContent = rows.length + (tab === 'roster' ? '명' : '개');
  if (!rows.length) $('content').append(element('p', query ? '검색 결과가 없습니다.' : '아직 등록된 항목이 없습니다.', 'empty'));
  for (const row of rows) {
    const item = element('article', null, 'item'), head = element('div', null, 'item-head');
    if (tab === 'todos') {
      const check = element('input'); check.type = 'checkbox'; check.checked = row.done; check.setAttribute('aria-label', row.text + ' 완료');
      check.onchange = () => changed(tab, C.rows(doc, tab).map(r => C.key(tab, r) === C.key(tab, row) ? { ...r, done: check.checked } : r));
      head.append(check);
    }
    let title = row.text, detail = row.cat || '';
    if (tab === 'progress') { title = row.body || '(메모만 기록)'; detail = `${row.date} · ${row.subject} · ${row.klass}\n${row.memo || ''}`; }
    if (tab === 'roster') { title = row.name; detail = `${row.cls} · ${row.no}번`; }
    const text = element('div', title, 'item-text' + (row.done ? ' done' : '')); if (detail) text.append(element('small', detail));
    head.append(text); item.append(head);
    if (C.EDITABLE.includes(tab)) {
      const actions = element('div', null, 'actions');
      actions.append(action('수정', () => { if (formDirty && !confirm('작성 중인 입력을 취소할까요?')) return; resetForm(row); $('editor').scrollIntoView({ block: 'center' }); }), action('삭제', () => {
        if (confirm('이 항목을 삭제할까요?')) changed(tab, C.rows(doc, tab).filter(r => C.key(tab, r) !== C.key(tab, row)));
      }, 'danger')); item.append(actions);
    }
    $('content').append(item);
  }
}
function renderSchool() {
  const data = doc.snapshot?.data || {}, tt = data.timetable, meal = data.meal;
  $('content').append(element('h3', '주간 시간표'));
  if (tt) {
    $('content').append(element('p', `${tt.schoolName} · PC 갱신 ${new Date(tt.at).toLocaleString('ko-KR')}`));
    $('content').append(element('small', '표를 좌우로 밀면 나머지 요일을 볼 수 있어요.'));
    const wrap = element('div', null, 'table-wrap'), table = element('table'), head = element('tr');
    for (const day of ['교시', '월', '화', '수', '목', '금']) head.append(element('th', day)); table.append(head);
    const periods = Math.max(7, ...Object.keys(tt.cells).map(k => Number(k.split('-')[1])));
    for (let p = 1; p <= periods; p++) { const row = element('tr'); row.append(element('th', p)); for (let d = 1; d <= 5; d++) { const c = tt.cells[`${d}-${p}`]; row.append(element('td', c ? `${c.subject}\n${c.klass}${c.changed ? '\n변경' : ''}` : '—')); } table.append(row); }
    wrap.append(table); $('content').append(wrap);
  } else $('content').append(element('p', 'PC에서 시간표를 먼저 불러오세요.', 'empty'));
  $('content').append(element('h3', '급식'));
  if (meal) {
    $('content').append(element('p', `${meal.ymd} 급식 · PC 갱신 ${new Date(meal.at).toLocaleString('ko-KR')}`));
    if (meal.ymd !== date().replaceAll('-', '')) $('content').append(element('p', '오늘 자료가 아닙니다. PC에서 오늘 급식을 갱신하세요.'));
    if (!meal.meals.length) $('content').append(element('p', '해당 날짜에 등록된 급식이 없습니다.'));
    for (const m of meal.meals) { const item = element('article', null, 'item'); item.append(element('h4', m.nm), element('div', m.items.join('\n'), 'item-text')); $('content').append(item); }
  } else $('content').append(element('p', 'PC에서 급식을 먼저 불러오세요.', 'empty'));
}
window.addEventListener('online', synchronize);
window.addEventListener('offline', () => message('오프라인입니다. 작성 내용은 이 탭에서 대기합니다. 창을 닫지 마세요.'));
window.addEventListener('beforeunload', e => { if (pending.size || formDirty) { e.preventDefault(); e.returnValue = ''; } });
setInterval(() => { if (accessToken && navigator.onLine && !document.hidden) synchronize(); }, 30000);
if (demoMode) {
  const example = C.empty('example-pc', 'desktop');
  C.capture(example, 'todos', [
    { id: 'example-t1', text: '내일 국어 수업 활동지 준비', cat: '업무', done: false },
    { id: 'example-t2', text: '독서 모둠별 발표 순서 확인', cat: '업무', done: true }
  ], 1);
  C.capture(example, 'memos', [{ id: 'example-m1', text: '다음 시간 질문\n작품 속 인물의 선택에 동의하나요? 근거를 한 문장으로 적어 봅시다.' }], 1);
  C.capture(example, 'progress', [{ date: date(), subject: '국어', klass: '1-1', body: '인물의 관점 비교하기', memo: '다음 시간 모둠 발표' }], 1);
  example.snapshot = { at: Date.now(), data: {
    roster: [{ cls: '1-1', no: 1, name: '예시 학생 가' }, { cls: '1-1', no: 2, name: '예시 학생 나' }],
    timetable: { at: Date.now(), schoolName: '예시 학교', cells: { '1-1': { subject: '국어', klass: '1-1' }, '2-2': { subject: '국어', klass: '1-2' }, '3-3': { subject: '독서', klass: '2-1' } } },
    meal: { at: Date.now(), ymd: date().replaceAll('-', ''), meals: [{ nm: '예시 중식', items: ['쌀밥', '미역국', '두부조림', '배추김치'], kcal: '' }] }
  } };
  doc = C.merge(doc, [example]).doc; ready = true;
  $('account').textContent = '예시 자료로 둘러보기 · 실제 학생·교직원 정보가 아닙니다.';
  $('account').classList.add('demo-banner'); $('login').hidden = true; $('sync').hidden = true;
  $('demo-link').textContent = '실제 계정 연결 화면으로'; $('demo-link').href = './'; synchronize();
}
resetForm(); render();
if (nativeUpdate) {
  $('update-panel').hidden = false;
  nativeUpdate.current().then(info => { $('app-version').textContent = '현재 ' + info.currentVersion; }).catch(() => {});
  const lastUpdateCheck = Number(localStorage.getItem('app-update-last-check') || 0);
  if (Date.now() - lastUpdateCheck >= 24 * 60 * 60 * 1000) checkAppUpdate(false);
  else $('update-status').textContent = '최근 24시간 안에 업데이트를 확인했습니다.';
}
