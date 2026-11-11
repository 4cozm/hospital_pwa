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
const NEW_CAT = '__new__';

/* ================= 저장소 (localStorage 전용) ================= */
function uid() { return Math.random().toString(36).slice(2, 10); }
let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.patients && d.entries) return migrate({ status: {}, settings: { lead: 10 }, cats: [], surgeries: [], ...d });
  } catch (e) {}
  return { patients: [], entries: [], status: {}, settings: { lead: 10 }, cats: [], surgeries: [] };
}
/* v1 → v2: 이동방식은 환자가 아니라 일정(entry)의 속성, 치료는 카테고리(cats) 참조 */
function migrate(d) {
  d.cats = d.cats || [];
  d.surgeries = d.surgeries || [];
  const P = id => d.patients.find(p => p.id === id);
  for (const e of d.entries) {
    if (!e.mob) e.mob = P(e.pid)?.mob || 'walk';
    if (!e.tid) {
      const label = (e.tx || '').trim() || '미지정';
      let c = d.cats.find(c => c.label === label);
      if (!c) d.cats.push(c = { id: uid(), label, memo: '' });
      e.tid = c.id;
    }
    delete e.tx;
  }
  d.patients.forEach(p => delete p.mob);
  return d;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('저장 실패', '브라우저 저장공간이 가득 찼거나 차단되었습니다'); }
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
const mobOf = e => (MOB[e.mob] ? e.mob : 'walk');
const isSx = e => e.kind === 'sx';
const catOf = e => isSx(e) ? null : db.cats.find(c => c.id === e.tid);
const txLabel = e => isSx(e) ? `수술 ${e.name}` : (catOf(e)?.label || '(치료 미지정)');
const memoOf = e => isSx(e) ? e.memo : catOf(e)?.memo;
const txPill = (e, tag = 'button') => `<${tag} class="pill ${isSx(e) ? 'sx' : ''}" ${tag === 'button' ? `data-act="pill" data-id="${e.id}"` : ''}>${esc(txLabel(e))}${memoOf(e) ? ' <i>ⓘ</i>' : ''}</${tag}>`;
const findItem = id => db.entries.find(e => e.id === id) || db.surgeries.find(e => e.id === id);

let tab = 'today';
let date = todayStr();

/* 해당 날짜의 일정. daily=true 인 항목은 시작일 이후 매일 표시 */
function entriesOn(d) {
  return db.entries
    .filter(e => patient(e.pid) && (e.daily ? e.date <= d : e.date === d))
    .sort((a, b) => tmin(a.time) - tmin(b.time) || roomNo(a) - roomNo(b));
}
/* 오늘 화면용: 치료 + 수술을 시간순으로 합친 목록 */
function itemsOn(d) {
  return [...entriesOn(d), ...surgeriesOn(d)].sort((a, b) => tmin(a.time) - tmin(b.time) || roomNo(a) - roomNo(b));
}
const surgeriesOn = d => db.surgeries.filter(s => patient(s.pid) && s.date === d).sort((a, b) => tmin(a.time) - tmin(b.time));
const roomNo = e => patient(e.pid)?.room ?? 99;
const stKey = (e, d) => `${e.id}|${d}`;
const stOf = (e, d) => db.status[stKey(e, d)] || 0;   // 0 대기, 1 모시러 감/이동 중, 2 완료
function setSt(e, d, v) { if (v) db.status[stKey(e, d)] = v; else delete db.status[stKey(e, d)]; save(); }

/* ================= 렌더 ================= */
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fab').classList.toggle('hide', tab === 'settings' || tab === 'today');
  $('#fab').setAttribute('aria-label', { tx: '치료 일정 추가', sx: '수술 일정 추가', rooms: '환자 추가' }[tab] || '추가');
  ({ today: renderToday, tx: renderTx, sx: renderSx, rooms: renderRooms, settings: renderSettings })[tab]();
}

function mobBadge(k) { return `<span class="badge ${k}">${MOB[k].label}</span>`; }
function roomBox(p) {
  const r = roomOf(p.room);
  return `<div class="room ${r?.vip ? 'vip' : ''}"><b>${p.room}</b><small>호${r?.vip ? ' 특' : ''}</small></div>`;
}

function renderToday() {
  const isToday = date === todayStr();
  const list = itemsOn(date);
  const total = list.length;
  const done = list.filter(e => stOf(e, date) === 2).length;
  const esc_ = list.filter(e => MOB[mobOf(e)].escort && stOf(e, date) !== 2).length;
  const solo = list.filter(e => !MOB[mobOf(e)].escort && stOf(e, date) !== 2).length;

  $('#top').innerHTML = `
    <div class="hrow">
      <h1>${isToday ? '오늘 ' : ''}${fmtDate(date)}</h1>
      <div class="datenav">
        <button data-act="day" data-n="-1" aria-label="전날">‹</button>
        <button class="dl" data-act="day" data-n="0">오늘</button>
        <button data-act="day" data-n="1" aria-label="다음날">›</button>
      </div>
    </div>
    <div class="sum">
      <span>전체 <b>${total}</b></span><span>완료 <b>${done}</b></span>
      <span>모시러 <b>${esc_}</b></span><span>혼자 확인 <b>${solo}</b></span>
    </div>`;

  let html = '';
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
      const ec = g.filter(e => MOB[mobOf(e)].escort).length;
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
    <div class="lab">${isSx(e) ? '수술 · ' : ''}${st === 1 ? '이송 중' : '다음 일정'} · ${when}</div>
    <div class="big"><span class="t">${e.time}</span><span class="rm">${p.room}호</span><span class="nm">${esc(p.name)}</span></div>
    <div class="meta">${esc(txLabel(e))} · ${m.label}${p.note ? ' · ' + esc(p.note) : ''}</div>
    <div class="mini"><button class="go" data-act="adv" data-id="${e.id}">${advLabel(m, st)}</button></div>
  </div>`;
}
function advLabel(m, st) {
  if (m.escort) return st === 0 ? '🚶 이송 완료' : '↩ 복귀 완료';
  return '✅ 잘 갔는지 확인';
}

function card(e, late) {
  const p = patient(e.pid), st = stOf(e, date), mk = mobOf(e), m = MOB[mk];
  let btns = '';
  if (st === 2) btns = `<button class="alt" data-act="undo" data-id="${e.id}">되돌리기</button>`;
  else {
    const cls = m.escort ? (st === 0 ? 'esc ' + (mk === 'bed' ? 'b' : '') : 'fin') : 'fin';
    btns = `<button class="${cls}" data-act="adv" data-id="${e.id}">${advLabel(m, st)}</button>
      ${st === 1 ? `<button class="alt" data-act="undo" data-id="${e.id}">취소</button>` : ''}`;
  }
  const badge = (isSx(e) ? '<span class="badge sx">수술</span>' : '') + (st === 2 ? `<span class="badge st">${m.escort ? '복귀 완료' : '확인 완료'}</span>` : st === 1 ? '<span class="badge go">이송됨 · 복귀 대기</span>' : '');
  return `<article class="card ${mk} ${st === 2 ? 'done' : ''} ${late ? 'late' : ''}">
    ${roomBox(p)}
    <div class="who"><span class="n">${esc(p.name)}</span>${mobBadge(mk)}${badge}</div>
    <div>${txPill(e)}${e.daily ? ' <span class="note">· 매일</span>' : ''}
      ${p.note || e.memo ? `<div class="note">${esc([p.note, e.memo].filter(Boolean).join(' · '))}</div>` : ''}</div>
    <div class="act">${btns}</div>
  </article>`;
}

function renderRooms() {
  $('#top').innerHTML = `<div class="hrow"><h1>병실 현황</h1></div>
    <div class="sum"><span>입원 <b>${db.patients.length}</b>명</span></div>`;
  const card_ = r => {
    const ps = db.patients.filter(p => p.room === r.no);
    const slots = Array.from({ length: r.cap }, (_, i) => ps[i]
      ? `<div class="slot">${esc(ps[i].name)}</div>`
      : `<div class="slot empty">＋ 빈 자리</div>`).join('');
    return `<button class="rc ${r.vip ? 'vip' : ''}" data-act="room" data-no="${r.no}">
      <div class="rh"><b>${r.no}호</b><span>${r.code} · ${r.vip ? '특실' : '일반'} ${r.cap}인</span></div>${slots}</button>`;
  };
  $('#view').innerHTML = `<div class="sec">일반실 (1~11호)</div><div class="rgrid">${ROOMS.filter(r => !r.vip).map(card_).join('')}</div>
    <div class="sec">특실 (12~19호)</div><div class="rgrid">${ROOMS.filter(r => r.vip).map(card_).join('')}</div>`;
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
          <div>${txPill(e, 'span')}${e.daily ? ' <span class="note">· 매일</span>' : ''}</div>
          ${e.memo ? `<div class="note">${esc(e.memo)}</div>` : ''}</div></button>`;
      }).join('')}</section>`;
  }
  return html;
}
function renderTx() {
  const list = entriesOn(date);
  dateHdr('치료일정', `<span>${list.length}건</span><span>＋ 버튼으로 추가 · 항목을 눌러 수정</span>`);
  $('#view').innerHTML = list.length ? editRows(list, 'editEntry')
    : `<div class="empty-msg">이 날짜의 치료 일정이 없습니다.<br><button class="btn pri" data-act="addEntry">＋ 치료 일정 추가</button></div>`;
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
  $('#view').innerHTML = `
  <div class="set"><h3>치료 종류</h3>
    <p>일정 입력 때 이 목록에서 고르고, 일정에는 필로 표시됩니다. 필을 누르면 메모가 나옵니다.</p>
    <div class="chips" style="margin:8px 0">${db.cats.map(c => `<button class="pill" data-act="editCat" data-id="${c.id}">${esc(c.label)}${c.memo ? ' <i>ⓘ</i>' : ''}</button>`).join('') || '<span class="note">아직 없음</span>'}</div>
    <button class="btn pri" data-act="addCat">＋ 치료 종류 추가</button></div>
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
    <p>데이터는 이 기기의 브라우저에만 저장됩니다. 브라우저 데이터 삭제·기기 변경 시 사라지니 가끔 백업하세요.</p>
    <button class="btn" data-act="export">JSON 내보내기</button>
    <button class="btn" data-act="import">JSON 불러오기</button>
    <input type="file" id="file" accept="application/json" hidden></div>
  <div class="set"><h3>데이터</h3>
    <button class="btn" data-act="demo">예시 데이터 불러오기</button>
    <button class="btn danger" data-act="wipe">전체 삭제</button></div>
  <p class="note" style="text-align:center">환자 정보는 외부로 전송되지 않습니다 · 모든 데이터는 로컬 저장</p>`;
  $('#lead').onchange = e => { db.settings.lead = Number(e.target.value); save(); };
  $('#file').onchange = importFile;
}

/* ================= 시트(모달) ================= */
const sheet = $('#sheet');
function openSheet(html) { sheet.innerHTML = `<div class="sh">${html}</div>`; if (!sheet.open) sheet.showModal(); }
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function roomOptions(sel) {
  return ROOMS.map(r => {
    const n = db.patients.filter(p => p.room === r.no).length;
    return `<option value="${r.no}" ${sel === r.no ? 'selected' : ''}>${r.no}호 (${r.code}) ${n}/${r.cap}${r.vip ? ' 특실' : ''}</option>`;
  }).join('');
}

function patientForm(p, presetRoom) {
  const isNew = !p;
  p = p || { name: '', room: presetRoom || 1, note: '' };
  openSheet(`<h2>${isNew ? '환자 추가' : '환자 수정'}</h2>
  <form id="pf">
    <div class="f"><label>이름</label><input name="name" value="${esc(p.name)}" required autocomplete="off"></div>
    <div class="f"><label>병실</label><select name="room">${roomOptions(p.room)}</select></div>
    <div class="f"><label>메모 (선택)</label><input name="note" value="${esc(p.note)}" placeholder="예: 왼쪽 어깨 주의, 보호자 동행" autocomplete="off"></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delPatient">퇴원</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  $('#pf').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const room = Number(f.get('room'));
    const r = roomOf(room);
    const occ = db.patients.filter(x => x.room === room && x.id !== p.id).length;
    if (occ >= r.cap && !confirm(`${room}호는 정원 ${r.cap}명이 이미 찼습니다. 그래도 배정할까요?`)) return;
    const data = { name: f.get('name').trim(), room, note: f.get('note').trim() };
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
/* 환자 선택: 기본값 없이 비워 두어 엉뚱한 환자에 저장되는 실수를 막는다 */
function patientSelect(sel, blank) {
  const ps = [...db.patients].sort((a, b) => a.room - b.room || a.name.localeCompare(b.name, 'ko'));
  return `<select name="pid" required>${blank ? '<option value="">환자를 선택하세요</option>' : ''}${ps.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.room}호 ${esc(p.name)}</option>`).join('')}</select>`;
}
function lastMob(pid) {
  const l = db.entries.filter(x => x.pid === pid).pop();
  return l ? mobOf(l) : 'walk';
}
function entryForm(e, presetPid) {
  if (!db.patients.length) return noPatientSheet();
  const isNew = !e;
  e = e || { pid: presetPid || '', time: nextSlot(), tid: db.cats.length ? '' : NEW_CAT, mob: presetPid ? lastMob(presetPid) : 'walk', daily: false, memo: '' };
  openSheet(`<h2>${isNew ? '일정 추가' : '일정 수정'} · ${fmtDate(e.date || date)}</h2>
  <form id="ef">
    <div class="f"><label>환자 (병실에 등록된 환자만)</label>${patientSelect(e.pid, isNew && !e.pid)}</div>
    <div class="f"><label>이동 방식</label><div class="seg">
      ${Object.entries(MOB).map(([k, v]) => `<label><input type="radio" name="mob" value="${k}" ${mobOf(e) === k ? 'checked' : ''}><span class="${k}">${v.label}</span></label>`).join('')}
    </div></div>
    <div class="row">
      <div class="f"><label>날짜${e.daily ? ' (시작일)' : ''}</label><input type="date" name="date" value="${e.date || date}" required></div>
      <div class="f"><label>시간</label><input type="time" name="time" value="${e.time}" required></div>
    </div>
    <div class="f"><label>치료 (시술)</label>
      <select name="tid" required>
        ${isNew && !e.tid ? '<option value="">치료를 선택하세요</option>' : ''}
        ${db.cats.map(c => `<option value="${c.id}" ${c.id === e.tid ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        <option value="${NEW_CAT}" ${e.tid === NEW_CAT ? 'selected' : ''}>＋ 새 치료 종류 추가…</option>
      </select>
      <div id="newcat" class="newcat" ${e.tid === NEW_CAT ? '' : 'hidden'}>
        <input name="ncl" placeholder="표시 이름 (예: 3층 PT)" autocomplete="off">
        <input name="ncm" placeholder="상세 메모 (예: 3층 쭉 들어가서 좌측)" autocomplete="off">
      </div>
    </div>
    <div class="f"><label>일정 메모 (선택)</label><input name="memo" value="${esc(e.memo)}" autocomplete="off"></div>
    <div class="f"><label class="chk"><input type="checkbox" name="daily" ${e.daily ? 'checked' : ''}> 이 날짜부터 매일 반복</label></div>
    <div class="acts">
      ${isNew ? '' : '<button type="button" class="danger" data-act="delEntry">삭제</button>'}
      <button type="button" data-act="close">취소</button>
      <button class="pri">저장</button></div>
  </form>`);
  sheet.dataset.eid = e.id || '';
  if (isNew) $('#ef [name=pid]').onchange = ev => {   // 환자를 바꾸면 그 환자의 지난 이동 방식을 기본값으로
    if (!ev.target.value) return;
    const r = $(`#ef [name=mob][value=${lastMob(ev.target.value)}]`); if (r) r.checked = true;
  };
  const syncNew = () => {
    const on = $('#ef [name=tid]').value === NEW_CAT;
    $('#newcat').hidden = !on; $('#ef [name=ncl]').required = on;
    if (on) $('#ef [name=ncl]').focus();
  };
  $('#ef [name=tid]').onchange = syncNew;
  $('#ef [name=ncl]').required = e.tid === NEW_CAT;
  $('#ef').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (!patient(f.get('pid'))) return toast('병실에 등록된 환자를 선택하세요', '');
    let tid = f.get('tid');
    if (tid === NEW_CAT) {   // 그 자리에서 새 치료 종류 생성 (같은 이름이 있으면 재사용)
      const label = f.get('ncl').trim(); if (!label) return;
      let c = db.cats.find(c => c.label === label);
      if (!c) db.cats.push(c = { id: uid(), label, memo: f.get('ncm').trim() });
      tid = c.id;
    }
    const data = { pid: f.get('pid'), date: f.get('date'), time: f.get('time'), tid, mob: f.get('mob'), memo: f.get('memo').trim(), daily: f.get('daily') === 'on' };
    if (isNew) db.entries.push({ id: uid(), ...data }); else Object.assign(e, data);
    date = data.date; save(); closeSheet(); render();
  };
}
function catForm(c) {
  const isNew = !c;
  c = c || { label: '', memo: '' };
  openSheet(`<h2>${isNew ? '치료 종류 추가' : '치료 종류 수정'}</h2>
  <form id="cf">
    <div class="f"><label>표시 이름 (필에 보이는 글자)</label><input name="label" value="${esc(c.label)}" required autocomplete="off" placeholder="예: 3층 PT"></div>
    <div class="f"><label>상세 메모 (필을 누르면 표시)</label><textarea name="memo" rows="3" placeholder="예: 3층 쭉 들어가서 좌측">${esc(c.memo)}</textarea></div>
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
  e = e || { kind: 'sx', pid: presetPid || '', date, time: '08:00', name: '', mob: 'bed', memo: '' };
  openSheet(`<h2>${isNew ? '수술 일정 추가' : '수술 일정 수정'}</h2>
  <form id="sf">
    <div class="f"><label>환자 (병실에 등록된 환자만)</label>${patientSelect(e.pid, isNew && !e.pid)}</div>
    <div class="row">
      <div class="f"><label>날짜</label><input type="date" name="date" value="${e.date}" required></div>
      <div class="f"><label>시간</label><input type="time" name="time" value="${e.time}" required></div>
    </div>
    <div class="f"><label>수술명</label><input name="name" value="${esc(e.name)}" required autocomplete="off" placeholder="예: 무릎 인공관절"></div>
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
  $('#sf').onsubmit = ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (!patient(f.get('pid'))) return toast('병실에 등록된 환자를 선택하세요', '');
    const data = { kind: 'sx', pid: f.get('pid'), date: f.get('date'), time: f.get('time'), name: f.get('name').trim(), mob: f.get('mob'), memo: f.get('memo').trim() };
    if (isNew) db.surgeries.push({ id: uid(), ...data }); else Object.assign(e, data);
    date = data.date; save(); closeSheet(); render();
  };
}
function pillSheet(e) {
  const c = catOf(e), memo = memoOf(e);
  openSheet(`<h2>${esc(txLabel(e))}</h2>
    ${memo ? `<p style="font-size:20px;line-height:1.5;margin:0 0 8px;white-space:pre-wrap">${esc(memo)}</p>` : `<p class="note">상세 메모가 없습니다. ${isSx(e) ? '수술일정에서' : '설정에서'} 추가할 수 있습니다.</p>`}
    ${!isSx(e) && e.memo ? `<p class="note">일정 메모: ${esc(e.memo)}</p>` : ''}
    <div class="acts"><button data-act="close">닫기</button>${c ? `<button data-act="editCat" data-id="${c.id}">메모 수정</button>` : ''}</div>`);
}
function nextSlot() { // 현재 시각 이후 가장 가까운 30분 단위
  const m = Math.ceil((nowMin() + 1) / 30) * 30;
  return `${pad(Math.min(23, Math.floor(m / 60)))}:${pad(m % 60 % 60)}`;
}

function roomSheet(no) {
  const r = roomOf(no), ps = db.patients.filter(p => p.room === no);
  openSheet(`<h2>${no}호 <small style="font-weight:500;color:var(--sub)">${r.code} · ${r.vip ? '특실' : '일반'} ${r.cap}인</small></h2>
    ${ps.map(p => `<button class="pl" data-act="editPatient" data-id="${p.id}"><div><div class="who"><span class="n">${esc(p.name)}</span></div>
      <div class="note">${esc(p.note)}</div></div></button>`).join('') || '<p class="note">비어 있음</p>'}
    <div class="acts"><button data-act="close">닫기</button>
    ${ps.length < r.cap ? `<button class="pri" data-act="addPatientTo" data-no="${no}">＋ 환자 배정</button>` : ''}</div>`);
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
    case 'addPatientTo': patientForm(null, Number(t.dataset.no)); break;
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
    case 'goRooms': closeSheet(); tab = 'rooms'; render(); scrollTo(0, 0); break;
    case 'pill': pillSheet(entry()); break;
    case 'addCat': catForm(); break;
    case 'editCat': catForm(db.cats.find(c => c.id === id)); break;
    case 'delCat': {
      const cid = sheet.dataset.cid, n = db.entries.filter(e => e.tid === cid).length;
      if (confirm(n ? `이 치료를 쓰는 일정 ${n}개도 함께 삭제됩니다. 삭제할까요?` : '삭제할까요?')) {
        db.cats = db.cats.filter(c => c.id !== cid); db.entries = db.entries.filter(e => e.tid !== cid); save(); closeSheet(); render();
      }
      break;
    }
    case 'adv': {
      const e = entry(), st = stOf(e, date);
      setSt(e, date, MOB[mobOf(e)].escort && st === 0 ? 1 : 2); render(); break;
    }
    case 'undo': { const e = entry(); setSt(e, date, stOf(e, date) === 2 && MOB[mobOf(e)].escort ? 1 : 0); render(); break; }
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
    case 'export': download(`ward-backup-${todayStr()}.json`, 'application/json', JSON.stringify(db, null, 1)); break;
    case 'import': $('#file').click(); break;
    case 'demo': demo(); break;
    case 'wipe':
      if (confirm('모든 환자·일정 데이터를 삭제합니다. 되돌릴 수 없습니다.')) { db = { ...db, patients: [], entries: [], surgeries: [], status: {} }; save(); render(); }
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
    db = migrate({ status: {}, settings: { lead: 10 }, cats: [], surgeries: [], ...d }); save(); render(); toast('불러오기 완료', '');
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
  const d = todayStr(), now = nowMin(), lead = db.settings.lead;
  for (const e of itemsOn(d)) {
    if (stOf(e, d) !== 0) continue;
    const k = stKey(e, d);
    if (fired.has(k) || now < tmin(e.time) - lead || now > tmin(e.time) + 30) continue;
    fired.add(k); sessionStorage.setItem('fired', JSON.stringify([...fired]));
    const p = patient(e.pid);
    const act = MOB[mobOf(e)].escort ? `${MOB[mobOf(e)].label} 모시러 가기` : '혼자 이동 · 도착 확인';
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
  const P = (name, room, note = '') => { const p = { id: uid(), name, room, note }; db.patients.push(p); return p.id; };
  const a = P('김영수', 1), b = P('박순자', 1, '낙상 주의'), c = P('이철민', 2, '우측 편마비'), d = P('최미숙', 5),
    e = P('정대호', 7), f = P('한지원', 12), g = P('오세훈', 15), h = P('윤정자', 19), i = P('강민수', 19);
  const E = (pid, time, tid, mob, daily = true) => db.entries.push({ id: uid(), pid, date, time, tid, mob, daily, memo: '' });
  [[a, '09:00', pt, 'walk'], [b, '09:00', pt, 'wheel'], [c, '09:30', ex, 'bed'], [d, '09:30', pt, 'walk'],
    [e, '10:00', ot, 'wheel'], [f, '10:30', pt, 'walk'], [g, '10:30', xr, 'bed', false], [h, '11:00', ex, 'wheel'],
    [i, '11:00', pt, 'walk'], [a, '14:00', ot, 'walk'], [c, '15:00', pt, 'bed']].forEach(x => E(...x));
  db.surgeries.push({ id: uid(), kind: 'sx', pid: c, date, time: '13:00', name: '무릎 인공관절', mob: 'bed', memo: '금식 확인, 수술실 3번' });
  save(); render(); toast('예시 데이터를 불러왔습니다', '');
}

/* ================= 시작 ================= */
render();
setInterval(tick, 20000); tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (tab === 'today') render(); } });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
