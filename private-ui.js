(function () {
  'use strict';
  const V = window.VaultCrypto, D = window.VaultDevice;
  const nativeQr = window.NativeBridge?.plugin('NativeQr');
  function create({ root, session, demo, hasInvite = () => false, takeInvite = () => '' }) {
    let kind = 'contacts', data = null, generation = 0, idle, busy = false, activeId = '';
    const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
    const button = (text, fn) => { const b = el('button', text); b.type = 'button'; b.onclick = () => run(fn); return b; };
    const title = () => kind === 'contacts' ? '교직원 비상연락망' : '차량현황';
    const transport = MobileDrive.create(async () => {
      const s = session(); if (!s.subject || !s.token || s.expires <= Date.now()) throw new Error('먼저 구글 계정을 연결하거나 다시 연결하세요.');
      return s.token;
    }, fetch, 'desktop-widget-private-v1-');
    let status;
    function note(t) { if (status) status.textContent = t; }
    async function run(fn) {
      if (busy) return; busy = true;
      root.querySelectorAll('button').forEach(b => b.disabled = true);
      try { await fn(); }
      catch (e) { note(e.name === 'NotAllowedError' ? '기기 인증이 취소됐거나 지원되지 않습니다. 등록·복구 코드로 이번 탭에서만 열 수도 있습니다.' : e.message); }
      finally { busy = false; root.querySelectorAll('button').forEach(b => b.disabled = false); }
    }
    function resetIdle() { clearTimeout(idle); if (data && !demo && !nativeQr) idle = setTimeout(lock, 5 * 60 * 1000); }
    function lock() { generation++; data = null; clearTimeout(idle); root.replaceChildren(); if (!root.hidden) draw(); }
    function maybeInvite() {
      if (!hasInvite()) return;
      if (!session().subject) { note('연결 QR을 받았습니다. 위의 [구글 계정 연결]을 먼저 누르세요.'); return; }
      if (busy) return;
      const code = takeInvite();
      if (code) run(() => openCode(code, true));
    }
    function show(next) {
      const redraw = kind !== next || root.hidden || !root.childNodes.length;
      kind = next; root.hidden = false; if (redraw) draw(); maybeInvite();
      if (nativeQr && !data && !demo && session().subject && !hasInvite() && !busy) run(openRegistered);
    }
    function hide() { root.hidden = true; if (!nativeQr) lock(); }
    function guard(run, subject) { if (generation !== run || session().subject !== subject) throw new Error('화면이 잠겼거나 계정이 바뀌어 작업을 중단했습니다.'); }
    async function find(id, subject, run) {
      const files = await transport.readAll(); guard(run, subject);
      const match = files.filter(f => f.doc.device === id && f.doc.kind === 'private-directory');
      if (match.length !== 1) throw new Error('해당 보관함을 찾지 못했거나 중복됐습니다. PC의 Drive 보내기와 구글 계정을 확인하세요.');
      return match[0].doc;
    }
    async function openCode(text, persist) {
      const run = generation, s = session();
      if (!s.subject) throw new Error('먼저 구글 계정을 연결하세요.');
      const parsed = V.parseCode(text);
      try {
        note('암호화된 자료를 확인하고 있습니다…');
        const cloud = await find(parsed.id, s.subject, run);
        if (cloud.keyId !== parsed.keyId) throw new Error('PC에서 연결을 초기화했습니다. 새 등록·복구 코드를 사용하세요.');
        const plain = await V.decrypt(await V.key(parsed.raw), cloud); guard(run, s.subject);
        if (persist) {
          note('기기 인증 창을 완료하세요. 처음 등록할 때는 두 번 나타날 수 있습니다.');
          const record = await D.enroll(s.subject, parsed, () => generation === run && session().subject === s.subject);
          guard(run, s.subject); await D.checkpoint(s.subject, record, cloud.seq);
        }
        guard(run, s.subject); activeId = parsed.id; data = plain; draw(); resetIdle();
      } finally { parsed.raw.fill(0); }
    }
    async function scanCode() {
      if (!session().subject) throw new Error('먼저 위의 구글 계정 연결을 누르세요.');
      if (!nativeQr) throw new Error('이 기능은 Android 앱에서 사용할 수 있습니다.');
      note('PC 설정 화면의 연결 QR을 카메라에 보여 주세요.');
      const result = await nativeQr.scan();
      const url = new URL(result.url);
      const params = new URLSearchParams(url.hash.slice(1));
      const code = params.get('private');
      if (!code) throw new Error('바탕화면 위젯의 휴대폰 연결 QR이 아닙니다.');
      await openCode(code, true);
    }
    async function openRegistered() {
      const run = generation, s = session();
      if (!s.subject) throw new Error('먼저 구글 계정을 연결하세요.');
      note('등록된 보관함을 확인하고 있습니다…');
      const files = await transport.readAll(); guard(run, s.subject);
      const records = [];
      for (const f of files) {
        if (f.doc.kind !== 'private-directory') continue;
        const record = await D.load(s.subject, f.doc.device); guard(run, s.subject);
        if (record) records.push({ record, cloud: f.doc });
      }
      if (!records.length) throw new Error('이 브라우저에 등록된 보관함이 없습니다. PC의 등록·복구 코드로 먼저 등록하세요.');
      if (records.length !== 1) throw new Error('등록된 보관함이 여러 개입니다. 원하는 PC의 코드로 이번 탭에서 여세요.');
      const { record, cloud } = records[0];
      if (cloud.keyId !== record.keyId) { await D.forget(s.subject, record.id); throw new Error('PC에서 연결을 초기화했습니다. 새 코드로 다시 등록하세요.'); }
      if (cloud.seq < record.lastSeq) throw new Error('이전에 확인한 자료보다 오래된 파일입니다. PC에서 최신 자료를 다시 보내세요.');
      note('기기의 지문·얼굴 또는 잠금 인증을 완료하세요.');
      const key = await D.unlock(s.subject, record); guard(run, s.subject);
      const plain = await V.decrypt(key, cloud); guard(run, s.subject);
      await D.checkpoint(s.subject, record, cloud.seq); guard(run, s.subject);
      activeId = record.id; data = plain; draw(); resetIdle();
    }
    function draw() {
      root.replaceChildren(); root.append(el('h2', title()));
      status = el('p', '개인정보는 별도 암호화 보관함에서 조회합니다.'); status.setAttribute('role', 'status'); root.append(status);
      if (demo) {
        data = {
          contacts: { columns: ['성명', '부서', '연락처'], rows: [['예시 교사 가', '예시 교무부', '010-0000-0000']] },
          vehicles: { columns: ['성명', '차량번호', '차종'], rows: [['예시 교사 가', '00가 0000', '예시 차량']] }
        }; note('모두 가상 자료입니다. 실제 기기 인증·Drive 연결은 예시 화면에서 실행하지 않습니다.');
      }
      if (data) {
        const table = data[kind];
        if (!demo) {
          const actions = el('div'); actions.className = 'actions';
          actions.append(button('지금 닫기', async () => lock()), button('최신 자료 다시 불러오기', async () => { lock(); await openRegistered(); }), button(nativeQr ? '이 앱 등록 해제' : '이 브라우저 등록 해제', async () => {
            const account = session().subject;
            await D.forget(account, activeId); lock(); note('이 브라우저의 등록 정보를 지웠습니다.');
          })); root.append(actions);
          note(nativeQr ? '최초 등록 인증이 완료된 이 휴대폰에서는 추가 인증 없이 조회합니다.' : '5분 동안 조작이 없거나 다른 화면으로 전환하면 잠깁니다.');
        }
        if (!table) { root.append(el('p', 'PC에서 이 자료를 먼저 등록하고 Drive로 보내세요.')); return; }
        if (table.updatedAt) root.append(el('small', 'PC 등록 시각 · ' + new Date(table.updatedAt).toLocaleString('ko-KR')));
        const label = el('label', '이름·연락처·차량번호 검색'), query = el('input'); query.type = 'search'; label.append(query); root.append(label);
        const results = el('div'); root.append(results);
        const renderRows = () => {
          results.replaceChildren(); const norm = x => x.toLowerCase().replace(/[\s-]/g, '');
          const rows = table.rows.filter(r => norm(r.join(' ')).includes(norm(query.value)));
          results.append(el('p', `${rows.length}건`));
          for (const row of rows) {
            const card = el('article'); card.className = 'item';
            row.forEach((value, i) => { const line = el('div'); line.append(el('small', table.columns[i]), el('span', value)); card.append(line); }); results.append(card);
          }
        };
        query.oninput = renderRows; renderRows(); return;
      }
      root.append(button(nativeQr ? '등록된 자료 열기' : '기기 인증으로 열기', openRegistered));
      if (nativeQr) root.append(button('PC 연결 QR 읽기', scanCode));
      if (hasInvite()) root.append(el('p', 'PC에서 받은 연결 QR이 준비되었습니다. Google 계정을 연결하면 긴 코드 입력 없이 이 기기를 등록합니다.'));
      const setup = el('details'), summary = el('summary', '처음 등록하거나 기기 인증을 사용할 수 없나요?'); setup.append(summary);
      setup.append(el('p', 'PC의 개인정보 보관함에서 등록·복구 코드를 확인해 아래에 입력하세요. 코드를 아는 사람은 자료를 열 수 있으므로 다른 사람에게 보내지 마세요.'));
      const label = el('label', 'PC 등록·복구 코드'), code = el('input'); code.type = 'password'; code.autocomplete = 'off'; code.spellcheck = false; label.append(code); setup.append(label);
      const actions = el('div'); actions.className = 'actions';
      actions.append(button('이 기기에 등록', async () => { const value = code.value; code.value = ''; await openCode(value, true); }),
        button('이번 탭에서만 열기', async () => { const value = code.value; code.value = ''; await openCode(value, false); }));
      setup.append(actions); root.append(setup);
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden && !nativeQr) lock(); });
    window.addEventListener('pagehide', () => { if (!nativeQr) lock(); });
    root.addEventListener('pointerdown', resetIdle); root.addEventListener('input', resetIdle);
    return { show, hide, lock };
  }
  window.PrivateMobile = { create };
})();
