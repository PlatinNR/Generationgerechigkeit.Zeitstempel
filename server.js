'use strict';

/* ==========================================================================
   Zeitaufnahme · Stiftung Generationengerechtigkeit
   Node-Server: Statische Dateien + API + Cookie-Login + Rollenprüfung
   Daten liegen in data/data.json (ohne externe Pakete).
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const COOKIE_NAME = 'za_session';
const MAX_BODY = 1024 * 1024;

const ROLES = ['admin', 'manager', 'mitarbeiter'];
const ABSENCE_TYPES = ['urlaub', 'krank', 'fehltag'];
const ENTRY_TYPES = ['work', 'break'];

/* --------------------------------------------------------------------------
   Persistenz
   -------------------------------------------------------------------------- */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d.users) d.users = [];
    if (!d.sessions) d.sessions = {};
    if (!d.entries) d.entries = [];
    if (!d.absences) d.absences = [];
    if (!d.notifications) d.notifications = [];
    return d;
  } catch (e) {
    const d = { users: [], sessions: {}, entries: [], absences: [], notifications: [] };
    saveData(d);
    return d;
  }
}

function saveData(d) {
  ensureDataDir();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let DB = loadData();

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

/* --------------------------------------------------------------------------
   Benachrichtigungen
   -------------------------------------------------------------------------- */
function notify(userId, type, detail, refId) {
  DB.notifications.push({
    id: uid('n'),
    userId,
    type,
    detail: String(detail || ''),
    refId: String(refId || ''),
    read: false,
    createdAt: new Date().toISOString(),
  });
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }); }
  catch { return iso; }
}

/* --------------------------------------------------------------------------
   Datum + Wochenabrechnung
   -------------------------------------------------------------------------- */
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dateKeyS(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysS(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mondayOfS(d) {
  const x = startOfDay(d);
  const wd = (x.getDay() + 6) % 7;
  return addDaysS(x, -wd);
}

function dailyTargetMin(user) { return Math.round(user.weeklyHours * 60 / 5); }

function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/* Stunden akzeptiert als Zahl (40 oder 40.5) oder HH:MM-String ("40:00", "40:30") */
function parseHoursS(v) {
  if (typeof v === 'number') return isNaN(v) ? NaN : v;
  const s = String(v || '').trim().replace(',', '.');
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || m >= 60) return NaN;
    return h + m / 60;
  }
  return Number(s);
}

function sumEntryMinutes(userId, date, type) {
  return DB.entries
    .filter(e => e.userId === userId && e.date === date && e.type === type && e.end != null)
    .reduce((s, e) => s + Math.max(0, timeToMin(e.end) - timeToMin(e.start)), 0);
}

/* Wochen-Differenz einer abgeschlossenen Woche (Minuten) */
function weekDiffMinutes(user, monday) {
  const daily = dailyTargetMin(user);
  const soll = Math.round(user.weeklyHours * 60);
  let gut = 0;
  for (let i = 0; i < 7; i++) {
    const key = dateKeyS(addDaysS(monday, i));
    const w = sumEntryMinutes(user.id, key, 'work');
    const b = sumEntryMinutes(user.id, key, 'break');
    const abs = DB.absences.find(a => a.userId === user.id && a.dateFrom <= key && key <= a.dateTo);
    if (abs && abs.status === 'confirmed' && (abs.type === 'urlaub' || abs.type === 'krank' || abs.credited)) {
      gut += daily;
    } else if (abs && abs.status === 'confirmed' && abs.type === 'fehltag' && !abs.credited) {
      gut += 0; // nicht gutgeschriebener Fehltag = Fehlstunde
    } else if (abs && abs.status !== 'confirmed') {
      gut += 0; // offener Abwesenheit ist neutral
    } else {
      gut += Math.max(0, w - b);
    }
  }
  return gut - soll;
}

/* Abgeschlossene Wochen ins Konto buchen („Abrechnung am Wochenende").
   Nur Wochen, die vor der aktuellen Woche enden, werden verbucht. */
function settleWeeks() {
  const curMonday = mondayOfS(new Date());
  let changed = false;
  DB.users.forEach(user => {
    let m;
    const last = user.lastSettledMonday || null;
    if (!last) {
      // Neuanlage / Bestand ohne Abrechnungsmarke: starte mit der Vorwoche, lasse ältere Wochen unberührt
      m = addDaysS(curMonday, -7);
    } else {
      m = addDaysS(new Date(last + 'T00:00:00'), 7);
    }
    while (addDaysS(m, 7) <= curMonday) {
      const diff = weekDiffMinutes(user, m);
      if (diff !== 0) {
        // diff ist in Minuten – Konto (balance) wird in Stunden geführt
        user.balance = (user.balance || 0) + (diff / 60);
        changed = true;
      }
      user.lastSettledMonday = dateKeyS(m);
      m = addDaysS(m, 7);
    }
  });
  if (changed) saveData(DB);
}

/* --------------------------------------------------------------------------
   Passwörter (scrypt, eingebaut – keine externen Pakete)
   -------------------------------------------------------------------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

/* --------------------------------------------------------------------------
   Sitzungen
   -------------------------------------------------------------------------- */
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = { userId, createdAt: Date.now() };
  saveData(DB);
  return token;
}

function destroySession(token) {
  if (DB.sessions[token]) {
    delete DB.sessions[token];
    saveData(DB);
  }
}

function userForToken(token) {
  if (!token) return null;
  const s = DB.sessions[token];
  if (!s) return null;
  const u = DB.users.find(x => x.id === s.userId);
  if (!u || u.active === false) return null;
  return u;
}

/* --------------------------------------------------------------------------
   Standard-Admin anlegen (beim ersten Start)
   -------------------------------------------------------------------------- */
function ensureAdmin() {
  const admin = DB.users.find(u => u.role === 'admin');
  if (admin) return;
  const { salt, hash } = hashPassword('admin123');
  DB.users.push({
    id: uid('u'),
    username: 'admin',
    name: 'Administrator',
    role: 'admin',
    weeklyHours: 38.5,
    active: true,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    lastSettledMonday: dateKeyS(mondayOfS(new Date())),
  });
  saveData(DB);
  console.log('  [Setup] Standard-Admin angelegt:  admin / admin123');
}

/* --------------------------------------------------------------------------
   Öffentliche Nutzer-Ansicht (nie Passwort-/Salz-Daten)
   -------------------------------------------------------------------------- */
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    weeklyHours: u.weeklyHours,
    balance: u.balance || 0,
    active: u.active,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
  };
}

/* --------------------------------------------------------------------------
   Validierung
   -------------------------------------------------------------------------- */
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00')); }
function isTime(v) { return /^\d{2}:\d{2}(:\d{2})?$/.test(v); }
function isRole(r) { return ROLES.includes(r); }
function isAbsenceType(t) { return ABSENCE_TYPES.includes(t); }
function isEntryType(t) { return ENTRY_TYPES.includes(t); }

/* --------------------------------------------------------------------------
   HTTP-Helfer
   -------------------------------------------------------------------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJSON(res, code, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Zu große Anfrage'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* --------------------------------------------------------------------------
   Auth-Middleware
   -------------------------------------------------------------------------- */
function requireAuth(req, res) {
  const cookies = parseCookies(req);
  const user = userForToken(cookies[COOKIE_NAME]);
  if (!user) {
    sendError(res, 401, 'Nicht angemeldet');
    return null;
  }
  return user;
}

function requireRole(user, ...roles) {
  return roles.includes(user.role);
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */
function handleApi(req, res, url, body) {
  const { pathname } = url;
  const parts = pathname.split('/').filter(Boolean); // z. B. ["api","users","u1"]
  if (parts[0] !== 'api') return false;

  const seg = parts.slice(1); // nach "api"
  const base = seg[0] || '';
  const id = seg[1] || null;

  /* ---------- Auth ---------- */
  if (base === 'login' && req.method === 'POST') {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = DB.users.find(u => u.username.toLowerCase() === username && u.active !== false);
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      // Wurde mit einem ALTEN Passwort versucht? Dann Hinweis an den Nutzer.
      if (user) {
        const oldMatch = (user.passwordHistory || []).find(h => verifyPassword(password, h.salt, h.hash));
        if (oldMatch) {
          const already = (DB.notifications || []).some(n => n.userId === user.id && n.refId === oldMatch.id);
          if (!already) {
            notify(user.id, 'password-changed', oldMatch.changedAt, oldMatch.id);
            saveData(DB);
          }
          return sendError(res, 401, 'Ihr Passwort wurde geändert. Bitte verwenden Sie das neue Passwort (Änderung: ' + fmtDate(oldMatch.changedAt) + ').');
        }
      }
      return sendError(res, 401, 'Benutzername oder Passwort falsch');
    }
    user.lastLogin = new Date().toISOString();
    const token = createSession(user.id);
    saveData(DB);
    setCookie(res, token);
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (base === 'logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    destroySession(cookies[COOKIE_NAME]);
    clearCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  if (base === 'me' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return true;
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  /* ---------- Berechtigungen ---------- */
  const user = requireAuth(req, res);
  if (!user) return true;
  const isAdmin = user.role === 'admin';
  const isManager = user.role === 'manager';
  const isStaff = user.role === 'mitarbeiter';

  /* ---------- Nutzer ---------- */
  if (base === 'users') {
    if (req.method === 'GET') {
      // Mitarbeiter sehen nur ihre eigenen Daten, Manager/Admin alle
      if (isStaff) return sendJSON(res, 200, { users: [publicUser(user)] });
      return sendJSON(res, 200, { users: DB.users.map(publicUser) });
    }

    /* Passwort-Reset: POST /api/users/:id/password (nur Admin) */
    if (seg[2] === 'password' && req.method === 'POST') {
      const target = DB.users.find(u => u.id === seg[1]);
      if (!target) return sendError(res, 404, 'Person nicht gefunden');
      if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Passwörter zurücksetzen');
      const password = String(body.password || '');
      if (password.length < 6) return sendError(res, 400, 'Passwort muss mindestens 6 Zeichen haben');
      // Altes Passwort in die Historie übernehmen (für "altes Passwort"-Erkennung)
      target.passwordHistory = target.passwordHistory || [];
      target.passwordHistory.push({
        id: uid('h'),
        salt: target.salt,
        hash: target.passwordHash,
        changedAt: new Date().toISOString(),
        changedBy: user.name,
      });
      if (target.passwordHistory.length > 5) target.passwordHistory = target.passwordHistory.slice(-5);
      const { salt, hash } = hashPassword(password);
      target.salt = salt;
      target.passwordHash = hash;
      saveData(DB);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST') {
      if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Personen anlegen');
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const role = body.role;
      const weeklyHours = parseHoursS(body.weeklyHours);
      const balance = parseHoursS(body.balance);
      if (isNaN(balance)) balance = 0;

      if (!name) return sendError(res, 400, 'Name fehlt');
      if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return sendError(res, 400, 'Benutzername: 3–30 Zeichen (a-z, 0-9, _.-)');
      if (DB.users.some(u => u.username.toLowerCase() === username)) return sendError(res, 400, 'Benutzername existiert bereits');
      if (password.length < 6) return sendError(res, 400, 'Passwort muss mindestens 6 Zeichen haben');
      if (!isRole(role)) return sendError(res, 400, 'Rolle ungültig');
      if (!(weeklyHours > 0 && weeklyHours <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
      if (isNaN(balance) || Math.abs(balance) > 5000) return sendError(res, 400, 'Stundenstand ungültig');

      const { salt, hash } = hashPassword(password);
      const nu = {
        id: uid('u'),
        username,
        name,
        role,
        weeklyHours,
        balance,
        active: true,
        salt,
        passwordHash: hash,
        passwordHistory: [],
        createdAt: new Date().toISOString(),
        lastLogin: null,
        lastSettledMonday: dateKeyS(mondayOfS(new Date())), // Start: aktuelle Woche – ältere Wochen nicht verbuchen
      };
      DB.users.push(nu);
      saveData(DB);
      notify(nu.id, 'account-created', `${name}`);
      saveData(DB);
      return sendJSON(res, 201, { user: publicUser(nu) });
    }

    if (req.method === 'PUT' && id) {
      const target = DB.users.find(u => u.id === id);
      if (!target) return sendError(res, 404, 'Person nicht gefunden');

      if (isStaff) return sendError(res, 403, 'Keine Berechtigung');

      // Manager darf Name + Wochenstunden ändern, aber keine Rollen/Status/Username/Balance
      if (isManager) {
        if (body.role !== undefined || body.username !== undefined || body.active !== undefined || body.balance !== undefined) {
          return sendError(res, 403, 'Rolle/Status/Benutzername/Stundenstand nur vom Admin änderbar');
        }
        if (body.name !== undefined) {
          const name = String(body.name || '').trim();
          if (name) target.name = name;
        }
        if (body.weeklyHours !== undefined) {
          const w = parseHoursS(body.weeklyHours);
          if (!(w > 0 && w <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
          target.weeklyHours = w;
        }
        saveData(DB);
        return sendJSON(res, 200, { user: publicUser(target) });
      }

      // Admin: alles
      if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (name) target.name = name;
      }
      if (body.username !== undefined && body.username.toLowerCase() !== target.username.toLowerCase()) {
        const username = String(body.username || '').trim().toLowerCase();
        if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return sendError(res, 400, 'Benutzername ungültig');
        if (DB.users.some(u => u.username.toLowerCase() === username)) return sendError(res, 400, 'Benutzername existiert bereits');
        target.username = username;
      }
      if (body.role !== undefined) {
        if (!isRole(body.role)) return sendError(res, 400, 'Rolle ungültig');
        if (target.id === user.id && body.role !== 'admin' && countAdmins() <= 1) {
          return sendError(res, 400, 'Es muss mindestens einen Admin geben');
        }
        target.role = body.role;
      }
      if (body.weeklyHours !== undefined) {
        const w = parseHoursS(body.weeklyHours);
        if (!(w > 0 && w <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
        target.weeklyHours = w;
      }
      if (body.balance !== undefined) {
        const b = Number(body.balance);
        if (isNaN(b) || Math.abs(b) > 5000) return sendError(res, 400, 'Stundenstand ungültig');
        target.balance = b;
      }
      if (body.active !== undefined) {
        if (target.id === user.id && body.active === false) {
          return sendError(res, 400, 'Sie können sich nicht selbst deaktivieren');
        }
        if (target.role === 'admin' && body.active === false && countAdmins() <= 1) {
          return sendError(res, 400, 'Es muss mindestens einen aktiven Admin geben');
        }
        target.active = !!body.active;
      }
      saveData(DB);
      return sendJSON(res, 200, { user: publicUser(target) });
    }

    if (req.method === 'DELETE' && id) {
      if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Personen löschen');
      const target = DB.users.find(u => u.id === id);
      if (!target) return sendError(res, 404, 'Person nicht gefunden');
      if (target.id === user.id) return sendError(res, 400, 'Sie können sich nicht selbst löschen');
      if (target.role === 'admin' && countAdmins() <= 1) return sendError(res, 400, 'Es muss mindestens einen Admin geben');

      DB.users = DB.users.filter(u => u.id !== id);
      DB.entries = DB.entries.filter(e => e.userId !== id);
      DB.absences = DB.absences.filter(a => a.userId !== id);
      Object.keys(DB.sessions).forEach(t => {
        if (DB.sessions[t].userId === id) delete DB.sessions[t];
      });
      saveData(DB);
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ---------- Benachrichtigungen ---------- */
  if (base === 'notifications') {
    if (req.method === 'GET') {
      const list = DB.notifications
        .filter(n => n.userId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50);
      return sendJSON(res, 200, { notifications: list });
    }

    /* Als gelesen markieren: POST /api/notifications/:id/read */
    if (seg[2] === 'read' && req.method === 'POST') {
      const n = DB.notifications.find(x => x.id === seg[1]);
      if (!n) return sendError(res, 404, 'Benachrichtigung nicht gefunden');
      if (n.userId !== user.id) return sendError(res, 403, 'Keine Berechtigung');
      n.read = true;
      saveData(DB);
      return sendJSON(res, 200, { ok: true });
    }

    return sendError(res, 404, 'Unbekannter Endpunkt');
  }

  /* ---------- Einträge (Arbeit/Pause) ---------- */
  if (base === 'entries') {
    if (req.method === 'GET') {
      const urlParams = new URL(req.url, 'http://localhost').searchParams;
      let userId = urlParams.get('userId') || null;
      let from = urlParams.get('from') || null;
      let to = urlParams.get('to') || null;
      if (from && !isDate(from)) from = null;
      if (to && !isDate(to)) to = null;
      if (isStaff) userId = user.id; // Mitarbeiter sehen nur eigene Einträge
      let list = DB.entries.filter(e => !userId || e.userId === userId);
      if (from) list = list.filter(e => e.date >= from);
      if (to) list = list.filter(e => e.date <= to);
      return sendJSON(res, 200, { entries: list });
    }

    if (req.method === 'POST') {
      const targetUserId = body.userId || user.id;
      if (isStaff && targetUserId !== user.id) return sendError(res, 403, 'Sie können nur eigene Zeiten erfassen');
      // Mitarbeiter erfassen nur per Stechuhr (offene Einträge) – keine manuellen/abgeschlossenen Einträge
      if (isStaff && (body.source !== 'punch' || (body.end !== null && body.end !== undefined))) {
        return sendError(res, 403, 'Mitarbeiter können Zeiten nur per Stechuhr erfassen');
      }
      const target = DB.users.find(u => u.id === targetUserId);
      if (!target) return sendError(res, 400, 'Person nicht gefunden');
      if (!isDate(body.date)) return sendError(res, 400, 'Datum ungültig');
      if (!isEntryType(body.type)) return sendError(res, 400, 'Typ ungültig');
      if (!isTime(body.start)) return sendError(res, 400, 'Startzeit ungültig');
      if (body.end !== null && body.end !== undefined && !isTime(body.end)) return sendError(res, 400, 'Endzeit ungültig');

      // Manuelles Überschreiben durch Admin/Manager: bestehende Einträge ersetzen + benachrichtigen
      if (body.overwrite === true && body.source === 'manual' && (isAdmin || isManager)) {
        const existing = DB.entries.filter(en => en.userId === targetUserId && en.date === body.date && en.type === body.type);
        if (existing.length > 0) {
          DB.entries = DB.entries.filter(en => !existing.includes(en));
          notify(targetUserId, 'entry-overwritten', `${body.date} ${body.type === 'work' ? 'Arbeit' : 'Pause'}`);
          saveData(DB);
        }
      }

      const entry = {
        id: uid('e'),
        userId: targetUserId,
        date: body.date,
        type: body.type,
        start: body.start,
        end: body.end || null,
        note: String(body.note || '').slice(0, 300),
        source: body.source === 'manual' ? 'manual' : 'punch',
        createdAt: new Date().toISOString(),
      };
      DB.entries.push(entry);
      saveData(DB);
      return sendJSON(res, 201, { entry });
    }

    if (req.method === 'PUT' && id) {
      const entry = DB.entries.find(e => e.id === id);
      if (!entry) return sendError(res, 404, 'Eintrag nicht gefunden');
      if (isStaff && entry.userId !== user.id) return sendError(res, 403, 'Keine Berechtigung');
      // Mitarbeiter dürfen nur ihren offenen Stempel beenden (kein nachträgliches Ändern)
      if (isStaff) {
        if (entry.end != null) return sendError(res, 403, 'Abgeschlossene Einträge können Mitarbeiter nicht ändern');
        if (body.end == null) return sendError(res, 403, 'Nur das Beenden des Stempels ist möglich');
      }
      if (body.date !== undefined && !isDate(body.date)) return sendError(res, 400, 'Datum ungültig');
      if (body.type !== undefined && !isEntryType(body.type)) return sendError(res, 400, 'Typ ungültig');
      if (body.start !== undefined && !isTime(body.start)) return sendError(res, 400, 'Startzeit ungültig');
      if (body.end !== undefined && body.end !== null && !isTime(body.end)) return sendError(res, 400, 'Endzeit ungültig');
      if (body.date !== undefined) entry.date = body.date;
      if (body.type !== undefined) entry.type = body.type;
      if (body.start !== undefined) entry.start = body.start;
      if (body.end !== undefined) entry.end = body.end;
      if (body.note !== undefined) entry.note = String(body.note || '').slice(0, 300);
      saveData(DB);
      return sendJSON(res, 200, { entry });
    }

    if (req.method === 'DELETE' && id) {
      const entry = DB.entries.find(e => e.id === id);
      if (!entry) return sendError(res, 404, 'Eintrag nicht gefunden');
      if (isStaff && entry.userId !== user.id) return sendError(res, 403, 'Keine Berechtigung');
      DB.entries = DB.entries.filter(e => e.id !== id);
      saveData(DB);
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ---------- Abwesenheit (Urlaub/Krankheit/Fehltag) ---------- */
  if (base === 'absences') {
    if (req.method === 'GET') {
      const urlParams = new URL(req.url, 'http://localhost').searchParams;
      let userId = urlParams.get('userId') || null;
      let from = urlParams.get('from') || null;
      let to = urlParams.get('to') || null;
      if (from && !isDate(from)) from = null;
      if (to && !isDate(to)) to = null;
      if (isStaff) userId = user.id;
      let list = DB.absences.filter(a => !userId || a.userId === userId);
      if (from) list = list.filter(a => a.dateTo >= from);
      if (to) list = list.filter(a => a.dateFrom <= to);
      return sendJSON(res, 200, { absences: list });
    }

    /* Bestätigen (Admin/Manager) – auch rückwirkend möglich */
    if (seg[2] === 'confirm' && req.method === 'POST') {
      if (!isAdmin && !isManager) return sendError(res, 403, 'Nur Admin/Manager können bestätigen');
      const absence = DB.absences.find(a => a.id === seg[1]);
      if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
      absence.status = 'confirmed';
      saveData(DB);
      return sendJSON(res, 200, { absence });
    }

    if (req.method === 'POST') {
      const targetUserId = body.userId || user.id;
      if (isStaff && targetUserId !== user.id) return sendError(res, 403, 'Sie können nur eigene Abwesenheit eintragen');
      const target = DB.users.find(u => u.id === targetUserId);
      if (!target) return sendError(res, 400, 'Person nicht gefunden');
      const dateFrom = body.date || body.dateFrom;
      const dateTo = body.dateTo || dateFrom;
      if (!isDate(dateFrom) || !isDate(dateTo)) return sendError(res, 400, 'Datum ungültig');
      if (dateTo < dateFrom) return sendError(res, 400, 'Bis-Datum muss nach Von-Datum liegen');
      if (!isAbsenceType(body.type)) return sendError(res, 400, 'Typ ungültig');

      // Gutschrift: Urlaub/Krankheit immer gutgeschrieben; Fehltag nur wenn Admin dies setzt
      let credited = true;
      if (body.type === 'fehltag') {
        credited = isAdmin ? !!body.credited : false;
      }
      // Alle Abwesenheit starten als "offen" – auch von Admin/Manager, Bestätigung ist immer manuell
      const absence = {
        id: uid('a'),
        userId: targetUserId,
        dateFrom,
        dateTo,
        type: body.type,
        credited,
        status: 'pending',
        note: String(body.note || '').slice(0, 300),
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      };
      DB.absences.push(absence);
      saveData(DB);
      return sendJSON(res, 201, { absence });
    }

    if (req.method === 'PUT' && id) {
      const absence = DB.absences.find(a => a.id === id);
      if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
      const isOwner = absence.userId === user.id;
      if (isStaff && !isOwner) return sendError(res, 403, 'Keine Berechtigung');

      // Mitarbeiter dürfen nur eigene OFFENE Abwesenheit ändern (ohne Status/Gutschrift)
      if (isStaff) {
        if (absence.status !== 'pending') return sendError(res, 403, 'Bestätigte Abwesenheit können Mitarbeiter nicht ändern');
        if (body.status !== undefined || body.credited !== undefined) return sendError(res, 403, 'Nur Admin/Manager ändern Status/Gutschrift');
      }

      if (body.dateFrom !== undefined || body.dateTo !== undefined || body.date !== undefined) {
        const df = body.dateFrom || body.date || absence.dateFrom;
        const dt = body.dateTo || df;
        if (!isDate(df) || !isDate(dt)) return sendError(res, 400, 'Datum ungültig');
        if (dt < df) return sendError(res, 400, 'Bis-Datum muss nach Von-Datum liegen');
        absence.dateFrom = df;
        absence.dateTo = dt;
      }
      if (body.type !== undefined) {
        if (!isAbsenceType(body.type)) return sendError(res, 400, 'Typ ungültig');
        absence.type = body.type;
      }
      if (body.note !== undefined && (isOwner || isAdmin || isManager)) {
        absence.note = String(body.note || '').slice(0, 300);
      }
      if (body.credited !== undefined && isAdmin) {
        absence.credited = !!body.credited;
      } else if (body.credited !== undefined && !isAdmin) {
        return sendError(res, 403, 'Nur der Admin steuert die Gutschrift');
      }
      if (body.status !== undefined) {
        if (!isAdmin && !isManager) return sendError(res, 403, 'Nur Admin/Manager können bestätigen');
        if (body.status !== 'confirmed' && body.status !== 'pending') return sendError(res, 400, 'Status ungültig');
        absence.status = body.status;
      }
      saveData(DB);
      return sendJSON(res, 200, { absence });
    }

    if (req.method === 'DELETE' && id) {
      const absence = DB.absences.find(a => a.id === id);
      if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
      if (isStaff && (absence.userId !== user.id || absence.status === 'confirmed')) {
        return sendError(res, 403, 'Nicht erlaubt');
      }
      DB.absences = DB.absences.filter(a => a.id !== id);
      saveData(DB);
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* ---------- Bericht / Export ---------- */
  if (base === 'export' && req.method === 'GET') {
    if (isStaff) return sendError(res, 403, 'Keine Berechtigung');
    const urlParams = new URL(req.url, 'http://localhost').searchParams;
    const from = urlParams.get('from') || null;
    const to = urlParams.get('to') || null;
    let entries = DB.entries.slice();
    let absences = DB.absences.slice();
    if (from) { entries = entries.filter(e => e.date >= from); absences = absences.filter(a => a.dateTo >= from); }
    if (to) { entries = entries.filter(e => e.date <= to); absences = absences.filter(a => a.dateFrom <= to); }
    const users = DB.users.map(publicUser);
    return sendJSON(res, 200, { users, entries, absences });
  }

  return sendError(res, 404, 'Unbekannter API-Endpunkt');
}

function countAdmins() {
  return DB.users.filter(u => u.role === 'admin' && u.active !== false).length;
}

/* --------------------------------------------------------------------------
   Cookies
   -------------------------------------------------------------------------- */
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/* --------------------------------------------------------------------------
   Statische Dateien
   -------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end();
    return;
  }
  if (path.basename(filePath).startsWith('.')) {
    res.writeHead(403); res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>Datei nicht gefunden.</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

/* --------------------------------------------------------------------------
   Server
   -------------------------------------------------------------------------- */
ensureAdmin();
settleWeeks();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    settleWeeks(); // Wochenabrechnung (buchung abgeschlossener Wochen ins Konto)
    if (req.method === 'POST' || req.method === 'PUT') {
      readBody(req)
        .then(body => handleApi(req, res, url, body))
        .catch(err => sendError(res, 400, err.message));
      return;
    }
    handleApi(req, res, url, {});
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ================================================');
  console.log('   Zeitaufnahme · Stiftung Generationengerechtigkeit');
  console.log(`   Läuft auf http://localhost:${PORT}`);
  console.log('   Standard-Admin: admin / admin123');
  console.log('   Daten: data/data.json');
  console.log('  ================================================');
  console.log('');
});
