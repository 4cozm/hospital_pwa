'use strict';
/* =====================================================================
   치료 일정 일괄 입력
   외부 AI가 사진을 규격 텍스트로 변환 → 붙여넣기/파일 → 엄격 검증 → 미리보기에서 수정 → 가져오기
   형식(한 줄 = 한 행):  호실|시간|성명|이동수단|처방|메모      (전체 규칙: ai-prompt.txt)
   원칙: 검증을 통과하지 못한 행은 절대 가져오지 않고, 애매한 행은 사용자가 직접 선택해야 들어간다.
   ===================================================================== */
const IMP = { MAX_ROWS: 300, MAX_CHARS: 200000, MAX_ITEMS: 6, MAX_MEMO: 100 };
/* 이동수단 표기 → 내부 키 (nk 정규화 후 조회) */
const MOB_ALIAS = {
  '혼자': 'walk', '혼': 'walk',
  '워커': 'walker', 'walker': 'walker',
  '베드': 'bed', '배드': 'bed', 'bed': 'bed', '침대': 'bed',
  '휠체어': 'wheel', '휠': 'wheel', '훨': 'wheel', 'wc': 'wheel', 'w/c': 'wheel',
};
let imp = null;      // 현재 일괄 입력 상태 { text, parsed, ov, mode, ackDate, withRoster }

/* ---------- 도우미 ---------- */
const nk = s => String(s ?? '').toLowerCase().replace(/[\s.\-_·]/g, '');
function lev(a, b) {          // 편집 거리 (필기 오인식 보정용)
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function parseHM(s) {
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})\s*:\s*(\d{2})$/) || t.match(/^(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분?)?$/);
  if (!m) return null;
  const h = +m[1], mi = m[2] === undefined ? 0 : +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, m: mi, str: `${pad(h)}:${pad(mi)}` };
}
/* 병동 물리치료는 09~18시대: 1~8시로 적혀 있으면 오후(+12시간)일 가능성이 커서 확인을 요구 */
function timeWarn(h) {
  if (h >= 1 && h <= 8) return `${h}시는 오전으로 읽혔습니다. 오후(+12시간)가 아닌지 확인하세요`;
  if (h === 0 || h >= 22) return '근무 시간대(대략 06~22시)가 아닙니다';
  return '';
}
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/* ---------- 1. 파싱: 텍스트 → 행 ---------- */
function parseImport(text) {
  const out = { rows: [], meta: {} };
  const src = String(text || '').normalize('NFKC').replace(/^﻿/, '');   // 전각 문자(＋ （ ） ｜ ：)를 반각으로
  if (src.length > IMP.MAX_CHARS) { out.fatal = `텍스트가 너무 깁니다 (최대 ${IMP.MAX_CHARS.toLocaleString()}자)`; return out; }
  src.split(/\r?\n/).forEach((raw, i) => {
    let l = raw.trim(), m;
    if (!l || /^```/.test(l)) return;
    if ((m = l.match(/^#?\s*날짜\s*=\s*(.+)$/))) { out.meta.date = m[1].trim(); return; }
    if ((m = l.match(/^#?\s*행수\s*=\s*(\d+)\s*$/))) { out.meta.count = Number(m[1]); return; }
    if (l.startsWith('#')) return;                                  // 주석(취소된 행 등)
    if (/^[|:\-\s]+$/.test(l)) return;                              // 마크다운 표 구분줄
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|')) l = l.slice(0, -1);
    const f = l.includes('|') ? l.split('|') : l.includes('\t') ? l.split('\t') : null;   // 파이프 또는 탭(스프레드시트 복사)
    const fields = f && f.map(x => x.trim());
    if (fields && fields[0] === '호실') return;                     // 머리글 줄
    out.rows.push({ line: i + 1, raw: raw.trim(), fields });
  });
  if (out.rows.length > IMP.MAX_ROWS) out.fatal = `행이 너무 많습니다 (${out.rows.length}행, 최대 ${IMP.MAX_ROWS}행)`;
  return out;
}

/* ---------- 2. 매칭 ---------- */
function findCats(token) {
  const t = nk(token); if (!t) return [];
  const exact = db.cats.filter(c => nk(c.label) === t || (c.alias || []).some(a => nk(a) === t));
  if (exact.length) return exact;
  return t.length >= 2 ? db.cats.filter(c => nk(c.label).includes(t)) : [];
}
function matchPatient(room, name, forcedPid) {
  if (forcedPid) { const p = patient(forcedPid); return p ? { p, kind: 'manual' } : { p: null, kind: 'none' }; }
  const n = nk(name), inRoom = db.patients.filter(p => p.room === room);
  const exact = inRoom.filter(p => nk(p.name) === n);
  if (exact.length === 1) return { p: exact[0], kind: 'exact' };
  if (exact.length > 1) return { p: null, kind: 'ambiguous' };
  const sim = inRoom.filter(p => lev(nk(p.name), n) <= 1 || (n.length >= 2 && (nk(p.name).includes(n) || n.includes(nk(p.name)))));
  if (sim.length === 1) return { p: sim[0], kind: 'similar' };
  const other = db.patients.filter(p => nk(p.name) === n);
  if (other.length === 1) return { p: other[0], kind: 'otherRoom' };
  return { p: null, kind: 'none' };
}

/* ---------- 3. 행 검증 ---------- */
function evalRow(r, i, ov) {
  const issues = [], add = (lv, msg) => issues.push({ lv, msg });
  const res = { i, line: r.line, raw: r.raw, issues, items: [], learn: [], patient: null, kind: null, entry: null, disp: {} };
  const f = r.fields;
  if (!f) { add('error', '구분자(|)가 없습니다. 형식: 호실|시간|성명|이동수단|처방|메모'); return res; }
  if (f.length < 5 || f.length > 6) { add('error', `열이 ${f.length}개입니다 (5~6개 필요: 호실|시간|성명|이동수단|처방|메모)`); return res; }
  const forcedP = ov.pid ? patient(ov.pid) : null;       // 사용자가 직접 고른 환자 (호실/성명 판독 오류를 우회)
  const unsure = [];
  const clean = (s, label) => { if (s.includes('?')) unsure.push(label); return s.replace(/\?/g, '').trim(); };   // AI가 ? 로 표시한 불확실 항목

  // 호실
  const roomS = clean(f[0], '호실'); let room = null, m;
  if ((m = roomS.match(/^(\d{1,2})\s*호?$/))) room = +m[1]; else if ((m = roomS.match(/^12(\d{2})$/))) room = +m[1];
  if (forcedP) room = forcedP.room;
  else if (!room || !roomOf(room)) { add('error', `호실 "${f[0]}"을(를) 해석할 수 없습니다 (1~19)`); room = null; }
  // 시간
  let hm = parseHM(clean(f[1], '시간'));
  const toPm = h => ({ h: h.h + 12, m: h.m, str: `${pad(h.h + 12)}:${pad(h.m)}` });
  if (!hm) add('error', `시간 "${f[1]}" 형식 오류 (24시간제 HH:MM, 예: 09:30)`);
  else if (ov.pm && hm.h >= 1 && hm.h <= 8) hm = toPm(hm);
  else { const w = timeWarn(hm.h); if (w) { add('warn', w); if (hm.h >= 1 && hm.h <= 8) res.pmAvail = true; } }
  const time = hm?.str || null;
  // 성명
  const name = clean(f[2], '성명').replace(/\s+/g, '');
  const nameOk = /^[가-힣A-Za-z·]{2,20}$/.test(name);
  if (!nameOk && !forcedP) add('error', `성명 "${f[2]}" 형식 오류 (한글/영문 2~20자)`);
  // 이동수단
  const mobRaw = clean(f[3], '이동수단');
  const mob = ov.mob || MOB_ALIAS[nk(mobRaw)];
  if (!mob) add('error', mobRaw ? `이동수단 "${f[3]}"을(를) 알 수 없습니다 (혼자/워커/베드/휠체어)` : '이동수단이 비어 있거나 읽을 수 없습니다 — 선택하세요');
  // 처방
  const rxS = clean(f[4], '처방');
  const tokens = rxS.split('+').map(x => x.trim()).filter(Boolean);
  if (!tokens.length) add('error', '처방이 비어 있습니다');
  if (tokens.length > IMP.MAX_ITEMS) add('error', `처방이 ${tokens.length}개입니다 (최대 ${IMP.MAX_ITEMS}개)`);
  tokens.slice(0, IMP.MAX_ITEMS).forEach((tok, k) => {
    const t = tok.match(/^(.*?)\s*(?:@\s*(\d{1,2}\s*:\s*\d{2})|\(\s*(\d{1,2}\s*:\s*\d{2})\s*\))?$/);
    const label = (t[1] || '').trim(), atRaw = t[2] || t[3];
    const item = { token: label, at: null, cat: null, state: 'none', cands: [] };
    res.items.push(item);
    if (!label) { add('error', `처방 ${k + 1}번째 시술 이름이 비어 있습니다`); return; }
    if (atRaw) {
      let h = parseHM(atRaw.replace(/\s/g, ''));
      if (!h) add('error', `"${label}"의 시간 "${atRaw}" 형식 오류`);
      else {
        if (ov.pm && h.h >= 1 && h.h <= 8) h = toPm(h);
        item.at = h.str;
        const w = timeWarn(h.h);
        if (w) { add('warn', `"${label}" ${w}`); if (h.h >= 1 && h.h <= 8) res.pmAvail = true; }
        else if (time && tmin(h.str) <= tmin(time)) add('warn', `"${label}" 시간 ${h.str}이(가) 시작 시간 ${time}보다 빠르거나 같습니다`);
      }
    }
    const forced = ov.cids?.[k];
    if (forced === '__skip__') item.state = 'skip';
    else if (forced && db.cats.some(c => c.id === forced)) { item.cat = db.cats.find(c => c.id === forced); item.state = 'ok'; res.learn.push({ cid: forced, token: label }); }
    else {
      const c = findCats(label);
      if (c.length === 1) { item.cat = c[0]; item.state = 'ok'; }
      else if (c.length > 1) { item.state = 'ambig'; item.cands = c; add('error', `시술 "${label}"이(가) 여러 시술과 일치합니다 — 선택하세요`); }
      else { item.state = 'none'; add('error', `시술 "${label}"이(가) 등록되어 있지 않습니다 — 선택하거나 설정에서 등록하세요`); }
    }
  });
  const used = res.items.filter(x => x.state === 'ok');
  if (tokens.length && res.items.length && !used.length && !issues.some(x => x.lv === 'error')) add('error', '모든 시술이 제외되었습니다');
  const tids = [...new Set(used.map(x => x.cat.id))];
  if (used.length !== tids.length) add('warn', '같은 시술이 중복되어 하나로 합칩니다');
  // 메모
  const memoS = (f[5] || '').trim();
  if (memoS.length > IMP.MAX_MEMO) add('error', `메모가 너무 깁니다 (${memoS.length}자, 최대 ${IMP.MAX_MEMO}자)`);
  // 환자
  if (forcedP || (room && nameOk)) {
    const pm = matchPatient(room, name, ov.pid);
    res.patient = pm.p; res.kind = pm.kind;
    if (pm.kind === 'similar') add('warn', `이름 유사 매칭: 시트 "${name}" → 등록 "${pm.p.name}" (${roomTag(pm.p)}) 맞는지 확인하세요`);
    else if (pm.kind === 'otherRoom') add('warn', `호실 불일치: 시트 ${room}호 / 등록 ${pm.p.room}호 "${pm.p.name}" 맞는지 확인하세요`);
    else if (!pm.p) add('error', pm.kind === 'ambiguous' ? `${room}호에 같은 이름이 여러 명입니다 — 환자를 선택하세요` : `병실에 등록된 환자가 아닙니다 (${room}호 "${name}") — 환자를 선택하세요`);
  }
  const stillUnsure = [...new Set(unsure)].filter(u => !(ov.mob && u === '이동수단') && !(forcedP && (u === '성명' || u === '호실')) && !(ov.cids && Object.keys(ov.cids).length && u === '처방'));
  if (stillUnsure.length) add('warn', `AI가 불확실로 표시한 항목: ${stillUnsure.join(', ')}`);

  res.disp = { room: f[0], time: f[1], name: f[2], mob: mob ? MOB[mob].label : (f[3] || '(없음)') };
  if (!issues.some(x => x.lv === 'error') && res.patient && time && mob) {
    const sub = res.items.filter(x => x.state === 'ok' && x.at).map(x => `${x.cat.label} ${x.at}`).join(' · ');   // 둘째 시술부터의 시작 시간은 메모로 보존
    res.entry = { pid: res.patient.id, time, tids, mob, memo: [sub, memoS].filter(Boolean).join(' · ') };
  }
  return res;
}
const rowLevel = r => (r.issues.some(x => x.lv === 'error') ? 'error' : r.issues.length ? 'warn' : 'ok');

/* ---------- 4. 전체 검증 ---------- */
function parseMetaDate(s) {
  const t = String(s).trim(); let m;
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return { y: +m[1], mo: +m[2], d: +m[3] };
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/))) return { mo: +m[1], d: +m[2] };
  return null;
}
function evalAll() {
  const p = imp.parsed, notes = [];
  if (p.fatal) notes.push({ lv: 'error', msg: p.fatal });
  const rows = p.fatal ? [] : p.rows.map((r, i) => evalRow(r, i, imp.ov[i] || {}));
  const today = todayStr(), existing = db.entries.filter(e => e.date === today);
  const seen = new Set();
  for (const r of rows) if (r.entry) {          // 중복 검사: 목록 안, 그리고 오늘 이미 등록된 일정
    const key = [r.entry.pid, r.entry.time, [...r.entry.tids].sort().join(',')].join('|');
    if (seen.has(key)) r.issues.push({ lv: 'warn', msg: '목록 안에서 중복된 행입니다' });
    seen.add(key);
    if (imp.mode !== 'replace' && existing.some(e => e.pid === r.entry.pid && e.time === r.entry.time && sameSet(e.tids, r.entry.tids)))
      r.issues.push({ lv: 'warn', msg: '오늘 이미 같은 일정이 등록되어 있습니다' });
  }
  rows.forEach(r => {
    r.level = rowLevel(r);
    const o = imp.ov[r.i] || {};
    r.include = r.level === 'error' ? false : (o.include ?? r.level === 'ok');
  });
  if (p.rows.length === 0 && !p.fatal && imp.text.trim()) notes.push({ lv: 'error', msg: '인식된 데이터 줄이 없습니다. 형식을 확인하세요 (호실|시간|성명|이동수단|처방|메모)' });
  if (p.meta.count !== undefined && !p.fatal && p.meta.count !== p.rows.length)
    notes.push({ lv: 'warn', msg: `AI가 알려준 행수(${p.meta.count})와 읽은 행수(${p.rows.length})가 다릅니다. 빠지거나 늘어난 줄이 없는지 확인하세요` });
  let needAck = false;
  if (p.meta.date) {
    const d = parseMetaDate(p.meta.date), n = new Date();
    if (!d) notes.push({ lv: 'warn', msg: `날짜 "${p.meta.date}" 형식을 해석할 수 없습니다 (예: 11-13)` });
    else if ((d.y && d.y !== n.getFullYear()) || d.mo !== n.getMonth() + 1 || d.d !== n.getDate()) {
      needAck = true;
      notes.push({ lv: 'warn', msg: `목록 날짜(${d.mo}/${d.d})가 오늘(${n.getMonth() + 1}/${n.getDate()})과 다릅니다. 일정은 항상 오늘로 들어갑니다` });
    }
  }
  return { rows, notes, needAck, existing: existing.length };
}

/* ---------- 5. 미리보기 UI ---------- */
function impSelect(attrs, placeholder, opts, selected) {
  return `<select ${attrs}><option value="">${placeholder}</option>${opts.map(o => `<option value="${o.v}" ${o.v === selected ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
}
function rowHtml(r) {
  const ov = imp.ov[r.i] || {};
  const patientOpts = [...db.patients].sort((a, b) => a.room - b.room || a.bed - b.bed).map(p => ({ v: p.id, t: `${roomTag(p)} ${p.name}` }));
  const needPatient = !r.patient || ['similar', 'otherRoom', 'ambiguous'].includes(r.kind);
  const pmBtn = r.pmAvail ? `<button type="button" class="btn sm" data-act="impPm" data-i="${r.i}">오후로 변환 (+12시간)</button>` : (ov.pm ? `<button type="button" class="btn sm" data-act="impPm" data-i="${r.i}">변환 취소</button>` : '');
  const mobBad = r.issues.some(x => x.lv === 'error' && x.msg.startsWith('이동수단'));
  const fixes = [];
  if (pmBtn) fixes.push(pmBtn);
  if (needPatient) fixes.push(impSelect(`data-ov="pid" data-i="${r.i}"`, '환자 선택', patientOpts, ov.pid || ''));
  if (mobBad || ov.mob) fixes.push(impSelect(`data-ov="mob" data-i="${r.i}"`, '이동수단 선택', Object.entries(MOB).map(([k, v]) => ({ v: k, t: v.label })), ov.mob || ''));
  r.items.forEach((it, k) => {
    if (['ambig', 'none'].includes(it.state) || ov.cids?.[k]) {
      const cands = it.state === 'ambig' ? it.cands : db.cats;
      fixes.push(impSelect(`data-ov="cid" data-i="${r.i}" data-k="${k}"`, `"${esc(it.token)}" 시술 선택`, [...cands.map(c => ({ v: c.id, t: c.label })), { v: '__skip__', t: '이 시술 제외' }], ov.cids?.[k] || ''));
    }
  });
  const items = r.items.map(it => `<span class="pill ${it.state === 'skip' ? 'skip' : ''}">${esc(it.cat ? it.cat.label : it.token || '?')}${it.at ? ' ' + it.at : ''}</span>`).join(' ');
  return `<div class="ir ${r.level}">
    <label class="ick"><input type="checkbox" data-ov="include" data-i="${r.i}" ${r.include ? 'checked' : ''} ${r.level === 'error' ? 'disabled' : ''} aria-label="가져오기"></label>
    <div class="ib">
      <div class="il1"><span class="lno">${r.line}행</span><b>${esc(r.disp.room || '')}호 ${esc(r.disp.time || '')} ${esc(r.disp.name || '')}</b> <span class="chip solo">${esc(r.disp.mob || '')}</span></div>
      ${r.items.length ? `<div class="il2">→ ${items}</div>` : ''}
      <div class="il3">${r.patient ? `✓ ${esc(roomTag(r.patient))} ${esc(r.patient.name)}` : '환자 미확정'}</div>
      ${r.issues.map(x => `<div class="iis ${x.lv}">${x.lv === 'error' ? '✕' : '△'} ${esc(x.msg)}</div>`).join('')}
      ${fixes.length ? `<div class="ifix">${fixes.join('')}</div>` : ''}
      <div class="iraw">${esc(r.raw)}</div>
    </div></div>`;
}
function renderImpPreview() {
  if (!imp) return;
  const { rows, notes, needAck, existing } = evalAll();
  imp.view = { rows, needAck };
  const cnt = { ok: 0, warn: 0, error: 0 };
  rows.forEach(r => cnt[r.level]++);
  const take = rows.filter(r => r.include && r.entry).length;
  const box = $('#impPreview'); if (!box) return;
  box.innerHTML = !imp.text.trim() ? '' : `
    <div class="isum"><span>총 <b>${rows.length}</b>행</span><span class="s-ok">바로 가져오기 <b>${cnt.ok}</b></span><span class="s-warn">확인 필요 <b>${cnt.warn}</b></span><span class="s-err">오류 <b>${cnt.error}</b></span></div>
    ${notes.map(n => `<div class="iis ${n.lv} gnote">${n.lv === 'error' ? '✕' : '△'} ${esc(n.msg)}</div>`).join('')}
    ${needAck ? `<label class="chk"><input type="checkbox" data-ov="ackDate" ${imp.ackDate ? 'checked' : ''}> 날짜가 달라도 오늘 일정으로 가져오기</label>` : ''}
    ${existing ? `<div class="f"><label>오늘 치료 일정이 이미 ${existing}건 있습니다</label>
      <select data-ov="mode"><option value="add" ${imp.mode === 'add' ? 'selected' : ''}>추가 (같은 일정은 건너뜀)</option><option value="replace" ${imp.mode === 'replace' ? 'selected' : ''}>오늘 치료 일정을 모두 지우고 교체</option></select></div>` : ''}
    ${rows.some(r => r.pmAvail) ? `<button type="button" class="btn" data-act="impAllPm">1~8시로 읽힌 시간 ${rows.filter(r => r.pmAvail).length}건을 모두 오후로 변환 (+12시간)</button>` : ''}
    ${cnt.warn ? `<button type="button" class="btn" data-act="impAllWarn">확인 필요 ${cnt.warn}건도 모두 선택</button>` : ''}
    ${cnt.error ? '<p class="note">오류 행은 가져오지 않습니다. 아래 선택으로 고치거나, 원본 텍스트를 수정하세요.</p>' : ''}
    <div class="irows">${rows.map(rowHtml).join('')}</div>`;
  const go = $('#impGo');
  if (go) { go.disabled = !take || (needAck && !imp.ackDate); go.textContent = take ? `선택한 ${take}건 가져오기` : '가져올 항목 없음'; }
}

/* ---------- 6. 열기 / 입력 / 이벤트 ---------- */
function openBulk() {
  if (!db.patients.length) return noPatientSheet();
  if (!db.cats.length) return noCatSheet();
  imp = { text: '', parsed: { rows: [], meta: {} }, ov: {}, mode: 'add', ackDate: false };
  openSheet(`<h2>치료 일정 일괄 입력</h2>
    <p class="note">사진을 AI로 변환한 텍스트를 붙여넣으면 형식·환자·시술을 검증한 뒤 한 번에 넣습니다. 날짜는 항상 오늘입니다.</p>
    <details class="howto"><summary>AI 변환 규칙 · 형식 보기</summary>
      <p class="note">아래 규칙을 AI(ChatGPT, Claude 등)에 미리 넣어 두고 일정표 사진을 보내면, 이 앱이 받는 형식으로 변환해 줍니다.</p>
      <label class="chk"><input type="checkbox" id="impRoster"> 등록 환자 명단 포함 (필기 보정용, 환자 이름이 AI 서비스로 전송됩니다)</label>
      <div class="row"><button type="button" class="btn pri" data-act="impCopy">AI 규칙 복사</button><button type="button" class="btn" data-act="impSample">내 데이터로 샘플 넣기</button></div>
      <textarea id="impPrompt" rows="6" readonly hidden></textarea>
      <pre class="fmt">호실|시간|성명|이동수단|처방|메모
1|09:00|홍길동|휠체어|도수+PT@09:40|
6|09:40|이영희|베드|PT|bed 확인

이동수단: 혼자 / 워커 / 베드 / 휠체어
처방: 시술+시술@HH:MM (둘째부터 시작 시간)
?  : 불확실한 칸 뒤에 붙임 → 확인 필요로 표시
#  : 주석(취소된 행 등, 무시됨)</pre>
    </details>
    <div class="f"><label>변환된 텍스트</label>
      <textarea id="impText" rows="7" placeholder="여기에 붙여넣기&#10;예) 1|09:00|홍길동|휠체어|도수+PT@09:40|" autocomplete="off"></textarea></div>
    <div class="row"><button type="button" class="btn" data-act="impFile">파일 불러오기</button><input type="file" id="impFile" accept=".txt,.csv,.tsv,text/plain" hidden></div>
    <div id="impPreview"></div>
    <div class="acts"><button type="button" data-act="close">닫기</button><button type="button" class="pri" id="impGo" data-act="impGo" disabled>가져오기</button></div>`);
}
function setImpText(text) {
  imp.text = text; imp.parsed = parseImport(text); imp.ov = {}; imp.ackDate = false;
  renderImpPreview();
}
let impTimer = null;
document.addEventListener('input', ev => {
  if (!imp || ev.target.id !== 'impText') return;
  clearTimeout(impTimer); impTimer = setTimeout(() => setImpText(ev.target.value), 350);
});
document.addEventListener('change', ev => {
  if (!imp) return; const t = ev.target;
  if (t.id === 'impFile') {
    const f = t.files[0]; if (!f) return;
    if (f.size > IMP.MAX_CHARS * 3) return toast('파일이 너무 큽니다', '텍스트 파일(.txt)만 가능합니다');
    f.text().then(txt => { $('#impText').value = txt; setImpText(txt); }).catch(() => toast('파일을 읽지 못했습니다', ''));
    t.value = ''; return;
  }
  const k = t.dataset?.ov; if (!k) return;
  const i = Number(t.dataset.i), o = (imp.ov[i] = imp.ov[i] || {});
  if (k === 'include') o.include = t.checked;
  else if (k === 'pid') o.pid = t.value || undefined;
  else if (k === 'mob') o.mob = t.value || undefined;
  else if (k === 'cid') { o.cids = o.cids || {}; o.cids[Number(t.dataset.k)] = t.value || undefined; }
  else if (k === 'mode') imp.mode = t.value;
  else if (k === 'ackDate') imp.ackDate = t.checked;
  renderImpPreview();
});
sheet.addEventListener('close', () => { imp = null; });

function impPm(i) { const o = (imp.ov[i] = imp.ov[i] || {}); o.pm = !o.pm; renderImpPreview(); }
function impAllPm() { imp.view.rows.filter(r => r.pmAvail).forEach(r => { (imp.ov[r.i] = imp.ov[r.i] || {}).pm = true; }); renderImpPreview(); }
function impAllWarn() {
  if (!imp?.view) return;
  imp.view.rows.filter(r => r.level === 'warn').forEach(r => { (imp.ov[r.i] = imp.ov[r.i] || {}).include = true; });
  renderImpPreview();
}
/* AI 규칙 복사: ai-prompt.txt 에 등록 시술(별칭 포함)과 선택 시 환자 명단을 채워 넣는다 */
async function impCopyPrompt() {
  let tpl;
  try { const r = await fetch('ai-prompt.txt', { cache: 'no-cache' }); if (!r.ok) throw 0; tpl = await r.text(); }
  catch (e) { return toast('규칙 파일을 불러오지 못했습니다', '인터넷 연결을 확인하세요'); }
  const siksul = db.cats.map(c => `- ${c.label}${(c.alias || []).length ? ` (별칭: ${c.alias.join(', ')})` : ''}`).join('\n') || '- (등록된 시술 없음: 사진에 적힌 이름 그대로)';
  const roster = $('#impRoster')?.checked
    ? '\n■ 등록된 환자 명단 (필기 판독 보정용. 명단에 없는 이름은 보정하지 말고 ? 를 붙이세요)\n' + [...db.patients].sort((a, b) => a.room - b.room || a.bed - b.bed).map(p => `- ${p.room}호 ${p.name}`).join('\n') + '\n'
    : '';
  const text = tpl.replace('{{SIKSUL}}', siksul).replace('{{ROSTER}}', roster);
  const box = $('#impPrompt'); if (box) { box.value = text; box.hidden = false; }
  try { await navigator.clipboard.writeText(text); toast('AI 규칙을 복사했습니다', 'AI 대화에 붙여넣고 사진을 보내세요'); }
  catch (e) { if (box) { box.focus(); box.select(); } toast('아래 칸을 길게 눌러 전체 복사하세요', ''); }
}
/* 내 환자·시술로 샘플 줄을 만들어 검증 흐름을 바로 확인 */
function impSample() {
  const ps = [...db.patients].sort((a, b) => a.room - b.room || a.bed - b.bed).slice(0, 3), cs = db.cats;
  const mobs = ['휠체어', '혼자', '베드'];
  const lines = ps.map((p, i) => `${p.room}|${pad(9 + Math.floor(i / 2))}:${i % 2 ? '40' : '00'}|${p.name}|${mobs[i % 3]}|${cs[0].label}${cs[1] ? '+' + cs[1].label + '@' + pad(10 + Math.floor(i / 2)) + ':20' : ''}|`);
  const text = `${lines.join('\n')}\n행수=${lines.length}`;
  $('#impText').value = text; setImpText(text);
}

/* ---------- 7. 가져오기 ---------- */
function impGo() {
  if (!imp) return;
  const { rows, needAck } = evalAll();                      // 가져오기 직전에 한 번 더 검증
  const take = rows.filter(r => r.include && r.entry);
  if (!take.length) return toast('가져올 항목이 없습니다', '');
  if (needAck && !imp.ackDate) return toast('날짜 확인이 필요합니다', '"날짜가 달라도 오늘 일정으로 가져오기"를 체크하세요');
  const today = todayStr();
  if (imp.mode === 'replace') {
    const old = db.entries.filter(e => e.date === today);
    if (!confirm(`오늘 치료 일정 ${old.length}건을 모두 삭제하고 ${take.length}건으로 교체합니다. 계속할까요?`)) return;
    const ids = new Set(old.map(e => e.id));
    db.entries = db.entries.filter(e => !ids.has(e.id));
    for (const k of Object.keys(db.status)) if (ids.has(k.split('|')[0])) delete db.status[k];
    for (const k of Object.keys(db.stamps)) if (ids.has(k.split('|')[0])) delete db.stamps[k];
  }
  for (const r of take) db.entries.push({ id: uid(), date: today, ...r.entry });
  for (const r of take) for (const l of r.learn) {            // 직접 고른 시술은 별칭으로 기억 → 다음부터 자동 인식
    const c = db.cats.find(x => x.id === l.cid);
    if (c && nk(c.label) !== nk(l.token) && !(c.alias || []).some(a => nk(a) === nk(l.token))) c.alias = [...(c.alias || []), l.token];
  }
  const n = take.length, skipped = rows.length - n;
  save(); closeSheet(); tab = 'tx'; render(); scrollTo(0, 0);
  toast(`${n}건을 가져왔습니다`, skipped ? `${skipped}건은 제외됨 (오류/미선택)` : '');
}
