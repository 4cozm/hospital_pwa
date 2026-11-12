'use strict';
/* ================= 설정값 (병동 구조) =================
   1201~1219 → "1호~19호"로 호출. 앞 12는 생략.
   1~11호 일반(4인), 12~18호 특실(1인), 19호 특실이지만 2인실. */
const ROOMS = Array.from({ length: 19 }, (_, i) => {
  const no = i + 1;
  return { no, code: 1200 + no, vip: no >= 12, cap: no <= 11 ? 4 : no === 19 ? 2 : 1 };
});
const roomOf = no => ROOMS.find(r => r.no === Number(no));
const MOB = {
  walk:  { label: '혼자',   escort: false },
  wheel: { label: '휠체어', escort: true },
  bed:   { label: '베드',   escort: true },
};
const KEY = 'ward-schedule-v1';

/* ================= 저장소 (localStorage 전용) ================= */
function uid() { return Math.random().toString(36).slice(2, 10); }
let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.patients && d.entries) return migrate({ status: {}, stamps: {}, settings: { lead: 10 }, cats: [], surgeries: [], ...d });
  } catch (e) {}
  return { patients: [], entries: [], status: {}, stamps: {}, settings: { lead: 10, firstUse: Date.now() }, cats: [], surgeries: [] };
}
/* v1 → v2: 이동방식은 환자가 아니라 일정(entry)의 속성, 치료는 카테고리(cats) 참조 */
function migrate(d) {
  d.cats = d.cats || [];
  d.surgeries = d.surgeries || [];
  d.stamps = d.stamps || {};                       // 이송/복귀 시각 기록 { 'id|날짜': {out, back, ext} }
  d.surgeries.forEach(x => { x.dur = x.dur || 60; });   // 예상 수술 소요시간(분)
  d.settings = d.settings || { lead: 10 };
  d.settings.firstUse = d.settings.firstUse || Date.now();   // 백업 안내 기준일
  const P = id => d.patients.find(p => p.id === id);
  for (const e of d.entries) {
    if (!e.mob) e.mob = P(e.pid)?.mob || 'walk';
    if (!e.tid && !Array.isArray(e.tids)) {
      const label = (e.tx || '').trim() || '미지정';
      let c = d.cats.find(c => c.label === label);
      if (!c) d.cats.push(c = { id: uid(), label, memo: '' });
      e.tid = c.id;
    }
    delete e.tx;
    if (!Array.isArray(e.tids)) e.tids = e.tid ? [e.tid] : [];   // v4: 일정 하나에 시술 여러 개
    delete e.tid;
    delete e.daily;                       // v5: 매일 반복 기능 제거
  }
  d.patients.forEach(p => delete p.mob);
  for (const p of d.patients) {           // v3: 병실 내 자리 번호(bed). 없으면 빈 번호부터 순서대로
    if (p.bed) continue;
    const used = new Set(d.patients.filter(x => x.room === p.room && x.bed).map(x => x.bed));
    let b = 1; while (used.has(b)) b++;
    p.bed = b;
  }
  return d;
}
function save() {
  try { db.savedAt = Date.now(); localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('저장 실패', '브라우저 저장공간이 가득 찼거나 차단되었습니다'); }
}

/* ================= 저장 상태 / 백업 ================= */
const DAY = 864e5, BACKUP_EVERY_DAYS = 7;
const fmtTs = ts => { if (!ts) return '없음'; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function storageInfo() {
  let chars = 0; try { chars = (localStorage.getItem(KEY) || '').length; } catch (e) {}
  const kb = chars / 1024;
  return { kb, text: kb < 1024 ? `${kb.toFixed(1)}KB` : `${(kb / 1024).toFixed(2)}MB`, pct: (chars / 5e6 * 100) };   // localStorage 한도 약 5M자 (브라우저별 상이)
}
/* 백업 안내: 환자가 있고, 마지막 백업(없으면 최초 사용일)에서 7일 이상 지났고, 오늘 "나중에"를 안 눌렀을 때 */
function backupDue() {
  if (!db.patients.length || db.settings.snooze === todayStr()) return null;
  const base = db.settings.lastBackup || db.settings.firstUse || Date.now();
  const days = Math.floor((Date.now() - base) / DAY);
  return days >= BACKUP_EVERY_DAYS ? { days, never: !db.settings.lastBackup } : null;
}
function backupBanner() {
  const due = backupDue(); if (!due) return '';
  return `<div class="bk"><span>💾 ${due.never ? `백업한 적이 없습니다 (사용 ${due.days}일째)` : `마지막 백업 ${due.days}일 전`}</span>
    <button data-act="export">지금 백업</button><button class="alt" data-act="snooze">나중에</button></div>`;
}
async function persistState() {
  if (!navigator.storage?.persisted) return 'unsupported';
  try { return (await navigator.storage.persisted()) ? 'granted' : 'default'; } catch (e) { return 'unsupported'; }
}

/* ================= 유틸 ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const tmin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = s => {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
};
const patient = id => db.patients.find(p => p.id === id);
const patientAt = (room, bed, exceptId) => db.patients.find(p => p.room === room && p.bed === bed && p.id !== exceptId);
const bedLabel = p => (roomOf(p.room)?.cap > 1 && p.bed ? `${p.bed}번` : '');
const mobOf = e => (MOB[e.mob] ? e.mob : 'walk');
const isSx = e => e.kind === 'sx';
const catsOf = e => isSx(e) ? [] : (e.tids || []).map(id => db.cats.find(c => c.id === id)).filter(Boolean);
const txLabel = e => isSx(e) ? `수술 ${e.name}` : (catsOf(e).map(c => c.label).join(' + ') || '(치료 미지정)');
const memoOf = e => isSx(e) ? e.memo : catsOf(e).filter(c => c.memo).map(c => catsOf(e).length > 1 ? `${c.label}: ${c.memo}` : c.memo).join('\n');
/* 시술마다 필 하나. 눌러서 그 시술의 장소 메모 확인 */
const txPill = (e, tag = 'button') => {
  const attr = (extra = '') => tag === 'button' ? `data-act="pill" data-id="${e.id}" ${extra}` : '';
  const one = (label, memo, cls, extra) => `<${tag} class="pill ${cls}" ${attr(extra)}>${esc(label)}${memo ? ' <i>ⓘ</i>' : ''}</${tag}>`;
  if (isSx(e)) return `<span class="pills">${one(txLabel(e), e.memo, 'sx', '')}</span>`;
  const cs = catsOf(e);
  return `<span class="pills">${cs.map(c => one(c.label, c.memo, '', `data-cid="${c.id}"`)).join('') || '<span class="note">(시술 미지정)</span>'}</span>`;
};
const findItem = id => db.entries.find(e => e.id === id) || db.surgeries.find(e => e.id === id);

let tab = 'today';
let date = todayStr();

/* 해당 날짜의 치료 일정 */
function entriesOn(d) {
  return db.entries
    .filter(e => patient(e.pid) && e.date === d)
    .sort((a, b) => tmin(a.time) - tmin(b.time) || roomNo(a) - roomNo(b));
}
/* 오늘 화면용: 치료 + 수술을 시간순으로 합친 목록 */
function itemsOn(d) {
  return [...entriesOn(d), ...surgeriesOn(d)].sort((a, b) => tmin(a.time) - tmin(b.time) || roomNo(a) - roomNo(b));
}
const surgeriesOn = d => db.surgeries.filter(s => patient(s.pid) && s.date === d).sort((a, b) => tmin(a.time) - tmin(b.time));
const roomNo = e => patient(e.pid)?.room ?? 99;
const fmtDur = n => n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ' ' + n % 60 + '분' : ''}` : `${n}분`;
const hhmm = ts => { const x = new Date(ts); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
/* 이송→복귀 2단계 대상: 휠체어/베드 환자, 그리고 수술은 이동 방식과 상관없이 항상 */
const twoStep = e => isSx(e) || MOB[mobOf(e)].escort;
const stKey = (e, d) => `${e.id}|${d}`;
const stampOf = (e, d) => db.stamps[stKey(e, d)];
function setStamp(e, d, patch) { const k = stKey(e, d); if (patch) db.stamps[k] = { ...(db.stamps[k] || {}), ...patch }; else delete db.stamps[k]; }
/* 하루가 지난 기록은 자연스럽게 사라지도록 삭제 (환자/병실 배정은 유지) */
function purgeOld() {
  const t = todayStr(), size = () => db.entries.length + db.surgeries.length + Object.keys(db.status).length + Object.keys(db.stamps).length;
  const before = size();
  db.entries = db.entries.filter(e => e.date >= t);
  db.surgeries = db.surgeries.filter(x => x.date >= t);
  for (const k of Object.keys(db.status)) if (k.split('|')[1] < t) delete db.status[k];
  for (const k of Object.keys(db.stamps)) if (k.split('|')[1] < t) delete db.stamps[k];
  if (size() === before) return false;
  if (date < t) date = t;
  save(); return true;
}
const stOf = (e, d) => db.status[stKey(e, d)] || 0;   // 0 대기, 1 모시러 감/이동 중, 2 완료
function setSt(e, d, v) { if (v) db.status[stKey(e, d)] = v; else delete db.status[stKey(e, d)]; save(); }

/* ================= 렌더 ================= */
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').classList.toggle('hide', tab === 'settings' || tab === 'today');
  $('#fab').setAttribute('aria-label', { tx: '치료 일정 추가', sx: '수술 일정 추가', rooms: '환자 추가' }[tab] || '추가');
  if (tab !== 'rooms') roomQuery = '';
  ({ today: renderToday, tx: renderTx, sx: renderSx, rooms: renderRooms, settings: renderSettings })[tab]();
}

/* 이동 방식: 색 대신 '모시러 가야 하나'만 구분 (모시러=진한 칩, 혼자=외곽선 칩) */
function mobBadge(k) { return `<span class="chip ${MOB[k].escort ? 'escort' : 'solo'}">${MOB[k].label}</span>`; }
/* 호수-자리번호 요약 표기: 5호 1번 → 5-1 (1인실은 호수만) */
const roomTag = p => (roomOf(p.room)?.cap > 1 && p.bed ? `${p.room}-${p.bed}` : String(p.room));
function roomBox(p) {
  return `<div class="room ${roomOf(p.room)?.vip ? 'vip' : ''}"><b>${roomTag(p)}</b></div>`;
}

function renderToday() {
  const isToday = date === todayStr();
  const list = itemsOn(date);
  const total = list.length;
  const done = list.filter(e => stOf(e, date) === 2).length;
  const esc_ = list.filter(e => twoStep(e) && stOf(e, date) !== 2).length;
  const solo = list.filter(e => !twoStep(e) && stOf(e, date) !== 2).length;

  $('#top').innerHTML = `
    <div class="hrow">
      <h1>${isToday ? '오늘 ' : ''}${fmtDate(date)}</h1>
      <div class="datenav">
        <button data-act="day" data-n="-1" aria-label="전날" ${date <= todayStr() ? 'disabled' : ''}>‹</button>
        <button class="dl" data-act="day" data-n="0">오늘</button>
        <button data-act="day" data-n="1" aria-label="다음날">›</button>
      </div>
    </div>
    <div class="sum">
      <span>전체 <b>${total}</b></span><span>완료 <b>${done}</b></span>
      <span>모시러 <b>${esc_}</b></span><span>혼자 확인 <b>${solo}</b></span>
    </div>`;

  let html = backupBanner();
  const now = nowMin();
  const pending = list.filter(e => stOf(e, date) !== 2);
  const next = isToday ? (pending.find(e => stOf(e, date) === 1) || pending.find(e => tmin(e.time) + 20 >= now) || pending[0]) : null;

  if (isToday && total) {
    if (!next) html += `<div class="hero empty">오늘 일정 모두 완료 🎉</div>`;
    else html += hero(next);
  }

  if (!total) {
    html += `<div class="empty-msg">이 날짜에 일정이 없습니다.<br>
      <button class="btn pri" data-tab="tx">치료일정에서 입력하기</button>
      ${db.patients.length ? '' : '<br><button class="btn" data-act="demo">예시 데이터 불러오기</button>'}</div>`;
  } else {
    const times = [...new Set(list.map(e => e.time))];
    for (const t of times) {
      const g = list.filter(e => e.time === t);
      const open = g.filter(e => stOf(e, date) !== 2);
      const late = isToday && open.length && tmin(t) < now;
      const cur = isToday && open.length && tmin(t) >= now && tmin(t) - now <= 30;
      const ec = g.filter(e => twoStep(e)).length;
      html += `<section class="grp"><div class="gh ${late ? 'late' : cur ? 'now' : ''}">
        <span class="gt">${t}</span>
        <span class="gc">${g.length}명${ec ? ` · 모시러 ${ec}` : ''}${late ? ' · 지연' : ''}</span></div>
        ${g.map(e => card(e, late)).join('')}</section>`;
    }
  }
  $('#view').innerHTML = html;
}

function hero(e) {
  const p = patient(e.pid), st = stOf(e, date), m = MOB[mobOf(e)];
  const diff = tmin(e.time) - nowMin();
  const dur = n => n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ' ' + n % 60 + '분' : ''}` : `${n}분`;
  const when = diff > 0 ? `${dur(diff)} 후` : diff === 0 ? '지금' : `${dur(-diff)} 지남`;
  return `<div class="hero">
    <div class="lab">${isSx(e) ? '수술 · ' : ''}${st === 1 ? (isSx(e) ? '진행 중' : '이송 중') : '다음 일정'} · ${when}</div>
    <div class="big"><span class="t">${e.time}</span><span class="rm">${roomTag(p)}</span><span class="nm">${esc(p.name)}</span></div>
    <div class="meta">${esc(txLabel(e))} · ${m.label}${p.note ? ' · ' + esc(p.note) : ''}</div>
    ${memoOf(e) ? `<div class="meta" style="font-size:18px;font-weight:700">→ ${esc(memoOf(e).replace(/\s*\n\s*/g, ' · '))}</div>` : ''}
    ${sxLine(e)}
    <div class="mini"><button class="go" data-act="adv" data-id="${e.id}">${advLabel(e, st)}</button></div>
  </div>`;
}
function advLabel(e, st) {
  if (isSx(e)) return st === 0 ? '🏥 이송 완료 (수술 시작)' : '↩ 복귀 완료';
  if (twoStep(e)) return st === 0 ? '🚶 이송 완료' : '↩ 복귀 완료';
  return '✅ 잘 갔는지 확인';
}
/* 수술: 이송 완료 시점부터 예상 소요시간을 세어 예상 종료 시각 표시 (지연되면 지연 시간, +30분 연장 가능) */
function sxLine(e) {
  if (!isSx(e)) return '';
  const st = stOf(e, date), s = stampOf(e, date);
  if (st === 0) return `<div class="sxt">예상 소요 <b>${fmtDur(e.dur || 60)}</b> · 이송 완료를 누르면 시작</div>`;
  if (!s) return '';
  if (st === 1) {
    const total = (e.dur || 60) + (s.ext || 0), end = s.out + total * 60000, left = Math.ceil((end - Date.now()) / 60000);
    return `<div class="sxt"><div>수술 시작 ${hhmm(s.out)} · 소요 ${fmtDur(total)}</div>
      <div class="end">예상 종료 <b>${hhmm(end)}</b> <span class="${left < 0 ? 'over' : ''}">${left >= 0 ? `${fmtDur(left)} 남음` : `⚠ ${fmtDur(-left)} 지연`}</span></div>
      <button class="ext" data-act="sxext" data-id="${e.id}">+30분 연장</button></div>`;
  }
  return `<div class="sxt">이송 ${hhmm(s.out)}${s.back ? ` → 복귀 ${hhmm(s.back)}` : ''}</div>`;
}

/* 목적지: 어디로 가는지(시술/수술 + 장소 메모)를 누르지 않아도 바로 보이게 */
function destHtml(e) {
  const items = isSx(e) ? [{ label: e.name, memo: e.memo, cid: '' }] : catsOf(e).map(c => ({ label: c.label, memo: c.memo, cid: c.id }));
  if (!items.length) return '<div class="dest"><span class="note">(시술 미지정)</span></div>';
  return `<div class="dest">${items.map(i => `<button class="d" data-act="pill" data-id="${e.id}" data-cid="${i.cid}"><span class="ar">→</span><span class="dn">${esc(i.label)}</span>${i.memo ? `<span class="dm">${esc(i.memo.replace(/\s*\n\s*/g, ' · '))}</span>` : ''}</button>`).join('')}</div>`;
}
/* 진행 표시: 이송 → 복귀 (혼자 이동 환자는 확인 한 단계) */
function progHtml(e, st) {
  const steps = twoStep(e) ? ['이송', '복귀'] : ['확인'];
  return `<div class="prog">${steps.map((t, i) => `<span class="${st > i ? 'on' : st === i ? 'cur' : ''}">${st > i ? '✓ ' : ''}${t}</span>`).join('')}</div>`;
}

function card(e, late) {
  const p = patient(e.pid), st = stOf(e, date), mk = mobOf(e);
  const btns = st === 2
    ? `<button class="alt" data-act="undo" data-id="${e.id}">되돌리기</button>`
    : `<button data-act="adv" data-id="${e.id}">${advLabel(e, st)}</button>${st === 1 ? `<button class="alt" data-act="undo" data-id="${e.id}">취소</button>` : ''}`;
  const note = [p.note, isSx(e) ? '' : e.memo].filter(Boolean).join(' · ');
  return `<article class="card ${twoStep(e) ? 'esc-card' : ''} ${st === 2 ? 'done' : ''} ${late ? 'late' : ''}">
    ${roomBox(p)}
    <div class="cbody">
      <div class="who"><span class="n">${esc(p.name)}</span>${mobBadge(mk)}${isSx(e) ? '<span class="chip sx">수술</span>' : ''}</div>
      ${destHtml(e)}
      ${note ? `<div class="note">${esc(note)}</div>` : ''}
      ${progHtml(e, st)}
    </div>
    ${sxLine(e)}
    <div class="act">${btns}</div>
  </article>`;
}

let roomQuery = '';
/* 병실 검색: 입력할 때 화면을 다시 그리지 않고(포커스 유지) 결과 목록·카드 강조만 갱신 */
function applyRoomFilter() {
  const q = roomQuery.trim(), res = $('#rres'); if (!res) return;
  const hits = q ? db.patients.filter(p => patientMatch(p, q)).sort((a, b) => a.room - b.room || a.bed - b.bed) : [];
  const ids = new Set(hits.map(p => p.id));
  res.innerHTML = !q ? '' : hits.length
    ? `<div class="sec">검색 결과 ${hits.length}명 · 누르면 병실이 열립니다</div>` + hits.slice(0, 10).map(p =>
        `<button class="pl" data-act="room" data-no="${p.room}">${roomBox(p)}<div><div class="who"><span class="n">${esc(p.name)}</span></div>${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}</div></button>`).join('')
    : '<div class="empty-msg" style="padding:14px">일치하는 환자가 없습니다</div>';
  document.querySelectorAll('#view .slot[data-pid]').forEach(el => el.classList.toggle('hit', ids.has(el.dataset.pid)));
  document.querySelectorAll('#view .rc').forEach(el => el.classList.toggle('dim', !!q && !el.querySelector('.slot.hit')));
}
function renderRooms() {
  $('#top').innerHTML = `<div class="hrow"><h1>병실 현황</h1></div>
    <div class="sum"><span>입원 <b>${db.patients.length}</b>명</span></div>
    <input id="rsearch" class="sbox" type="search" enterkeyhint="search" placeholder="이름 또는 호수 검색 (예: 김영, ㄱㅇㅅ, 5)" autocomplete="off" value="${esc(roomQuery)}">`;
  const card_ = r => {
    const slots = Array.from({ length: r.cap }, (_, i) => {
      const pa = patientAt(r.no, i + 1), bn = r.cap > 1 ? `<span class="bn">${i + 1}</span>` : '';
      return pa ? `<div class="slot" data-pid="${pa.id}">${bn}${esc(pa.name)}</div>` : `<div class="slot empty">${bn}빈 자리</div>`;
    }).join('');
    return `<button class="rc ${r.vip ? 'vip' : ''}" data-act="room" data-no="${r.no}">
      <div class="rh"><b>${r.no}호</b><span>${r.code} · ${r.vip ? '특실' : '일반'} ${r.cap}인</span></div>${slots}</button>`;
  };
  $('#view').innerHTML = `<div id="rres"></div><div class="sec">일반실 (1~11호)</div><div class="rgrid">${ROOMS.filter(r => !r.vip).map(card_).join('')}</div>
    <div class="sec">특실 (12~19호)</div><div class="rgrid">${ROOMS.filter(r => r.vip).map(card_).join('')}</div>`;
  const box = $('#rsearch');
  box.oninput = () => { roomQuery = box.value; applyRoomFilter(); };
  box.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); box.blur(); } };   // 키보드 닫기
  applyRoomFilter();
}

function dateHdr(title, sum) {
  $('#top').innerHTML = `<div class="hrow"><h1>${title} · ${fmtDate(date)}</h1>
    <div class="datenav"><button data-act="day" data-n="-1" aria-label="전날">‹</button>
    <button class="dl" data-act="day" data-n="0">오늘</button>
    <button data-act="day" data-n="1" aria-label="다음날">›</button></div></div>
    <div class="sum">${sum}</div>`;
}
/* 입력/편집용 목록 행 (체크 버튼 없음, 누르면 수정) */
function editRows(list, act) {
  let html = '';
  for (const t of [...new Set(list.map(e => e.time))]) {
    html += `<section class="grp"><div class="gh"><span class="gt">${t}</span><span class="gc">${list.filter(e => e.time === t).length}명</span></div>
      ${list.filter(e => e.time === t).map(e => {
        const p = patient(e.pid);
        return `<button class="pl row-edit" data-act="${act}" data-id="${e.id}">${roomBox(p)}
          <div><div class="who"><span class="n">${esc(p.name)}</span>${mobBadge(mobOf(e))}</div>
          <div>${txPill(e, 'span')}${isSx(e) ? ` <span class="note">· 예상 소요 ${fmtDur(e.dur || 60)}</span>` : ''}</div>
          ${e.memo ? `<div class="note">${esc(e.memo)}</div>` : ''}</div></button>`;
      }).join('')}</section>`;
  }
  return html;
}
function renderTx() {
  const today = todayStr(), list = entriesOn(today);
  $('#top').innerHTML = `<div class="hrow"><h1>치료일정 · 오늘 ${fmtDate(today)}</h1></div>
    <div class="sum"><span>${list.length}건</span><span>＋ 버튼으로 추가 · 항목을 눌러 수정</span></div>`;
  $('#view').innerHTML = list.length ? editRows(list, 'editEntry')
    : `<div class="empty-msg">오늘 치료 일정이 없습니다.<br><button class="btn pri" data-act="addEntry">＋ 치료 일정 추가</button></div>`;
}
function renderSx() {
  const list = surgeriesOn(date);
  const up = db.surgeries.filter(s => patient(s.pid) && s.date > date).length;
  dateHdr('수술일정', `<span>${list.length}건</span>${up ? `<span>이후 예정 ${up}건</span>` : ''}`);
  $('#view').innerHTML = list.length ? editRows(list, 'editEntry')
    : `<div class="empty-msg">이 날짜의 수술 일정이 없습니다.<br><button class="btn pri" data-act="addSx">＋ 수술 일정 추가</button></div>`;
}

function renderSettings() {
  $('#top').innerHTML = `<div class="hrow"><h1>설정</h1></div>`;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const si = storageInfo();
  $('#view').innerHTML = `
  <div class="set"><h3>저장 상태</h3>
    <p>이 기기의 브라우저에만 저장됩니다. 서버로 전송되지 않습니다.</p>
    <p>마지막 저장 <b>${fmtTs(db.savedAt)}</b> · 사용 <b>${si.text}</b> <span class="note">(한도 약 5MB 중 ${si.pct < 0.1 ? '0.1% 미만' : si.pct.toFixed(1) + '%'})</span></p>
    <p>환자 <b>${db.patients.length}</b> · 치료 일정 <b>${db.entries.length}</b> · 수술 <b>${db.surgeries.length}</b> · 시술 <b>${db.cats.length}</b></p>
    <p>영구 저장 <b id="persistState">확인 중…</b></p>
    <button class="btn" data-act="persist">영구 저장 요청</button></div>
  <div class="set"><h3>치료 시술</h3>
    <p>치료일정에서는 여기에 등록한 시술만 선택할 수 있습니다. 시술 이름과 장소 메모를 미리 써두세요. 누르면 수정·삭제합니다.</p>
    ${db.cats.map(c => `<button class="pl" data-act="editCat" data-id="${c.id}"><div><div class="who"><span class="pill">${esc(c.label)}</span></div>
      <div class="note" style="margin-top:4px">${c.memo ? esc(c.memo) : '장소 메모 없음'}</div></div></button>`).join('') || '<p class="note">아직 등록된 시술이 없습니다.</p>'}
    <button class="btn pri" data-act="addCat">＋ 시술 추가</button></div>
  <div class="set"><h3>알림</h3>
    <div class="f"><label>치료 몇 분 전에 알릴까요</label>
      <select id="lead">${[0, 5, 10, 15, 20, 30].map(n => `<option value="${n}" ${db.settings.lead === n ? 'selected' : ''}>${n ? n + '분 전' : '정각'}</option>`).join('')}</select></div>
    <p>상태: <b>${{ granted: '허용됨', denied: '차단됨 (브라우저 설정에서 변경)', default: '아직 요청 안 함', unsupported: '이 브라우저는 미지원' }[perm]}</b></p>
    <button class="btn pri" data-act="perm">알림 권한 요청</button>
    <p>⚠️ 서버가 없어서 <b>앱이 열려 있을 때만</b> 알림이 울립니다. 앱이 꺼져 있어도 울리는 알림이 필요하면 아래 <b>캘린더로 내보내기</b>를 쓰세요.</p></div>
  <div class="set"><h3>폰 캘린더로 내보내기 (서버 없이 확실한 알람)</h3>
    <p>${fmtDate(date)} 일정을 .ics 파일로 받아 폰 캘린더에 넣으면 OS가 알람을 울려줍니다.</p>
    <button class="btn" data-act="ics">${fmtDate(date)} 일정 내보내기</button></div>
  <div class="set"><h3>백업</h3>
    <p>브라우저 데이터 삭제·기기 변경 시 사라지니 ${BACKUP_EVERY_DAYS}일에 한 번은 백업하세요. 마지막 백업: <b>${db.settings.lastBackup ? fmtTs(db.settings.lastBackup) : '없음'}</b></p>
    <button class="btn" data-act="export">JSON 내보내기</button>
    <button class="btn" data-act="import">JSON 불러오기</button>
    <input type="file" id="file" accept="application/json" hidden></div>
  <div class="set"><h3>데이터</h3>
    <button class="btn" data-act="demo">예시 데이터 불러오기</button>
    <button class="btn danger" data-act="wipe">전체 삭제</button></div>
  <p class="note" style="text-align:center">환자 정보는 외부로 전송되지 않습니다 · 모든 데이터는 로컬 저장</p>`;
  persistState().then(v => { const el = $('#persistState'); if (el) el.textContent = { granted: '허용됨 (브라우저가 임의로 지우지 않음)', default: '아직 허용되지 않음 (홈 화면에 추가하면 허용될 수 있음)', unsupported: '이 브라우저는 미지원' }[v]; });
  $('#lead').onchange = e => { db.settings.lead = Number(e.target.value); save(); };
  $('#file').onchange = importFile;
}

/* ================= 시트(모달) ================= */
const sheet = $('#sheet');
function openSheet(html) { sheet.innerHTML = `<div class="sh">${html}</div>`; if (!sheet.open) sheet.showModal(); }
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function roomOptions(sel) {
  const opts = ROOMS.map(r => {
    const n = db.patients.filter(p => p.room === r.no).length;
    const full = n >= r.cap && r.no !== sel;
    return `<option value="${r.no}" ${sel === r.no ? 'selected' : ''} ${full ? 'disabled' : ''}>${r.no}호 ${n}/${r.cap}${r.vip ? ' 특실' : ''}${full ? ' (만실)' : ''}</option>`;
  }).join('');
  return (sel ? '' : '<option value="">병실을 선택하세요</option>') + opts;
}
/* 자리 번호: 사용 중인 자리는 누가 쓰는지 보여주되 선택 불가 */
function bedOptions(room, selfId, sel) {
  const r = roomOf(room);
  if (!r) return '<select name="bed" disabled><option>병실을 먼저 선택하세요</option></select>';
  if (r.cap === 1) return '<input type="hidden" name="bed" value="1"><div class="note">1인실</div>';
  const opts = Array.from({ length: r.cap }, (_, i) => {
    const b = i + 1, o = patientAt(room, b, selfId);
    return `<option value="${b}" ${sel === b ? 'selected' : ''} ${o ? 'disabled' : ''}>${b}번${o ? ` — ${esc(o.name)} (사용 중)` : ''}</option>`;
  }).join('');
  return `<select name="bed" required>${sel ? '' : '<option value="">자리 번호를 선택하세요</option>'}${opts}</select>`;
}

function patientForm(p, presetRoom, presetBed) {
  const isNew = !p;
  p = p || { name: '', room: presetRoom || null, bed: presetBed || null, note: '' };
  openSheet(`<h2>${isNew ? '환자 추가' : '환자 수정'}</h2>
  <form id="pf">
    <div class="f"><label>이름</label><input name="name" value="${esc(p.name)}" required autocomplete="off"></div>
    <div class="row">
      <div class="f"><label>병실</label><select name="room" required>${roomOptions(p.room)}</select></div>
      <div class="f"><label>자리 번호</label><div id="bedwrap">${bedOptions(p.room, p.id, p.bed)}</div></div>
    </div>
    <div class="f"><label>메모 (선택)</label><input name="note" value="${esc(p.note)}" placeholder="예: 왼쪽 어깨 주의, 보호자 동행" autocomplete="off"></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delPatient">퇴원</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  $('#pf [name=room]').onchange = ev => {    // 병실을 바꾸면 자리 번호를 다시 고르게 함
    const room = Number(ev.target.value) || null;
    $('#bedwrap').innerHTML = bedOptions(room, p.id, room === p.room ? p.bed : null);
  };
  $('#pf').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const room = Number(f.get('room')), bed = Number(f.get('bed'));
    if (!roomOf(room) || !bed) return toast('병실과 자리 번호를 선택하세요', '');
    const other = patientAt(room, bed, p.id);
    if (other) return toast(`${room}호 ${bed}번은 ${other.name} 님이 사용 중입니다`, '');
    const data = { name: f.get('name').trim(), room, bed, note: f.get('note').trim() };
    if (isNew) db.patients.push({ id: uid(), ...data }); else Object.assign(p, data);
    save(); closeSheet(); render();
  };
  sheet.dataset.pid = p.id || '';
}

function noPatientSheet() {
  openSheet(`<h2>등록된 환자가 없습니다</h2>
    <p class="note">일정은 병실에 등록된 환자에게만 추가할 수 있습니다. 병실 탭에서 환자를 먼저 배정하세요.</p>
    <div class="acts"><button data-act="close">닫기</button><button class="pri" data-act="goRooms">병실로 이동</button></div>`);
}
/* 환자 선택: 호수 → 그 병실의 환자 (기본값 없음, 목록이 길어지지 않게 2단계) */
function patientOptions(room, sel) {
  if (!room) return '<select name="pid" disabled><option>호수 먼저</option></select>';
  const ps = db.patients.filter(p => p.room === room).sort((a, b) => a.bed - b.bed);
  const auto = ps.length === 1 && roomOf(room).cap === 1;     // 1인실은 환자가 한 명뿐이라 자동 선택
  return `<select name="pid" required>${sel || auto ? '' : '<option value="">환자 선택</option>'}${ps.map(p =>
    `<option value="${p.id}" ${p.id === sel || auto ? 'selected' : ''}>${bedLabel(p) ? bedLabel(p) + ' ' : ''}${esc(p.name)}</option>`).join('')}</select>`;
}
/* 이름 검색: 부분 일치 또는 초성 (예: '김영', 'ㄱㅇㅅ') */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const choOf = str => [...str].map(ch => { const c = ch.charCodeAt(0) - 0xAC00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch; }).join('');
/* 검색: 숫자만(또는 '5호', '1205') 입력하면 그 호수 환자 전원, 그 외는 이름 일부/초성 */
const patientMatch = (p, q) => {
  q = q.trim().toLowerCase(); if (!q) return false;
  if (/^\d+호?$/.test(q)) { const n = q.replace('호', ''); return n === String(p.room) || n === String(1200 + p.room); }
  return p.name.toLowerCase().includes(q) || choOf(p.name).includes(q);
};
function pickerHtml(selPid) {
  const room = patient(selPid)?.room || null;
  const rooms = ROOMS.filter(r => db.patients.some(p => p.room === r.no));
  return `<div class="f"><label>환자 검색 (이름 · 호수)</label>
    <input id="psearch" type="search" enterkeyhint="search" placeholder="이름 또는 호수 (예: 김영, ㄱㅇㅅ, 5)" autocomplete="off">
    <div id="presults" class="presults"></div></div>
  <div class="row">
    <div class="f"><label>호수</label><select name="room" required>${room ? '' : '<option value="">호수 선택</option>'}${rooms.map(r =>
      `<option value="${r.no}" ${r.no === room ? 'selected' : ''}>${r.no}호 (${db.patients.filter(p => p.room === r.no).length}명)</option>`).join('')}</select></div>
    <div class="f"><label>환자</label><div id="ppwrap">${patientOptions(room, selPid)}</div></div></div>`;
}
function bindPicker(onPick) {
  const bindPid = () => { const s = $('#sheet [name=pid]'); if (s) s.onchange = () => s.value && onPick?.(s.value); };
  // --- 이름 검색: 결과를 눌러 선택 (입력만으로 자동 선택하지 않음)
  const box = $('#psearch'), res = $('#presults');
  const choose = pid => {
    const p = patient(pid); if (!p) return;
    $('#sheet [name=room]').value = String(p.room);
    $('#ppwrap').innerHTML = patientOptions(p.room, pid); bindPid();
    box.value = ''; res.innerHTML = ''; onPick?.(pid);
  };
  const find = () => db.patients.filter(p => patientMatch(p, box.value)).sort((a, b) => a.room - b.room || a.bed - b.bed);
  box.oninput = () => {
    const hits = find();
    res.innerHTML = !box.value.trim() ? '' : hits.length
      ? hits.slice(0, 8).map(p => `<button type="button" class="pr" data-pid="${p.id}">${p.room}호 ${bedLabel(p) ? bedLabel(p) + ' ' : ''}${esc(p.name)}</button>`).join('')
      : '<span class="note">일치하는 환자가 없습니다</span>';
  };
  box.onkeydown = ev => {            // Enter로 폼이 저장되지 않게. 결과가 한 명뿐이면 그 환자 선택
    if (ev.key !== 'Enter') return;
    ev.preventDefault(); const hits = find(); if (hits.length === 1) choose(hits[0].id);
  };
  res.onclick = ev => { const b = ev.target.closest('.pr'); if (b) choose(b.dataset.pid); };
  $('#sheet [name=room]').onchange = ev => {
    $('#ppwrap').innerHTML = patientOptions(Number(ev.target.value) || null, null);
    bindPid();
    const s = $('#sheet [name=pid]'); if (s && s.value) onPick?.(s.value);   // 1인실 자동 선택 시
  };
  bindPid();
}
function noCatSheet() {
  openSheet(`<h2>등록된 치료 시술이 없습니다</h2>
    <p class="note">치료 일정은 설정에 등록한 시술만 선택할 수 있습니다. 설정에서 시술 이름과 장소 메모를 먼저 등록하세요.</p>
    <div class="acts"><button data-act="close">닫기</button><button class="pri" data-act="goSettings">설정으로 이동</button></div>`);
}
function lastMob(pid) {
  const l = db.entries.filter(x => x.pid === pid).pop();
  return l ? mobOf(l) : 'walk';
}
let txSel = [];
function renderTxPicker() {
  const chips = $('#txchips'), pick = $('#txpick'); if (!chips || !pick) return;
  chips.innerHTML = txSel.map(id => `<span class="pill">${esc(db.cats.find(c => c.id === id).label)} <button type="button" class="x" data-act="rmTx" data-cid="${id}" aria-label="제거">×</button></span>`).join('');
  const rest = db.cats.filter(c => !txSel.includes(c.id));
  pick.innerHTML = `<option value="">${rest.length ? (txSel.length ? '＋ 시술 더 추가' : '시술을 선택하세요') : '모든 시술이 선택됨'}</option>` + rest.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  pick.disabled = !rest.length;
}
function entryForm(e, presetPid) {
  if (!db.patients.length) return noPatientSheet();
  if (!db.cats.length) return noCatSheet();
  const isNew = !e;
  e = e || { pid: presetPid || '', time: currentTime(), tids: [], mob: presetPid ? lastMob(presetPid) : 'walk', memo: '' };
  openSheet(`<h2>${isNew ? `치료 일정 추가 · 오늘 ${fmtDate(todayStr())}` : '치료 일정 수정'}</h2>
  <form id="ef">
    ${pickerHtml(e.pid)}
    <div class="f"><label>치료 시술 (같은 시간에 여러 개 선택 가능)</label>
      <div id="txchips" class="pills"></div>
      <select id="txpick"></select></div>
    <div class="f"><label>이동 방식</label><div class="seg">
      ${Object.entries(MOB).map(([k, v]) => `<label><input type="radio" name="mob" value="${k}" ${mobOf(e) === k ? 'checked' : ''}><span class="${k}">${v.label}</span></label>`).join('')}
    </div></div>
    <div class="f"><label>시간</label><input type="time" name="time" value="${e.time}" required></div>
    <div class="f"><label>일정 메모 (선택)</label><input name="memo" value="${esc(e.memo)}" autocomplete="off"></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delEntry">삭제</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  sheet.dataset.eid = e.id || '';
  txSel = (e.tids || []).filter(id => db.cats.some(c => c.id === id));
  renderTxPicker();
  $('#txpick').onchange = ev => { if (ev.target.value) { txSel.push(ev.target.value); renderTxPicker(); } };
  bindPicker(isNew ? pid => {   // 환자를 고르면 그 환자의 지난 이동 방식을 기본값으로
    const r = $(`#ef [name=mob][value=${lastMob(pid)}]`); if (r) r.checked = true;
  } : null);
  $('#ef').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (!patient(f.get('pid'))) return toast('병실에 등록된 환자를 선택하세요', '');
    if (!txSel.length) return toast('치료 시술을 하나 이상 선택하세요', '');
    const data = { pid: f.get('pid'), time: f.get('time'), tids: [...txSel], mob: f.get('mob'), memo: f.get('memo').trim() };
    if (isNew) db.entries.push({ id: uid(), date: todayStr(), ...data }); else Object.assign(e, data);   // 날짜는 항상 오늘
    save(); closeSheet(); render();
  };
}
function catForm(c) {
  const isNew = !c;
  c = c || { label: '', memo: '' };
  openSheet(`<h2>${isNew ? '치료 시술 추가' : '치료 시술 수정'}</h2>
  <form id="cf">
    <div class="f"><label>시술 이름 (일정에 필로 표시)</label><input name="label" value="${esc(c.label)}" required autocomplete="off" placeholder="예: 3층 PT"></div>
    <div class="f"><label>장소 메모 (필을 누르면 표시)</label><textarea name="memo" rows="3" placeholder="예: 3층 쭉 들어가서 좌측">${esc(c.memo)}</textarea></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delCat">삭제</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  sheet.dataset.cid = c.id || '';
  $('#cf').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target), data = { label: f.get('label').trim(), memo: f.get('memo').trim() };
    if (isNew) db.cats.push({ id: uid(), ...data }); else Object.assign(c, data);
    save(); closeSheet(); render();
  };
}
function sxForm(e, presetPid) {
  if (!db.patients.length) return noPatientSheet();
  const isNew = !e;
  e = e || { kind: 'sx', pid: presetPid || '', date, time: '08:00', name: '', dur: 60, mob: 'bed', memo: '' };
  openSheet(`<h2>${isNew ? '수술 일정 추가' : '수술 일정 수정'}</h2>
  <form id="sf">
    ${pickerHtml(e.pid)}
    <div class="row">
      <div class="f"><label>날짜</label><input type="date" name="date" value="${e.date}" required></div>
      <div class="f"><label>시간</label><input type="time" name="time" value="${e.time}" required></div>
    </div>
    <div class="f"><label>수술명</label><input name="name" value="${esc(e.name)}" required autocomplete="off" placeholder="예: 무릎 인공관절"></div>
    <div class="f"><label>예상 수술 소요시간 (이송 완료 시점부터 계산)</label>
      <select name="dur" required>${[30, 60, 90, 120, 150, 180, 210, 240, 300, 360, 480].map(n => `<option value="${n}" ${(e.dur || 60) === n ? 'selected' : ''}>${fmtDur(n)}</option>`).join('')}</select></div>
    <div class="f"><label>이동 방식</label><div class="seg">
      ${Object.entries(MOB).map(([k, v]) => `<label><input type="radio" name="mob" value="${k}" ${mobOf(e) === k ? 'checked' : ''}><span class="${k}">${v.label}</span></label>`).join('')}
    </div></div>
    <div class="f"><label>안내 메모 (필을 누르면 표시)</label><textarea name="memo" rows="3" placeholder="예: 금식, 수술실 3번, 보호자 동행">${esc(e.memo)}</textarea></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delSx">삭제</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  sheet.dataset.eid = e.id || '';
  bindPicker(isNew ? pid => { const r = $(`#sf [name=mob][value=${lastMob(pid)}]`); if (r) r.checked = true; } : null);
  $('#sf').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (!patient(f.get('pid'))) return toast('병실에 등록된 환자를 선택하세요', '');
    const data = { kind: 'sx', pid: f.get('pid'), date: f.get('date'), time: f.get('time'), name: f.get('name').trim(), dur: Number(f.get('dur')) || 60, mob: f.get('mob'), memo: f.get('memo').trim() };
    if (isNew) db.surgeries.push({ id: uid(), ...data }); else Object.assign(e, data);
    date = data.date; save(); closeSheet(); render();
  };
}
function pillSheet(e, cid) {
  const c = isSx(e) ? null : db.cats.find(x => x.id === cid) || catsOf(e)[0];
  const title = isSx(e) ? txLabel(e) : (c?.label || '(시술 없음)'), memo = isSx(e) ? e.memo : c?.memo;
  const others = isSx(e) ? [] : catsOf(e).filter(x => x !== c);
  openSheet(`<h2>${esc(title)}</h2>
    ${memo ? `<p style="font-size:20px;line-height:1.5;margin:0 0 8px;white-space:pre-wrap">${esc(memo)}</p>` : `<p class="note">장소 메모가 없습니다. ${isSx(e) ? '수술일정에서' : '설정의 치료 시술에서'} 추가할 수 있습니다.</p>`}
    ${others.length ? `<p class="note">같은 일정의 다른 시술: ${others.map(x => esc(x.label)).join(', ')}</p>` : ''}
    ${!isSx(e) && e.memo ? `<p class="note">일정 메모: ${esc(e.memo)}</p>` : ''}
    <div class="acts"><button data-act="close">닫기</button>${c ? `<button data-act="editCat" data-id="${c.id}">장소 메모 수정</button>` : ''}</div>`);
}
function currentTime() { // 입력 기본값: 지금 시각 (HH:MM, 24시간)
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function roomSheet(no) {
  const r = roomOf(no);
  const rows = Array.from({ length: r.cap }, (_, i) => {
    const b = i + 1, p = patientAt(no, b), bn = r.cap > 1 ? `<span class="bn">${b}</span>` : '';
    return p
      ? `<button class="pl" data-act="editPatient" data-id="${p.id}">${bn}<div><div class="who"><span class="n">${esc(p.name)}</span></div>${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}</div></button>`
      : `<button class="pl emptyslot" data-act="addPatientTo" data-no="${no}" data-bed="${b}">${bn}<span class="note">＋ ${r.cap > 1 ? b + '번 자리에 ' : ''}환자 배정</span></button>`;
  }).join('');
  openSheet(`<h2>${no}호 <small style="font-weight:500;color:var(--sub)">${r.code} · ${r.vip ? '특실' : '일반'} ${r.cap}인</small></h2>
    ${rows}<div class="acts"><button data-act="close">닫기</button></div>`);
}

/* ================= 액션 ================= */
document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; render(); scrollTo(0, 0); return; }
  const id = t.dataset.id, act = t.dataset.act;
  const entry = () => findItem(id);
  switch (act) {
    case 'day': date = Number(t.dataset.n) === 0 ? todayStr() : addDays(date, Number(t.dataset.n)); render(); break;
    case 'addEntry': entryForm(); break;
    case 'addPatient': patientForm(); break;
    case 'addPatientTo': patientForm(null, Number(t.dataset.no), Number(t.dataset.bed) || 1); break;
    case 'editPatient': patientForm(patient(id)); break;
    case 'editEntry': { const x = entry(); isSx(x) ? sxForm(x) : entryForm(x); break; }
    case 'addSx': sxForm(); break;
    case 'delSx': {
      const eid = sheet.dataset.eid;
      if (confirm('이 수술 일정을 삭제할까요?')) { db.surgeries = db.surgeries.filter(x => x.id !== eid); save(); closeSheet(); render(); }
      break;
    }
    case 'room': roomSheet(Number(t.dataset.no)); break;
    case 'close': closeSheet(); break;
    case 'goSettings': closeSheet(); tab = 'settings'; render(); scrollTo(0, 0); break;
    case 'goRooms': closeSheet(); tab = 'rooms'; render(); scrollTo(0, 0); break;
    case 'pill': pillSheet(entry(), t.dataset.cid); break;
    case 'rmTx': txSel = txSel.filter(x => x !== t.dataset.cid); renderTxPicker(); break;
    case 'addCat': catForm(); break;
    case 'editCat': catForm(db.cats.find(c => c.id === id)); break;
    case 'delCat': {
      const cid = sheet.dataset.cid, hit = db.entries.filter(e => e.tids.includes(cid)), gone = hit.filter(e => e.tids.length === 1).length;
      const msg = hit.length ? `이 시술이 들어간 일정 ${hit.length}개에서 제거됩니다.${gone ? ` (이 시술뿐인 ${gone}개는 일정이 삭제됩니다)` : ''} 삭제할까요?` : '이 시술을 삭제할까요?';
      if (confirm(msg)) {
        db.cats = db.cats.filter(c => c.id !== cid);
        db.entries.forEach(e => { e.tids = e.tids.filter(x => x !== cid); });
        db.entries = db.entries.filter(e => e.tids.length); save(); closeSheet(); render();
      }
      break;
    }
    case 'adv': {
      const e = entry(), st = stOf(e, date);
      if (twoStep(e) && st === 0) { setStamp(e, date, { out: Date.now() }); setSt(e, date, 1); }
      else { if (twoStep(e)) setStamp(e, date, { back: Date.now() }); setSt(e, date, 2); }
      render(); break;
    }
    case 'undo': {
      const e = entry(), st = stOf(e, date);
      if (st === 2 && twoStep(e)) { const s = stampOf(e, date); if (s) delete s.back; setSt(e, date, 1); }
      else { setStamp(e, date, null); setSt(e, date, 0); }
      render(); break;
    }
    case 'sxext': { const e = entry(); const s = stampOf(e, date); if (s) { s.ext = (s.ext || 0) + 30; save(); render(); } break; }
    case 'delEntry': {
      const eid = sheet.dataset.eid;
      if (confirm('이 일정을 삭제할까요?')) { db.entries = db.entries.filter(e => e.id !== eid); save(); closeSheet(); render(); }
      break;
    }
    case 'delPatient': {
      const pid = sheet.dataset.pid, p = patient(pid);
      if (confirm(`${p.name} 환자를 퇴원 처리하고 일정도 모두 삭제할까요?`)) {
        db.patients = db.patients.filter(x => x.id !== pid); db.entries = db.entries.filter(e => e.pid !== pid); db.surgeries = db.surgeries.filter(x => x.pid !== pid);
        save(); closeSheet(); render();
      }
      break;
    }
    case 'perm': if ('Notification' in window) Notification.requestPermission().then(render); break;
    case 'ics': exportIcs(); break;
    case 'export':
      download(`ward-backup-${todayStr()}.json`, 'application/json', JSON.stringify(db, null, 1));
      db.settings.lastBackup = Date.now(); save(); render(); toast('백업 파일을 저장했습니다', ''); break;
    case 'snooze': db.settings.snooze = todayStr(); save(); render(); break;
    case 'persist':
      if (!navigator.storage?.persist) { toast('이 브라우저는 영구 저장을 지원하지 않습니다', ''); break; }
      navigator.storage.persist().then(ok => { toast(ok ? '영구 저장이 허용되었습니다' : '브라우저가 허용하지 않았습니다', ok ? '' : '홈 화면에 추가해서 쓰면 허용될 수 있습니다'); render(); }); break;
    case 'import': $('#file').click(); break;
    case 'demo': demo(); break;
    case 'wipe':
      if (confirm('모든 환자·일정 데이터를 삭제합니다. 되돌릴 수 없습니다.')) { db = { ...db, patients: [], entries: [], surgeries: [], status: {}, stamps: {} }; save(); render(); }
      break;
    case 'toastGo': t.closest('.toast').remove(); tab = 'today'; date = todayStr(); render(); break;
  }
});
$('#fab').onclick = () => tab === 'rooms' ? patientForm() : tab === 'sx' ? sxForm() : entryForm();

/* ================= 내보내기/가져오기 ================= */
function download(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function importFile(ev) {
  const f = ev.target.files[0]; if (!f) return;
  f.text().then(txt => {
    const d = JSON.parse(txt);
    if (!Array.isArray(d.patients) || !Array.isArray(d.entries)) throw 0;
    if (!confirm('현재 데이터를 백업 파일로 덮어쓸까요?')) return;
    db = migrate({ status: {}, stamps: {}, settings: { lead: 10 }, cats: [], surgeries: [], ...d }); save(); render(); toast('불러오기 완료', '');
  }).catch(() => toast('불러오기 실패', '올바른 백업 파일이 아닙니다'));
}
function exportIcs() {
  const ics = s => s.replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const d0 = date.replace(/-/g, '');
  const ev = itemsOn(date).map(e => {
    const p = patient(e.pid), [h, m] = e.time.split(':');
    const end = tmin(e.time) + 30;
    return ['BEGIN:VEVENT', `UID:${e.id}-${d0}@ward-schedule`, `DTSTAMP:${d0}T000000`,
      `DTSTART:${d0}T${h}${m}00`, `DTEND:${d0}T${pad(Math.floor(end / 60) % 24)}${pad(end % 60)}00`,
      `SUMMARY:${ics(`${p.room}호 ${p.name} ${txLabel(e)} (${MOB[mobOf(e)].label})`)}`, `DESCRIPTION:${ics(memoOf(e) || '')}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:치료 이송', `TRIGGER:-PT${db.settings.lead}M`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
  });
  if (!ev.length) return toast('내보낼 일정이 없습니다', '');
  download(`schedule-${date}.ics`, 'text/calendar', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ward-schedule//KO', ...ev, 'END:VCALENDAR'].join('\r\n'));
}

/* ================= 알림 (앱이 열려 있는 동안) ================= */
const fired = new Set(JSON.parse(sessionStorage.getItem('fired') || '[]'));
function toast(title, sub, go) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<div>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>${go ? '<button data-act="toastGo">보기</button>' : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), go ? 60000 : 4000);
}
function tick() {
  purgeOld();
  const d = todayStr(), now = nowMin(), lead = db.settings.lead;
  for (const e of itemsOn(d)) {
    if (stOf(e, d) !== 0) continue;
    const k = stKey(e, d);
    if (fired.has(k) || now < tmin(e.time) - lead || now > tmin(e.time) + 30) continue;
    fired.add(k); sessionStorage.setItem('fired', JSON.stringify([...fired]));
    const p = patient(e.pid);
    const act = twoStep(e) ? `${MOB[mobOf(e)].label} 모시러 가기` : '혼자 이동 · 도착 확인';
    const title = `${e.time} ${p.room}호 ${p.name}`, body = `${txLabel(e)} · ${act}`;
    toast(title, body, true);
    try { navigator.vibrate?.([200, 100, 200]); } catch (e) {}
    if ('Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.getRegistration().then(r => r ? r.showNotification(title, { body, tag: k, icon: 'icons/icon-192.png' }) : new Notification(title, { body }));
    }
  }
  if (tab === 'today' && date === d && !sheet.open) renderToday(); // 지연/남은시간 갱신
}

/* ================= 예시 데이터 ================= */
function demo() {
  if ((db.patients.length || db.cats.length) && !confirm('현재 데이터에 예시 데이터를 추가합니다.')) return;
  const C = (label, memo) => { const c = { id: uid(), label, memo }; db.cats.push(c); return c.id; };
  const pt = C('3층 PT', '3층 쭉 들어가서 좌측'), ot = C('2층 OT', '엘리베이터 내려서 우측 첫 번째 방'),
    xr = C('1층 방사선', '원무과 옆 복도 끝'), ex = C('3층 운동치료', '');
  const P = (name, room, bed, note = '') => { const p = { id: uid(), name, room, bed, note }; db.patients.push(p); return p.id; };
  const a = P('김영수', 1, 1), b = P('박순자', 1, 3, '낙상 주의'), c = P('이철민', 2, 1, '우측 편마비'), d = P('최미숙', 5, 4),
    e = P('정대호', 7, 2), f = P('한지원', 12, 1), g = P('오세훈', 15, 1), h = P('윤정자', 19, 1), i = P('강민수', 19, 2);
  const E = (pid, time, tid, mob) => db.entries.push({ id: uid(), pid, date, time, tids: [].concat(tid), mob, memo: '' });
  [[a, '09:00', [pt, ot], 'walk'], [b, '09:00', pt, 'wheel'], [c, '09:30', ex, 'bed'], [d, '09:30', pt, 'walk'],
    [e, '10:00', ot, 'wheel'], [f, '10:30', pt, 'walk'], [g, '10:30', xr, 'bed'], [h, '11:00', ex, 'wheel'],
    [i, '11:00', pt, 'walk'], [a, '14:00', ot, 'walk'], [c, '15:00', pt, 'bed']].forEach(x => E(...x));
  db.surgeries.push({ id: uid(), kind: 'sx', pid: c, date, time: '13:00', name: '무릎 인공관절', dur: 120, mob: 'bed', memo: '금식 확인, 수술실 3번' });
  save(); render(); toast('예시 데이터를 불러왔습니다', '');
}

/* ================= 시작 ================= */
purgeOld();
render();
try { navigator.storage?.persist?.(); } catch (e) {}   // 브라우저가 임의로 데이터를 지우지 못하도록 요청 (허용 여부는 브라우저 판단)
setInterval(tick, 20000); tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (tab === 'today') render(); } });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
