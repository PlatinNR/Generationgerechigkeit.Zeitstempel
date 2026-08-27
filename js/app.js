/* ==========================================================================
   Zeitaufnahme · App-Logik
   Rollen: Admin, Manager, Mitarbeiter
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */
const S = {
  me: null,
  users: [],
  entries: [],
  absences: [],
  notifications: [],
  selView: 'stempeln',
  weekOffset: 0,        // für Team-Ansicht
  myWeekOffset: 0,      // für Meine Woche
};

/* --------------------------------------------------------------------------
   DOM-Shortcuts
   -------------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* --------------------------------------------------------------------------
   Datum-Helfer
   -------------------------------------------------------------------------- */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) {
  const x = startOfDay(d);
  const wd = (x.getDay() + 6) % 7;
  return addDays(x, -wd);
}
function formatDate(d) {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateLong(d) {
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function weekdayShort(d) {
  return d.toLocaleDateString('de-DE', { weekday: 'short' });
}
function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minToHM(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function timeToSec(t) {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  const h = parts[0] || 0, m = parts[1] || 0, s = parts[2] || 0;
  return h * 3600 + m * 60 + s;
}
function secToHMS(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
function nowSec() { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); }
function nowKey() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/* Stempelzeit MIT Sekunden, damit der Timer ab 0 startet */
function nowKeySec() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
/* Anzeigezeit: nur HH:MM (Sekunden weglassen) */
function fmtTime(t) {
  if (!t) return '–';
  const parts = String(t).split(':');
  return `${parts[0]}:${parts[1]}`;
}
function weekRange(offset) {
  const m = mondayOf(addDays(new Date(), offset * 7));
  const s = addDays(m, 6);
  return { monday: m, sunday: s, key: dateKey(m) };
}
function weekNumber(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = (d - start + (start.getTimezoneOffset() - d.getTimezoneOffset()) * 60000) / 86400000;
  return Math.ceil((diff + start.getDay() + 1) / 7);
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dailyTarget(user) {
  return Math.round(user.weeklyHours * 60 / 5);
}

/* --------------------------------------------------------------------------
   Rollen-Helfer
   -------------------------------------------------------------------------- */
function isAdmin() { return S.me && S.me.role === 'admin'; }
function isManager() { return S.me && S.me.role === 'manager'; }
function isMgmt() { return isAdmin() || isManager(); }
function isStaff() { return S.me && S.me.role === 'mitarbeiter'; }

/* --------------------------------------------------------------------------
   Logout (wird auch von api.js aufgerufen)
   -------------------------------------------------------------------------- */
let timerHandle = null;
window.apiLogout = function () {
  S.me = null;
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  $('#loginError').classList.add('hidden');
  clearInterval(timerHandle);
  if (window._punchTimer) { clearInterval(window._punchTimer); window._punchTimer = null; }
};

/* --------------------------------------------------------------------------
   Login
   -------------------------------------------------------------------------- */
async function doLogin() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  if (!username || !password) return;
  $('#loginError').classList.add('hidden');
  try {
    const res = await API.login(username, password);
    S.me = res.user;
    // Kurz warten, bis das Session-Cookie im Browser verarbeitet ist,
    // sonst kann ein Folge-Request fälschlich 401 liefern und den Login verwerfen.
    await new Promise(r => setTimeout(r, 80));
    await initApp();
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
  } catch (e) {
    $('#loginError').textContent = e.message;
    $('#loginError').classList.remove('hidden');
  }
}

async function doLogout() {
  try { await API.logout(); } catch (e) { /* ignore */ }
  // Session-Cookie zusätzlich clientseitig löschen (falls der Server-Rückruf nicht ankommt)
  document.cookie = 'za_session=; Max-Age=0; Path=/; SameSite=Lax;';
  window.apiLogout();
}

/* --------------------------------------------------------------------------
   App-Init
   -------------------------------------------------------------------------- */
async function initApp() {
  try {
    const u = await API.getUsers();
    S.users = u.users;
    const e = await API.getEntries();
    S.entries = e.entries;
    const a = await API.getAbsences();
    S.absences = a.absences;
    const n = await API.getNotifications();
    S.notifications = n.notifications;
  } catch (e) {
    /* fallback */
  }
  renderSidebar();
  renderTopbar();
  renderNotifications();
  populateUserSelect();
  switchView('stempeln');
  startClock();
}

/* --------------------------------------------------------------------------
   Sidebar / Navigation
   -------------------------------------------------------------------------- */
function renderSidebar() {
  $('#meName').textContent = S.me.name;
  const roleEl = $('#meRole');
  roleEl.textContent = { admin: 'Admin', manager: 'Manager', mitarbeiter: 'Mitarbeiter' }[S.me.role];
  roleEl.className = 'role-badge ' + ({ admin: 'role-admin', manager: 'role-manager', mitarbeiter: 'role-staff' })[S.me.role];

  $$('.nav-mgmt').forEach(el => {
    const roles = (el.dataset.roles || '').split(',');
    el.classList.toggle('hidden', !roles.includes(S.me.role));
  });
}

/* --------------------------------------------------------------------------
   Uhr
   -------------------------------------------------------------------------- */
function startClock() {
  tickClock();
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(tickClock, 1000);
}

function tickClock() {
  const d = new Date();
  $('#clockTime').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#clockDate').textContent = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/* --------------------------------------------------------------------------
   Topbar
   -------------------------------------------------------------------------- */
function renderTopbar() {
  const titles = {
    stempeln: ['Stempeln', 'Ein-/Ausstempeln & Tagesübersicht'],
    woche: ['Meine Woche', 'Wochenbilanz & Zeitstrahl'],
    abwesenheit: ['Abwesenheit', 'Urlaub · Krankheit · Fehltag'],
    team: ['Team', 'Mitarbeiter-Übersicht & manuelle Zeiterfassung'],
    personen: ['Personen Konfigurieren', 'Bearbeiten, Stundenstand & Export'],
    anlegen: ['Personen Anlegen', 'Neue Person erstellen'],
  };
  const [t, s] = titles[S.selView] || ['–', ''];
  $('#viewTitle').textContent = t;
  $('#viewSubtitle').textContent = s;
}

/* --------------------------------------------------------------------------
   Benachrichtigungen
   -------------------------------------------------------------------------- */
function notifMessage(n) {
  if (n.type === 'password-changed') {
    const d = new Date(n.detail);
    const ds = isNaN(d.getTime()) ? n.detail : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `Der Admin hat dein Passwort am ${ds} geändert. Bitte verwende dein neues Passwort.`;
  }
  if (n.type === 'account-created') {
    return 'Dein Konto wurde angelegt. Die Zugangsdaten vergibt der Admin persönlich.';
  }
  if (n.type === 'entry-overwritten') {
    const parts = (n.detail || '').split(' ');
    const ds = parts[0] ? new Date(parts[0] + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const art = parts[1] || 'Zeit';
    return `Der Admin hat deinen ${art}eintrag am ${ds} angepasst/überschrieben.`;
  }
  return 'Neue Benachrichtigung.';
}

function notifCountUnread() {
  return S.notifications.filter(n => !n.read).length;
}

function renderNotifications() {
  const badge = $('#notifBadge');
  const count = notifCountUnread();
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);

  const list = $('#notifList');
  if (S.notifications.length === 0) {
    list.innerHTML = '<p class="empty-state">Keine Benachrichtigungen.</p>';
    return;
  }
  list.innerHTML = S.notifications.map(n => `
    <div class="notif-item ${n.read ? 'read' : 'unread'}" data-nid="${n.id}">
      <span class="notif-dot"></span>
      <div class="notif-body">
        ${esc(notifMessage(n))}
        <span class="notif-date">${formatDateLong(new Date(n.createdAt))}</span>
      </div>
    </div>
  `).join('');
}

async function markNotifRead(id) {
  const n = S.notifications.find(x => x.id === id);
  if (!n || n.read) return;
  n.read = true;
  renderNotifications();
  try { await API.markNotificationRead(id); } catch (e) { /* ignore */ }
}

function toggleNotifDropdown() {
  $('#notifDropdown').classList.toggle('hidden');
}

/* --------------------------------------------------------------------------
   View-Wechsel
   -------------------------------------------------------------------------- */
function switchView(view) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (!el) return;
  el.classList.remove('hidden');
  $$('.nav-item').forEach(n => n.classList.remove('current'));
  const nav = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nav) nav.classList.add('current');
  S.selView = view;
  renderTopbar();
  renderView(view);
}

function renderView(view) {
  switch (view) {
    case 'stempeln': renderStempeln(); break;
    case 'woche': renderWoche(); break;
    case 'abwesenheit': renderAbsence(); break;
    case 'team': renderTeam(); break;
    case 'personen': renderPersonen(); break;
    case 'anlegen': renderAnlegen(); break;
  }
}

/* --------------------------------------------------------------------------
   Daten-Helfer
   -------------------------------------------------------------------------- */
function entriesForUser(userId) {
  return S.entries.filter(e => e.userId === userId);
}
function absencesForUser(userId) {
  return S.absences.filter(a => a.userId === userId);
}
function userById(id) {
  return S.users.find(u => u.id === id) || null;
}

function populateUserSelect() {
  const tUser = $('#tUser');
  if (!tUser) return;
  const active = S.users.filter(u => u.active !== false);
  const cur = tUser.value;
  tUser.innerHTML = active.length
    ? active.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')
    : '<option value="">— Keine aktiven Personen —</option>';
  if (cur && active.some(u => u.id === cur)) tUser.value = cur;
}

function dayMinutes(entries, userId, date, type) {
  return entries
    .filter(e => e.userId === userId && e.date === date && e.type === type && e.end != null)
    .reduce((s, e) => s + Math.max(0, timeToMin(e.end) - timeToMin(e.start)), 0);
}

/* Wochenbilanz je Person. Nur bestätigte Abwesenheit zählen; offene sind neutral.
   Das Konto (total) zeigt den bereits abgerechneten Stand – die laufende Woche wird
   erst am Wochenende verbucht. */
function weekBalance(userId, weekStart, entries, absences, liveExtra) {
  const user = userById(userId);
  if (!user) return null;
  const daily = dailyTarget(user); // Minuten pro Werktag
  const soll = Math.round(user.weeklyHours * 60);
  let gut = 0;         // gearbeitete Minuten (work − break)
  let weekDiff = 0;    // Wochenbilanz = Summe der Tages-Differenzen (Mo–Fr)
  let todayLive = 0;   // heutiger Beitrag (live)
  let deficitDays = 0;
  let pendingDays = 0;
  const days = [];
  const today = dateKey(new Date());
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const key = dateKey(d);
    const dow = d.getDay(); // 0=So, 6=Sa
    let w = dayMinutes(entries, userId, key, 'work');
    const b = dayMinutes(entries, userId, key, 'break');
    if (liveExtra && liveExtra[key]) w += liveExtra[key];
    gut += Math.max(0, w - b);
    let dayDiff = 0;
    let credit = 0;
    let absType = '';
    let absNote = '';
    let absId = null;
    let credited = false;
    let confirmed = false;
    const abs = absences.find(a => a.userId === userId && a.dateFrom <= key && key <= a.dateTo);
    if (abs) {
      absType = abs.type;
      absNote = abs.note;
      absId = abs.id;
      credited = abs.credited;
      confirmed = abs.status === 'confirmed';
    }
    if (dow === 0 || dow === 6) {
      dayDiff = 0; // Wochenende: kein Soll, kein Beitrag
    } else if (abs && confirmed && (abs.type === 'urlaub' || abs.type === 'krank' || credited)) {
      dayDiff = 0; // bestätigt = ausgeglichen
      credit = daily;
    } else if (abs && confirmed && abs.type === 'fehltag' && !credited) {
      dayDiff = -daily; // Fehlstunde
      deficitDays++;
    } else if (abs && !confirmed) {
      dayDiff = 0; // offen = neutral
      pendingDays++;
    } else {
      dayDiff = (w - b) - daily; // Arbeit − Tages-Soll
      credit = Math.max(0, w - b);
    }
    weekDiff += dayDiff;
    if (key === today) todayLive = dayDiff;
    days.push({ key, work: w - b, break: b, absType, absNote, absId, credited, confirmed, credit, dayDiff });
  }
  const effektiv = gut;
  const balance = (user.balance || 0) * 60; // abgerechnetes Konto (Minuten)
  const total = balance + todayLive;        // Kontobilanz inkl. heutigem Beitrag
  return { user, soll, daily, gut, effektiv, diff: weekDiff, balance, total, deficitDays, pendingDays, days };
}

/* --------------------------------------------------------------------------
   Zeitstrahl – feste Skala −100 h bis +100 h (Wert über ±100 läuft voll)
   -------------------------------------------------------------------------- */
const ZT_MAX = 100 * 60;

function renderZT(containerId, diff) {
  const el = $(containerId);
  if (!el) return;
  const pct = diff === 0 ? 0 : Math.min(100, Math.abs(diff) / ZT_MAX * 50);
  const pos = diff > 0;
  const valueHTML = diff === 0
    ? '<div class="zt-center-label">±0</div>'
    : `<div class="zt-value ${pos ? 'pos' : 'neg'}" style="${pos ? 'left:calc(50% + 8px)' : 'right:calc(50% + 8px)'}">${pos ? '+' : '-'}${minToHM(Math.abs(diff))}</div>`;
  el.innerHTML = `
    <div class="zt">
      <div class="zt-inner">
        <div class="zt-half zt-half-left"><div class="zt-bar neg" style="width:${pos ? 0 : pct}%;right:0"></div></div>
        <div class="zt-half zt-half-right"><div class="zt-bar pos" style="width:${pos ? pct : 0}%;left:0"></div></div>
        <div class="zt-zero"></div>
      </div>
      <div class="zt-scale">
        <span>-100 h</span>
        <span>0</span>
        <span>+100 h</span>
      </div>
      ${valueHTML}
    </div>
  `;
}

function ztInner(diff) {
  const pct = diff === 0 ? 0 : Math.min(100, Math.abs(diff) / ZT_MAX * 50);
  const pos = diff > 0;
  const valueHTML = diff === 0
    ? '<div class="zt-center-label" style="font-size:11px">±0</div>'
    : `<div class="zt-value ${pos ? 'pos' : 'neg'}" style="font-size:11px;${pos ? 'left:calc(50% + 4px)' : 'right:calc(50% + 4px)'}">${pos ? '+' : '-'}${minToHM(Math.abs(diff))}</div>`;
  return `
    <div class="zt-inner" style="height:24px">
      <div class="zt-half zt-half-left"><div class="zt-bar neg" style="width:${pos ? 0 : pct}%;right:0;height:24px"></div></div>
      <div class="zt-half zt-half-right"><div class="zt-bar pos" style="width:${pos ? pct : 0}%;left:0;height:24px"></div></div>
      <div class="zt-zero"></div>
    </div>
    ${valueHTML}
  `;
}

/* ====================================================================
   STEMPELN
   ==================================================================== */
function renderStempeln() {
  const daily = dailyTarget(S.me);
  $('#kpiSoll').textContent = minToHM(daily);
  updateLiveKPIs();
  renderPunch();
  renderTodayEntries();
}

/* Live-Ist-Zeit heute in Minuten (offener Stempel zählt, Pause wird abgezogen) */
function liveIstToday() {
  const today = dateKey(new Date());
  const myEntries = entriesForUser(S.me.id);
  let closed = dayMinutes(myEntries, S.me.id, today, 'work') - dayMinutes(myEntries, S.me.id, today, 'break');
  const openWork = myEntries.find(e => e.date === today && e.type === 'work' && e.end == null);
  const openBreak = myEntries.find(e => e.date === today && e.type === 'break' && e.end == null);
  if (openWork) {
    const workSec = nowSec() - timeToSec(openWork.start);
    const breakSec = openBreak ? nowSec() - timeToSec(openBreak.start) : 0;
    closed += Math.max(0, workSec - breakSec) / 60;
  }
  return Math.max(0, closed);
}

/* Offene Minuten für die Wochenbilanz (live) */
function liveExtraMinutes() {
  const today = dateKey(new Date());
  const extra = {};
  const openWork = entriesForUser(S.me.id).find(e => e.date === today && e.type === 'work' && e.end == null);
  const openBreak = entriesForUser(S.me.id).find(e => e.date === today && e.type === 'break' && e.end == null);
  if (openWork) {
    const workSec = nowSec() - timeToSec(openWork.start);
    const breakSec = openBreak ? nowSec() - timeToSec(openBreak.start) : 0;
    const net = Math.max(0, workSec - breakSec) / 60;
    if (net > 0) extra[today] = net;
  }
  return extra;
}

/* KPI-Update (läuft sekündlich während des Stempelns) */
function updateLiveKPIs() {
  const ist = liveIstToday();
  $('#kpiIst').textContent = minToHM(ist);

  const mw = mondayOf(new Date());
  const wb = weekBalance(S.me.id, mw, entriesForUser(S.me.id), absencesForUser(S.me.id), liveExtraMinutes());
  if (wb) {
    const kpiDiff = $('#kpiDiff');
    kpiDiff.textContent = (wb.diff >= 0 ? '+' : '-') + minToHM(Math.abs(wb.diff));
    kpiDiff.className = 'kpi-value ' + (wb.diff > 0 ? 'pos' : wb.diff < 0 ? 'neg' : '');
    const kpiWeek = $('#kpiWeekDiff');
    kpiWeek.textContent = (wb.total >= 0 ? '+' : '-') + minToHM(Math.abs(wb.total));
    kpiWeek.className = 'kpi-value ' + (wb.total > 0 ? 'pos' : wb.total < 0 ? 'neg' : '');
  }
}

function renderPunch() {
  const today = dateKey(new Date());
  const myEntries = entriesForUser(S.me.id);
  const openWork = myEntries.find(e => e.date === today && e.type === 'work' && e.end == null);
  const openBreak = myEntries.find(e => e.date === today && e.type === 'break' && e.end == null);

  const status = $('#punchStatus');
  const timer = $('#punchTimer');
  const buttons = $('#punchButtons');
  const log = $('#punchLog');

  // Wochenende: keine Arbeit möglich
  const dow = new Date().getDay();
  if ((dow === 0 || dow === 6) && !openWork) {
    status.textContent = 'Wochenende';
    status.className = 'live-badge';
    timer.textContent = '--:--:--';
    buttons.innerHTML = '';
    log.textContent = 'Samstag und Sonntag kann nicht gearbeitet werden.';
    if (window._punchTimer) { clearInterval(window._punchTimer); window._punchTimer = null; }
    return;
  }

  let runningStartSec = null;
  if (openBreak) {
    status.textContent = 'Pause';
    status.className = 'live-badge break';
    runningStartSec = timeToSec(openBreak.start);
  } else if (openWork) {
    status.textContent = 'Arbeitet';
    status.className = 'live-badge running';
    runningStartSec = timeToSec(openWork.start);
  } else {
    status.textContent = 'Bereit';
    status.className = 'live-badge';
    timer.textContent = '00:00:00';
  }

  if (runningStartSec != null) {
    const update = () => {
      timer.textContent = secToHMS(nowSec() - runningStartSec);
      updateLiveKPIs();
    };
    update();
    if (window._punchTimer) clearInterval(window._punchTimer);
    window._punchTimer = setInterval(update, 1000);
  } else {
    if (window._punchTimer) { clearInterval(window._punchTimer); window._punchTimer = null; }
  }

  buttons.innerHTML = '';
  if (openBreak) {
    addBtn(buttons, 'Pause beenden', 'button_theme button-big', async () => {
      await API.updateEntry(openBreak.id, { end: nowKeySec() });
      await reloadEntries();
      renderPunch();
      renderTodayEntries();
    });
  } else if (openWork) {
    addBtn(buttons, 'Arbeitsende', 'button_theme button-big', async () => {
      await API.updateEntry(openWork.id, { end: nowKeySec() });
      await reloadEntries();
      renderPunch();
      renderTodayEntries();
    });
    addBtn(buttons, 'Pause beginnen', 'button button-big', async () => {
      await API.createEntry({ date: today, type: 'break', start: nowKeySec(), end: null, source: 'punch' });
      await reloadEntries();
      renderPunch();
      renderTodayEntries();
    });
  } else {
    addBtn(buttons, 'Arbeitsbeginn', 'button_theme button-big', async () => {
      await API.createEntry({ date: today, type: 'work', start: nowKeySec(), end: null, source: 'punch' });
      await reloadEntries();
      renderPunch();
      renderTodayEntries();
    });
  }

  const todayEntries = myEntries.filter(e => e.date === today && e.end != null).sort((a, b) => a.start.localeCompare(b.start));
  log.textContent = todayEntries.length > 0
    ? todayEntries.map(e => `${e.type === 'work' ? 'Arbeit' : 'Pause'}: ${fmtTime(e.start)}–${fmtTime(e.end)} (${minToHM(timeToMin(e.end) - timeToMin(e.start))})`).join(' · ')
    : 'Heute noch keine abgeschlossenen Einträge.';
}

function addBtn(parent, label, cls, handler) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener('click', handler);
  parent.appendChild(btn);
}

function renderTodayEntries() {
  const today = dateKey(new Date());
  const myEntries = entriesForUser(S.me.id)
    .filter(e => e.date === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  const list = $('#todayList');
  const count = $('#todayEntryCount');
  count.textContent = myEntries.length + ' Einträge';
  if (myEntries.length === 0) {
    list.innerHTML = '<p class="empty-state">Noch keine Einträge.</p>';
    return;
  }
  list.innerHTML = myEntries.map(e => {
    const dur = e.end ? minToHM(timeToMin(e.end) - timeToMin(e.start)) : 'läuft…';
    const srcBadge = e.source === 'manual' ? '<span class="badge badge-manual">manuell</span> ' : '';
    return `<div class="entry-item">
      <span class="entry-color ${e.type}"></span>
      <div class="entry-main">
        <div class="entry-title">${srcBadge}${e.type === 'work' ? 'Arbeit' : 'Pause'}${e.note ? ' · ' + esc(e.note) : ''}</div>
        <div class="entry-meta">${e.start} – ${e.end || '–'}</div>
      </div>
      <div class="entry-right">
        <span class="entry-duration">${dur}</span>
      </div>
    </div>`;
  }).join('');
}

/* ====================================================================
   MEINE WOCHE
   ==================================================================== */
function renderWoche() {
  const wr = weekRange(S.myWeekOffset);
  $('#weekLabel').textContent = `KW ${weekNumber(wr.monday)} – ${formatDate(wr.monday)} bis ${formatDate(wr.sunday)}`;

  const myEntries = entriesForUser(S.me.id);
  const myAbsences = absencesForUser(S.me.id);
  const wb = weekBalance(S.me.id, wr.monday, myEntries, myAbsences);
  if (!wb) return;

  $('#wkSoll').textContent = minToHM(wb.soll);
  $('#wkGut').textContent = minToHM(wb.gut);
  $('#wkEff').textContent = minToHM(wb.effektiv);
  const wkDiff = $('#wkDiff');
  wkDiff.textContent = (wb.total >= 0 ? '+' : '') + minToHM(Math.abs(wb.total));
  wkDiff.className = 'kpi-value ' + (wb.total > 0 ? 'pos' : wb.total < 0 ? 'neg' : '');

  renderZT('#weekZeitstrahl', wb.total);
  let breakdown = `Mitgenommener Stand: ${wb.balance >= 0 ? '+' : ''}${minToHM(Math.abs(wb.balance))}  ·  Diese Woche: ${wb.diff >= 0 ? '+' : ''}${minToHM(Math.abs(wb.diff))}`;
  if (wb.pendingDays > 0) breakdown += `  ·  ${wb.pendingDays} Abwesenheit offen`;
  $('#wkBreakdown').textContent = breakdown;

  const body = $('#weekBody');
  body.innerHTML = '';
  let entryCount = 0;
  wb.days.forEach(day => {
    const isToday = day.key === dateKey(new Date());
    const tr = document.createElement('tr');
    if (isToday) tr.classList.add('is-today');
    const absText = day.absType
      ? `<span class="badge badge-${day.absType}">${day.absType}${day.absType === 'fehltag' ? (day.credited ? ' ✓' : ' ✗') : ''}${day.absId && !day.confirmed ? ' · offen' : ''}</span>`
      : '';
    tr.innerHTML = `
      <td class="cell-strong">${weekdayShort(parseKey(day.key))}</td>
      <td>${minToHM(day.work)}</td>
      <td class="cell-dim">${minToHM(day.break)}</td>
      <td>${absText}</td>
      <td class="${day.credit >= wb.daily ? 'cell-pos' : 'cell-dim'}">${minToHM(day.credit)}</td>
      <td class="table-actions">
        ${day.absId ? `<button type="button" class="icon-btn danger" data-adel="${day.absId}">&times;</button>` : ''}
      </td>
    `;
    body.appendChild(tr);
    if (day.work > 0 || day.break > 0 || day.absType) entryCount++;
  });
  $('#wkCount').textContent = entryCount + ' Tage mit Einträgen';

  body.querySelectorAll('[data-adel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Abwesenheit löschen?')) return;
      try {
        await API.deleteAbsence(btn.dataset.adel);
        await reloadAbsences();
        renderWoche();
      } catch (e) { alert(e.message); }
    });
  });
}

/* ====================================================================
   FEHLGRÜNDE
   ==================================================================== */
function renderAbsence() {
  const uf = $('#absenceUserField');
  if (isMgmt()) {
    uf.classList.remove('hidden');
    const sel = $('#aUser');
    const cur = sel.value;
    sel.innerHTML = S.users.filter(u => u.active !== false).map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    if (cur) sel.value = cur;
  } else {
    uf.classList.add('hidden');
  }

  const cf = $('#aCreditField');
  const aType = $('#aType').value;
  if (isAdmin() && aType === 'fehltag') {
    cf.classList.remove('hidden');
  } else {
    cf.classList.add('hidden');
  }

  renderAbsenceList();
  renderAbsenceAll();
}

function renderAbsenceList() {
  const wr = weekRange(0);
  const list = S.absences
    .filter(a => {
      const df = parseKey(a.dateFrom);
      const dt = parseKey(a.dateTo);
      return df <= wr.sunday && dt >= wr.monday && (isMgmt() || a.userId === S.me.id);
    })
    .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || a.userId.localeCompare(b.userId));
  const el = $('#absenceList');
  $('#absCount').textContent = list.length + ' Ausfälle';
  if (list.length === 0) {
    el.innerHTML = '<p class="empty-state">Keine Ausfälle in dieser Woche.</p>';
    return;
  }
  el.innerHTML = list.map(a => {
    const u = userById(a.userId);
    const confirmed = a.status === 'confirmed';
    const rangeText = a.dateFrom === a.dateTo ? formatDate(parseKey(a.dateFrom)) : `${formatDate(parseKey(a.dateFrom))} – ${formatDate(parseKey(a.dateTo))}`;
    const editable = isMgmt() || (a.userId === S.me.id && a.status === 'pending');
    return `<div class="entry-item">
      <span class="entry-color" style="background-color:${absColor(a)}"></span>
      <div class="entry-main">
        <div class="entry-title">${u ? esc(u.name) : '–'} <span class="badge badge-${a.type}">${a.type}</span> <span class="badge ${confirmed ? 'badge-gut' : 'badge-nicht'}">${confirmed ? 'bestätigt' : 'offen'}</span></div>
        <div class="entry-meta">${rangeText}${a.note ? ' · ' + esc(a.note) : ''}${a.type === 'fehltag' ? ' · ' + (a.credited ? 'gutgeschrieben' : 'nicht gutgeschrieben') : ''}</div>
      </div>
      <div class="entry-right">
        ${editable ? `<button type="button" class="icon-btn" data-aedit="${a.id}" title="Bearbeiten">✎</button>` : ''}
        ${isMgmt() && !confirmed ? `<button type="button" class="icon-btn" data-aconfirm="${a.id}" title="Bestätigen">✓</button>` : ''}
        ${isAdmin() && a.type === 'fehltag' ? `<button type="button" class="icon-btn" data-atoggle="${a.id}" title="Gutschrift umschalten">${a.credited ? '↩' : '✓'}</button>` : ''}
        <button type="button" class="icon-btn danger" data-adel="${a.id}">&times;</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-adel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Abwesenheit löschen?')) return;
      try { await API.deleteAbsence(btn.dataset.adel); await reloadAbsences(); renderAbsence(); } catch (e) { alert(e.message); }
    });
  });
  el.querySelectorAll('[data-aedit]').forEach(btn => {
    btn.addEventListener('click', () => openAbsenceEditDialog(btn.dataset.aedit));
  });
  el.querySelectorAll('[data-atoggle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const a = S.absences.find(x => x.id === btn.dataset.atoggle);
        if (a) { await API.updateAbsence(a.id, { credited: !a.credited }); await reloadAbsences(); renderAbsence(); toast('Gutschrift geändert'); }
      } catch (e) { alert(e.message); }
    });
  });
  el.querySelectorAll('[data-aconfirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await API.confirmAbsence(btn.dataset.aconfirm);
        await reloadAbsences();
        renderAbsence();
        toast('Abwesenheit bestätigt');
      } catch (e) { alert(e.message); }
    });
  });
}

function renderAbsenceAll() {
  const body = $('#absenceAllBody');
  const list = S.absences.slice().sort((a, b) => b.dateFrom.localeCompare(a.dateFrom) || a.userId.localeCompare(b.userId));
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">Keine Abwesenheit.</td></tr>';
    return;
  }
  body.innerHTML = list.slice(0, 80).map(a => {
    const u = userById(a.userId);
    const confirmed = a.status === 'confirmed';
    const rangeText = a.dateFrom === a.dateTo ? formatDate(parseKey(a.dateFrom)) : `${formatDate(parseKey(a.dateFrom))} – ${formatDate(parseKey(a.dateTo))}`;
    const editable = isMgmt() || (a.userId === S.me.id && a.status === 'pending');
    return `<tr>
      <td>${rangeText}</td>
      <td>${u ? esc(u.name) : '–'}</td>
      <td><span class="badge badge-${a.type}">${a.type}</span></td>
      <td>${confirmed ? `<span class="badge badge-gut">bestätigt</span>` : `<span class="badge badge-nicht">offen</span>`} ${a.credited ? `<span class="badge badge-gut">gutgeschrieben</span>` : `<span class="badge badge-nicht">nicht gutgeschrieben</span>`}</td>
      <td class="cell-dim">${esc(a.note) || '–'}</td>
      <td class="table-actions">
        ${editable ? `<button type="button" class="icon-btn" data-aedit="${a.id}" title="Bearbeiten">✎</button>` : ''}
        ${isMgmt() && !confirmed ? `<button type="button" class="icon-btn" data-aconfirm="${a.id}" title="Bestätigen">✓</button>` : ''}
        ${isAdmin() && a.type === 'fehltag' ? `<button type="button" class="icon-btn" data-atoggle="${a.id}">${a.credited ? '↩' : '✓'}</button>` : ''}
        <button type="button" class="icon-btn danger" data-adel="${a.id}">&times;</button>
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-adel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Abwesenheit löschen?')) return;
      try { await API.deleteAbsence(btn.dataset.adel); await reloadAbsences(); renderAbsence(); } catch (e) { alert(e.message); }
    });
  });
  body.querySelectorAll('[data-aedit]').forEach(btn => {
    btn.addEventListener('click', () => openAbsenceEditDialog(btn.dataset.aedit));
  });
  body.querySelectorAll('[data-aconfirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await API.confirmAbsence(btn.dataset.aconfirm);
        await reloadAbsences();
        renderAbsence();
        toast('Abwesenheit bestätigt');
      } catch (e) { alert(e.message); }
    });
  });
  body.querySelectorAll('[data-atoggle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const a = S.absences.find(x => x.id === btn.dataset.atoggle);
        if (a) { await API.updateAbsence(a.id, { credited: !a.credited }); await reloadAbsences(); renderAbsence(); toast('Gutschrift geändert'); }
      } catch (e) { alert(e.message); }
    });
  });
}

function absColor(a) {
  if (a.type === 'urlaub') return '#7a5bb0';
  if (a.type === 'krank') return '#cf2e2e';
  return a.credited ? '#3fa44e' : '#e67e22';
}

/* ====================================================================
   TEAM
   ==================================================================== */
function renderTeam() {
  if (isStaff()) return;
  const wr = weekRange(S.weekOffset);
  $('#teamWeekLabel').textContent = `KW ${weekNumber(wr.monday)} – ${formatDate(wr.monday)} bis ${formatDate(wr.sunday)}`;

  const active = S.users.filter(u => u.active !== false);
  $('#teamCount').textContent = active.length + ' aktive Personen';

  populateUserSelect();
  if (!$('#tDate').value) $('#tDate').value = dateKey(new Date());

  const body = $('#teamBody');
  body.innerHTML = '';
  const balances = [];
  active.forEach(u => {
    const wb = weekBalance(u.id, wr.monday, S.entries, S.absences);
    if (wb) balances.push(wb);
  });

  balances.forEach(wb => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td class="cell-strong">${esc(wb.user.name)}</td>
      <td><span class="role-badge ${({ admin: 'role-admin', manager: 'role-manager', mitarbeiter: 'role-staff' })[wb.user.role]}">${wb.user.role}</span></td>
      <td>${minToHM(wb.soll)}</td>
      <td>${minToHM(wb.effektiv)}</td>
      <td class="${wb.total > 0 ? 'cell-pos' : wb.total < 0 ? 'cell-neg' : ''}">${wb.total >= 0 ? '+' : ''}${minToHM(Math.abs(wb.total))}</td>
      <td><div class="zt" style="height:24px">${ztInner(wb.total)}</div></td>
    `;
    tr.addEventListener('click', () => showTeamDetail(wb));
    body.appendChild(tr);
  });

  $('#teamDetail').innerHTML = '<p class="empty-state">Klick auf eine Person für Details.</p>';
}

function showTeamDetail(wb) {
  $('#teamDetailDay').textContent = `KW ${weekNumber(parseKey(wb.days[0].key))}`;
  const el = $('#teamDetail');
  let html = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Tag</th><th>Arbeit</th><th>Abwesenheit</th><th>Gutschrift</th></tr></thead><tbody>`;
  wb.days.forEach(d => {
    html += `<tr>
      <td class="cell-strong">${weekdayShort(parseKey(d.key))}</td>
      <td>${minToHM(d.work)}</td>
      <td>${d.absType ? `<span class="badge badge-${d.absType}">${d.absType}</span>` : '–'}</td>
      <td>${minToHM(d.credit)}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  html += `<p><strong>Bilanz:</strong> Soll ${minToHM(wb.soll)} · Effektiv ${minToHM(wb.effektiv)} · Gesamt ${wb.total >= 0 ? '+' : ''}${minToHM(Math.abs(wb.total))}<br>
    <span class="cell-dim">Stand: ${wb.balance >= 0 ? '+' : ''}${minToHM(Math.abs(wb.balance))} · Diese Woche: ${wb.diff >= 0 ? '+' : ''}${minToHM(Math.abs(wb.diff))}</span></p>`;
  el.innerHTML = html;
}

/* ====================================================================
   PERSONEN KONFIGURIEREN
   ==================================================================== */
function renderPersonen() {
  if (!isAdmin()) return;
  const body = $('#userListBody');
  const active = S.users.filter(u => u.active !== false);
  $('#userCount').textContent = active.length + ' aktiv / ' + S.users.length + ' gesamt (Archivierte inklusive)';
  body.innerHTML = S.users.map(u => {
    const isSelf = u.id === S.me.id;
    const isArchived = u.active === false;
    return `<tr>
      <td class="cell-strong">${esc(u.name)}</td>
      <td><span class="role-badge ${({ admin: 'role-admin', manager: 'role-manager', mitarbeiter: 'role-staff' })[u.role]}">${u.role}</span></td>
      <td>${fmtHours(u.weeklyHours)}</td>
      <td class="${(u.balance || 0) > 0 ? 'cell-pos' : (u.balance || 0) < 0 ? 'cell-neg' : ''}">${fmtBalance(u.balance)} h</td>
      <td>${u.active !== false ? '<span class="badge badge-on">aktiv</span>' : '<span class="badge badge-off">archiviert</span>'}</td>
      <td class="table-actions">
        <button type="button" class="button button-sm" data-uedit="${u.id}">Bearbeiten</button>
        <button type="button" class="icon-btn" data-uplus="${u.id}" title="Stunden hinzufügen">+ h</button>
        <button type="button" class="icon-btn" data-uminus="${u.id}" title="Stunden abziehen">− h</button>
        ${isArchived && !isSelf ? `<button type="button" class="button button-sm" data-ureact="${u.id}" title="Reaktivieren">Aktivieren</button>` : ''}
        <button type="button" class="icon-btn" data-upw="${u.id}" title="Passwort zurücksetzen">&#128272;</button>
        <button type="button" class="icon-btn danger" data-udel="${u.id}" title="Endgültig löschen" ${isSelf ? 'disabled' : ''}>&times;</button>
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-uedit]').forEach(btn => {
    btn.addEventListener('click', () => openEditUserDialog(btn.dataset.uedit));
  });
  body.querySelectorAll('[data-ureact]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = S.users.find(x => x.id === btn.dataset.ureact);
      if (!u) return;
      try {
        await API.updateUser(u.id, { active: true });
        await reloadUsers();
        renderPersonen();
        toast(u.name + ' reaktiviert');
      } catch (e) { alert(e.message); }
    });
  });
  body.querySelectorAll('[data-uplus]').forEach(btn => {
    btn.addEventListener('click', () => openHoursDialog(btn.dataset.uplus, 1));
  });
  body.querySelectorAll('[data-uminus]').forEach(btn => {
    btn.addEventListener('click', () => openHoursDialog(btn.dataset.uminus, -1));
  });
  body.querySelectorAll('[data-upw]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = S.users.find(x => x.id === btn.dataset.upw);
      const pw = prompt('Neues Passwort für ' + (u ? u.name : '') + ':', '');
      if (!pw || pw.length < 6) { alert('Mindestens 6 Zeichen'); return; }
      try { await API.setPassword(btn.dataset.upw, pw); toast('Passwort geändert'); } catch (e) { alert(e.message); }
    });
  });
  body.querySelectorAll('[data-udel]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = S.users.find(x => x.id === btn.dataset.udel);
      if (!u) return;
      if (!confirm(esc(u.name) + ' ENDGÜLTIG löschen? Alle Zeiten und Abwesenheit werden entfernt. Stattdessen lieber archivieren.')) return;
      if (!confirm('Wirklich endgültig löschen? Dieser Schritt kann nicht rückgängig gemacht werden.')) return;
      try { await API.deleteUser(btn.dataset.udel); await reloadUsers(); renderPersonen(); toast('Person endgültig gelöscht'); } catch (e) { alert(e.message); }
    });
  });
}

let editUserId = null;
function openEditUserDialog(id) {
  const u = S.users.find(x => x.id === id);
  if (!u) return;
  editUserId = id;
  $('#euName').value = u.name;
  updateEditUsernameHint();
  $('#euRole').value = u.role;
  $('#euHours').value = fmtHours(u.weeklyHours);
  $('#euStatus').value = String(u.active !== false);
  $('#euRole').disabled = id === S.me.id;
  $('#euStatus').disabled = id === S.me.id;
  $('#editUserDialog').showModal();
}

function updateEditUsernameHint() {
  const name = $('#euName').value.trim();
  const hint = $('#euUsernameHint');
  if (name) {
    const un = deriveUsername(name);
    const taken = S.users.some(u => u.id !== editUserId && u.username === un);
    hint.textContent = 'Benutzername: ' + un + (taken ? ' (bereits vergeben)' : '');
    hint.style.color = taken ? 'var(--red)' : '';
  } else {
    hint.textContent = '';
  }
}

let hoursUserId = null;
let hoursSign = 1;
function openHoursDialog(id, sign) {
  const u = S.users.find(x => x.id === id);
  if (!u) return;
  hoursUserId = id;
  hoursSign = sign;
  $('#hoursTitle').textContent = sign > 0 ? 'Stunden hinzufügen' : 'Stunden abziehen';
  $('#hoursNote').textContent = `${u.name} – aktueller Stand: ${u.balance >= 0 ? '+' : ''}${fmtHours(u.balance)} h`;
  $('#hoursAmount').value = '1:00';
  $('#hoursDialog').showModal();
  $('#hoursAmount').focus();
  $('#hoursAmount').select();
}

/* Eingabe in Stunden (HH:MM oder Dezimal) → Dezimalstunden */
function parseHoursInput(str) {
  const s = String(str).trim().replace(',', '.');
  if (!s) return NaN;
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || m >= 60) return NaN;
    return h + m / 60;
  }
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

/* Dezimalstunden → "H:MM" bzw. "0:MM" */
function fmtHours(h) {
  const neg = h < 0;
  const abs = Math.abs(h);
  const hh = Math.floor(abs);
  const mm = Math.round((abs - hh) * 60);
  return (neg ? '-' : '') + `${hh}:${String(mm).padStart(2, '0')}`;
}
/* Balance mit Vorzeichen im HH:MM-Format */
function fmtBalance(b) {
  const s = fmtHours(b);
  return b > 0 ? '+' + s : s;
}

/* -- Dialog: Abwesenheit bearbeiten -- */
let absenceEditId = null;
function openAbsenceEditDialog(id) {
  const a = S.absences.find(x => x.id === id);
  if (!a) return;
  absenceEditId = id;
  $('#aeFrom').value = a.dateFrom;
  $('#aeTo').value = a.dateTo;
  $('#aeType').value = a.type;
  $('#aeCredit').checked = !!a.credited;
  $('#aeNote').value = a.note || '';
  const showCredit = isAdmin() && a.type === 'fehltag';
  $('#aeCreditField').classList.toggle('hidden', !showCredit);
  $('#absenceEditDialog').showModal();
}

/* ====================================================================
   PERSONEN ANLEGEN (Name = Benutzername)
   ==================================================================== */
function renderAnlegen() {
  if (!isAdmin()) return;
  updateUsernameHint($('#uName').value.trim());
  $('#uName').focus();
}

function deriveUsername(name) {
  return String(name).toLowerCase().trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '');
}

function updateUsernameHint(name) {
  const hint = $('#uUsernameHint');
  if (!name) { hint.textContent = ''; return; }
  const un = deriveUsername(name);
  if (un.length < 3) { hint.textContent = 'Name zu kurz für Benutzernamen (min. 3 Zeichen)'; hint.style.color = 'var(--red)'; return; }
  const taken = S.users.some(u => u.username === un);
  hint.textContent = 'Benutzername: ' + un + (taken ? ' (bereits vergeben)' : '');
  hint.style.color = taken ? 'var(--red)' : '';
}

/* ====================================================================
   Daten neu laden
   ==================================================================== */
async function reloadEntries() {
  const e = await API.getEntries();
  S.entries = e.entries;
}
async function reloadAbsences() {
  const a = await API.getAbsences();
  S.absences = a.absences;
}
async function reloadUsers() {
  const u = await API.getUsers();
  S.users = u.users;
  populateUserSelect();
}
async function reloadAll() {
  await reloadEntries();
  await reloadAbsences();
  await reloadUsers();
  renderView(S.selView);
}

/* ====================================================================
   Toast
   ==================================================================== */
let toastTimer = null;
function toast(msg, type = 'success') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ====================================================================
   Export
   ==================================================================== */
function toCSV(data) {
  const lines = [];
  lines.push('Zeiten');
  lines.push('Datum;Person;Typ;Start;Ende;Dauer(Min);Quelle;Notiz');
  (data.entries || []).forEach(e => {
    const u = (data.users || []).find(x => x.id === e.userId);
    lines.push(`"${e.date}";"${u ? u.name : e.userId}";"${e.type}";"${e.start}";"${e.end || ''}";${e.end ? timeToMin(e.end) - timeToMin(e.start) : ''};"${e.source === 'manual' ? 'manuell' : 'gestempelt'}";"${(e.note || '').replace(/"/g, '""')}"`);
  });
  lines.push('');
  lines.push('Abwesenheit');
  lines.push('Datum;Person;Typ;Status;Gutschrift;Notiz');
  (data.absences || []).forEach(a => {
    const u = (data.users || []).find(x => x.id === a.userId);
    lines.push(`"${a.date}";"${u ? u.name : a.userId}";"${a.type}";"${a.status === 'confirmed' ? 'bestätigt' : 'offen'}";"${a.credited ? 'ja' : 'nein'}";"${(a.note || '').replace(/"/g, '""')}"`);
  });
  lines.push('');
  lines.push('Personen');
  lines.push('Name;Benutzername;Rolle;Wochen-Soll(h);Stundenstand(h);Status');
  (data.users || []).forEach(u => {
    lines.push(`"${u.name}";"${u.username}";"${u.role}";${fmtHours(u.weeklyHours)};${fmtBalance(u.balance)};"${u.active !== false ? 'aktiv' : 'archiviert'}"`);
  });
  return lines.join('\r\n');
}

/* ====================================================================
   Esc
   ==================================================================== */
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/* ====================================================================
   Events
   ==================================================================== */
function bindEvents() {
  $('#loginForm').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
  $('#logoutBtn').addEventListener('click', doLogout);

  // Passwort anzeigen/verbergen
  const pwShow = $('#pwShow');
  const pwToggle = $('#pwToggle');
  const togglePw = (show) => {
    $('#loginPass').type = show ? 'text' : 'password';
  };
  pwShow.addEventListener('change', () => togglePw(pwShow.checked));
  pwToggle.addEventListener('click', () => {
    const show = $('#loginPass').type !== 'text';
    pwShow.checked = show;
    togglePw(show);
  });

  $('#notifBell').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotifDropdown();
  });
  $('#notifList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-nid]');
    if (item) markNotifRead(item.dataset.nid);
  });
  document.addEventListener('click', (e) => {
    const wrap = $('#notifWrap');
    if (wrap && !wrap.contains(e.target)) $('#notifDropdown').classList.add('hidden');
  });

  $$('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  // Manuelle Zeiterfassung im Team-Tab (überschreibt immer)
  $('#teamEntryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = $('#tUser').value;
    const date = $('#tDate').value;
    const type = $('#tType').value;
    const start = $('#tStart').value;
    const end = $('#tEnd').value;
    const note = $('#tNote').value.trim();
    if (!userId || !date || !start || !end) { alert('Person, Datum, Start und Ende ausfüllen.'); return; }
    if (timeToMin(end) <= timeToMin(start)) { alert('Ende muss nach Start liegen.'); return; }
    try {
      await API.createEntry({ userId, date, type, start, end, note, source: 'manual', overwrite: true });
      $('#tStart').value = '';
      $('#tEnd').value = '';
      $('#tNote').value = '';
      await reloadEntries();
      renderTeam();
      toast('Manueller Eintrag gespeichert (überschrieben)');
    } catch (e2) { alert(e2.message); }
  });

  // Abwesenheit-Formular (ein Datensatz für den ganzen Zeitraum)
  $('#absenceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = isMgmt() ? $('#aUser').value : S.me.id;
    const type = $('#aType').value;
    const from = $('#aFrom').value;
    const to = $('#aTo').value;
    const note = $('#aNote').value.trim();
    const credited = $('#aCredit').checked;
    if (!from) { alert('Startdatum ausfüllen.'); return; }
    if (to < from) { alert('Bis-Datum muss nach Von-Datum liegen.'); return; }
    try {
      await API.createAbsence({ userId, dateFrom: from, dateTo: to, type, note, credited: type === 'fehltag' ? credited : true });
      $('#aNote').value = '';
      $('#aTo').value = $('#aFrom').value;
      await reloadAbsences();
      renderAbsence();
      toast('Abwesenheit eingetragen');
    } catch (e2) { alert(e2.message); }
  });

  $('#aType').addEventListener('change', () => {
    const cf = $('#aCreditField');
    if (isAdmin() && $('#aType').value === 'fehltag') {
      cf.classList.remove('hidden');
    } else {
      cf.classList.add('hidden');
    }
  });

  // Person anlegen (Name = Benutzername)
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#uName').value.trim();
    const username = deriveUsername(name);
    const password = $('#uPass').value;
    const role = $('#uRole').value;
    const weeklyHours = parseHoursInput($('#uHours').value);
    const balance = parseHoursInput($('#uBalance').value);
    if (!name) { alert('Fehler im Feld „Name": Bitte Namen eingeben.'); return; }
    if (!password) { alert('Fehler im Feld „Passwort": Bitte Passwort eingeben.'); return; }
    if (password.length < 6) { alert('Fehler im Feld „Passwort": Mindestens 6 Zeichen.'); return; }
    if (isNaN(weeklyHours)) { alert('Fehler im Feld „Wochenstunden": Bitte HH:MM angeben (z. B. 38:30).'); return; }
    if (weeklyHours <= 0 || weeklyHours > 80) { alert('Fehler im Feld „Wochenstunden": Wert muss zwischen 0 und 80 Stunden liegen.'); return; }
    if (isNaN(balance)) { alert('Fehler im Feld „Stundenstand": Bitte HH:MM angeben (z. B. 10:00).'); return; }
    if (username.length < 3) { alert('Fehler im Feld „Name": Zu kurz für einen Benutzernamen (min. 3 Zeichen).'); return; }
    if (S.users.some(u => u.username === username)) { alert('Fehler im Feld „Name": Benutzername "' + username + '" ist bereits vergeben.'); return; }
    try {
      await API.createUser({ name, username, password, role, weeklyHours, balance });
      $('#uName').value = '';
      $('#uPass').value = '';
      $('#uRole').value = 'mitarbeiter';
      $('#uHours').value = '38:30';
      $('#uBalance').value = '0';
      updateUsernameHint('');
      await reloadUsers();
      renderPersonen();
      toast('Person angelegt');
    } catch (e2) { alert(e2.message); }
  });

  $('#uName').addEventListener('input', () => updateUsernameHint($('#uName').value.trim()));
  $('#euName').addEventListener('input', updateEditUsernameHint);

  // Wochen-Navigation
  $('#weekPrev').addEventListener('click', () => { S.myWeekOffset--; renderWoche(); });
  $('#weekNext').addEventListener('click', () => { S.myWeekOffset++; renderWoche(); });
  $('#weekTodayBtn').addEventListener('click', () => { S.myWeekOffset = 0; renderWoche(); });
  $('#teamPrev').addEventListener('click', () => { S.weekOffset--; renderTeam(); });
  $('#teamNext').addEventListener('click', () => { S.weekOffset++; renderTeam(); });
  $('#teamTodayBtn').addEventListener('click', () => { S.weekOffset = 0; renderTeam(); });

  // Dialog: Person bearbeiten
  $('#euSave').addEventListener('click', async () => {
    if (!editUserId) return;
    const u = S.users.find(x => x.id === editUserId);
    if (!u) return;
    const isSelf = editUserId === S.me.id;
    const name = $('#euName').value.trim();
    const weeklyHours = parseHoursInput($('#euHours').value);
    // Benutzername bleibt beim Bearbeiten STABIL – er wird nur beim Anlegen aus dem Namen abgeleitet
    if (!name) { alert('Fehler im Feld „Name": Bitte Namen eingeben.'); return; }
    if (isNaN(weeklyHours)) { alert('Fehler im Feld „Wochen-Soll": Bitte HH:MM angeben (z. B. 38:30).'); return; }
    if (weeklyHours <= 0 || weeklyHours > 80) { alert('Fehler im Feld „Wochen-Soll": Wert muss zwischen 0 und 80 Stunden liegen.'); return; }
    const payload = {
      name,
      weeklyHours,
    };
    if (!isSelf) {
      payload.role = $('#euRole').value;
      payload.active = $('#euStatus').value === 'true';
    }
    try {
      await API.updateUser(editUserId, payload);
      $('#editUserDialog').close();
      await reloadUsers();
      renderPersonen();
      toast('Änderungen gespeichert');
    } catch (e) { alert(e.message); }
  });

  // Dialog: Stunden hinzufügen / abziehen (Format HH:MM)
  $('#hoursApply').addEventListener('click', async () => {
    if (!hoursUserId) return;
    const amount = parseHoursInput($('#hoursAmount').value);
    if (!amount || amount <= 0) { alert('Fehler im Feld „Stunden": Bitte HH:MM angeben (z. B. 1:30 oder 2).'); return; }
    const u = S.users.find(x => x.id === hoursUserId);
    if (!u) return;
    const newBalance = (u.balance || 0) + (hoursSign > 0 ? amount : -amount);
    try {
      await API.updateUser(hoursUserId, { balance: newBalance });
      $('#hoursDialog').close();
      await reloadUsers();
      renderPersonen();
      toast((hoursSign > 0 ? '➕ ' : '➖ ') + fmtHours(amount) + ' h ' + (hoursSign > 0 ? 'hinzugefügt' : 'abgezogen'));
    } catch (e) { alert(e.message); }
  });
  $('#hoursAmount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#hoursApply').click(); }
  });

  // Dialog: Abwesenheit bearbeiten
  $('#aeSave').addEventListener('click', async () => {
    if (!absenceEditId) return;
    const a = S.absences.find(x => x.id === absenceEditId);
    if (!a) return;
    const payload = {
      dateFrom: $('#aeFrom').value,
      dateTo: $('#aeTo').value,
      type: $('#aeType').value,
      note: $('#aeNote').value.trim(),
    };
    if (isAdmin() && a.type === 'fehltag') payload.credited = $('#aeCredit').checked;
    if (payload.dateTo < payload.dateFrom) { alert('Bis-Datum muss nach Von-Datum liegen.'); return; }
    try {
      await API.updateAbsence(absenceEditId, payload);
      $('#absenceEditDialog').close();
      await reloadAbsences();
      renderAbsence();
      toast('Abwesenheit geändert');
    } catch (e) { alert(e.message); }
  });
  $('#aeType').addEventListener('change', () => {
    $('#aeCreditField').classList.toggle('hidden', !(isAdmin() && $('#aeType').value === 'fehltag'));
  });

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dlg = document.getElementById(btn.dataset.close);
      if (dlg && dlg.close) dlg.close();
    });
  });
  ['editUserDialog', 'hoursDialog', 'absenceEditDialog'].forEach(did => {
    const dlg = document.getElementById(did);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  });

  // Export
  $('#btnExportCsv').addEventListener('click', async () => {
    const from = $('#rFrom').value || undefined;
    const to = $('#rTo').value || undefined;
    try {
      const data = await API.exportData({ from, to });
      const csv = toCSV(data);
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'zeitaufnahme_export.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e.message); }
  });
  $('#btnExportJson').addEventListener('click', async () => {
    const from = $('#rFrom').value || undefined;
    const to = $('#rTo').value || undefined;
    try {
      const data = await API.exportData({ from, to });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'zeitaufnahme_export.json'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e.message); }
  });
}

/* ====================================================================
   Init
   ==================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await API.me();
    S.me = res.user;
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await initApp();
  } catch (e) {
    $('#loginScreen').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
  bindEvents();
});
