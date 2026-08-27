'use strict';

/* ==========================================================================
   Zeitaufnahme · Vercel-Serverless-API
   Alle Routen unter /api/... (catch-all) · Daten in Supabase
   ========================================================================== */

const crypto = require('crypto');
const db = require('../lib/db');

/* --------------------------------------------------------------------------
   Hilfsfunktionen
   -------------------------------------------------------------------------- */
function uid(prefix) { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00')); }
function isTime(v) { return /^\d{2}:\d{2}(:\d{2})?$/.test(v); }
function isRole(r) { return ['admin', 'manager', 'mitarbeiter'].includes(r); }
function isAbsenceType(t) { return ['urlaub', 'krank', 'fehltag'].includes(t); }
function isEntryType(t) { return ['work', 'break'].includes(t); }

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
function timeToMin(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }

/* --------------------------------------------------------------------------
   Tagesabrechnung (verbucht jeden abgeschlossenen Werktag ins Konto)
   - Werktag (Mo–Fr): Arbeit − Tages-Soll (z. B. 8:00 bei 40h-Woche)
   - Samstag/Sonntag: kein Soll, kein Beitrag
   -------------------------------------------------------------------------- */
function dayDiffMinutes(user, date, entries, absences) {
  const key = dateKeyS(date);
  const dow = date.getDay(); // 0=So, 6=Sa
  if (dow === 0 || dow === 6) return 0; // Wochenende
  const daily = Math.round(user.weeklyHours * 60 / 5);
  const w = entries.filter(e => e.userId === user.id && e.date === key && e.type === 'work' && e.end != null)
    .reduce((s, e) => s + Math.max(0, timeToMin(e.end) - timeToMin(e.start)), 0);
  const b = entries.filter(e => e.userId === user.id && e.date === key && e.type === 'break' && e.end != null)
    .reduce((s, e) => s + Math.max(0, timeToMin(e.end) - timeToMin(e.start)), 0);
  const abs = absences.find(a => a.userId === user.id && a.dateFrom <= key && key <= a.dateTo);
  if (abs && abs.status === 'confirmed' && (abs.type === 'urlaub' || abs.type === 'krank' || abs.credited)) {
    return 0; // bestätigt = ausgeglichen
  }
  if (abs && abs.status === 'confirmed' && abs.type === 'fehltag' && !abs.credited) {
    return -daily; // nicht gutgeschriebener Fehltag = Fehlstunde
  }
  if (abs && abs.status !== 'confirmed') {
    return 0; // offener Fehlgrund = neutral
  }
  return (w - b) - daily; // Arbeit − Tages-Soll
}

async function settleDays() {
  const users = await db.listUsers();
  if (!users.length) return;
  const entries = await db.listEntries();
  const absences = await db.listAbsences();
  const today = dateKeyS(new Date());

  for (const user of users) {
    let cur = user.lastSettledDay
      ? addDaysS(new Date(user.lastSettledDay + 'T00:00:00'), 1)
      : addDaysS(new Date(today + 'T00:00:00'), -1);
    let changed = false;
    while (dateKeyS(cur) < today) {
      const diff = dayDiffMinutes(user, cur, entries, absences);
      if (diff !== 0) {
        user.balance = (user.balance || 0) + diff / 60;
        changed = true;
      }
      user.lastSettledDay = dateKeyS(cur);
      changed = true;
      cur = addDaysS(cur, 1);
    }
    if (changed) {
      await db.updateUser(user.id, { balance: user.balance, last_settled_day: user.lastSettledDay });
    }
  }
}

/* --------------------------------------------------------------------------
   HTTP-Helfer
   -------------------------------------------------------------------------- */
function sendJSON(res, code, obj) {
  res.status(code).json(obj);
}
function sendError(res, code, message) {
  sendJSON(res, code, { error: message });
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

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `za_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'za_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

async function requireAuth(req) {
  const cookies = parseCookies(req);
  if (!cookies.za_session) return null;
  const sess = await db.findSession(cookies.za_session);
  if (!sess || !sess.user || sess.user.active === false) return null;
  return sess.user;
}

function countAdmins(users) {
  return users.filter(u => u.role === 'admin' && u.active !== false).length;
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */
async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      return sendError(res, 404, 'Nicht gefunden');
    }
    const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    const base = seg[0] || '';
    const id = seg[1] || null;
    const body = (req.method === 'POST' || req.method === 'PUT') ? (req.body || {}) : {};

    /* ---------- Auth ---------- */
    if (base === 'login' && req.method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = await db.findUserByUsername(username);
      if (!user || user.active === false || !verifyPassword(password, user.salt, user.passwordHash)) {
        if (user) {
          const oldMatch = (user.passwordHistory || []).find(h => verifyPassword(password, h.salt, h.hash));
          if (oldMatch) {
            const existing = await db.listNotifications(user.id);
            const already = existing.some(n => n.refId === oldMatch.id);
            if (!already) {
              await db.createNotification({ id: uid('n'), userId: user.id, type: 'password-changed', detail: oldMatch.changedAt, refId: oldMatch.id });
            }
            const d = new Date(oldMatch.changedAt);
            const ds = isNaN(d.getTime()) ? oldMatch.changedAt : d.toLocaleDateString('de-DE');
            return sendError(res, 401, `Ihr Passwort wurde geändert. Bitte verwenden Sie das neue Passwort (Änderung: ${ds}).`);
          }
        }
        return sendError(res, 401, 'Benutzername oder Passwort falsch');
      }
      const token = crypto.randomBytes(24).toString('hex');
      await db.createSession(token, user.id);
      await db.updateUser(user.id, { last_login: new Date().toISOString() });
      setCookie(res, token);
      return sendJSON(res, 200, { user: db.publicUser(user) });
    }

    if (base === 'logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.za_session) await db.destroySession(cookies.za_session);
      clearCookie(res);
      return sendJSON(res, 200, { ok: true });
    }

    if (base === 'me' && req.method === 'GET') {
      const user = await requireAuth(req);
      if (!user) return sendError(res, 401, 'Nicht angemeldet');
      return sendJSON(res, 200, { user: db.publicUser(user) });
    }

    const user = await requireAuth(req);
    if (!user) return sendError(res, 401, 'Nicht angemeldet');
    // Tagesabrechnung: abgeschlossene Werktage ins Konto buchen
    await settleDays();
    const isAdmin = user.role === 'admin';
    const isManager = user.role === 'manager';
    const isStaff = user.role === 'mitarbeiter';

    /* ---------- Benachrichtigungen ---------- */
    if (base === 'notifications') {
      if (req.method === 'GET') {
        const list = await db.listNotifications(user.id);
        return sendJSON(res, 200, { notifications: list });
      }
      if (seg[2] === 'read' && req.method === 'POST') {
        const n = (await db.listNotifications(user.id)).find(x => x.id === seg[1]);
        if (!n) return sendError(res, 404, 'Benachrichtigung nicht gefunden');
        await db.markNotificationRead(n.id);
        return sendJSON(res, 200, { ok: true });
      }
      return sendError(res, 404, 'Unbekannter Endpunkt');
    }

    /* ---------- Nutzer ---------- */
    if (base === 'users') {
      if (req.method === 'GET') {
        if (isStaff) {
          return sendJSON(res, 200, { users: [db.publicUser(user)] });
        }
        const users = await db.listUsers();
        return sendJSON(res, 200, { users: users.map(db.publicUser) });
      }

      /* Passwort-Reset: POST /api/users/:id/password (nur Admin) */
      if (seg[2] === 'password' && req.method === 'POST') {
        const target = await db.findUserById(seg[1]);
        if (!target) return sendError(res, 404, 'Person nicht gefunden');
        if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Passwörter zurücksetzen');
        const password = String(body.password || '');
        if (password.length < 6) return sendError(res, 400, 'Passwort muss mindestens 6 Zeichen haben');
        const { salt, hash } = hashPassword(password);
        const history = [...(target.passwordHistory || []), {
          id: uid('h'), salt: target.salt, hash: target.passwordHash,
          changedAt: new Date().toISOString(), changedBy: user.name,
        }].slice(-5);
        await db.updateUser(target.id, { salt, password_hash: hash, password_history: history });
        return sendJSON(res, 200, { ok: true });
      }

      if (req.method === 'POST') {
        if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Personen anlegen');
        const name = String(body.name || '').trim();
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');
        const role = body.role;
        const weeklyHours = parseHoursS(body.weeklyHours);
        let balance = parseHoursS(body.balance);
        if (isNaN(balance)) balance = 0;

        if (!name) return sendError(res, 400, 'Name fehlt');
        if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return sendError(res, 400, 'Benutzername: 3–30 Zeichen (a-z, 0-9, _.-)');
        const existing = await db.findUserByUsername(username);
        if (existing) return sendError(res, 400, 'Benutzername existiert bereits');
        if (password.length < 6) return sendError(res, 400, 'Passwort muss mindestens 6 Zeichen haben');
        if (!isRole(role)) return sendError(res, 400, 'Rolle ungültig');
        if (!(weeklyHours > 0 && weeklyHours <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
        if (isNaN(balance) || Math.abs(balance) > 5000) return sendError(res, 400, 'Stundenstand ungültig');

        const { salt, hash } = hashPassword(password);
        const nu = await db.createUser({
          id: uid('u'), username, name, role, weeklyHours, balance,
          salt, passwordHash: hash, passwordHistory: [],
          lastSettledMonday: dateKeyS(mondayOfS(new Date())),
          lastSettledDay: dateKeyS(new Date()),
        });
        await db.createNotification({ id: uid('n'), userId: nu.id, type: 'account-created', detail: name });
        return sendJSON(res, 201, { user: nu });
      }

      if (req.method === 'PUT' && id) {
        const target = await db.findUserById(id);
        if (!target) return sendError(res, 404, 'Person nicht gefunden');
        if (isStaff) return sendError(res, 403, 'Keine Berechtigung');

        if (isManager) {
          if (body.role !== undefined || body.username !== undefined || body.active !== undefined || body.balance !== undefined) {
            return sendError(res, 403, 'Rolle/Status/Benutzername/Stundenstand nur vom Admin änderbar');
          }
          const fields = {};
          if (body.name !== undefined && String(body.name).trim()) fields.name = String(body.name).trim();
          if (body.weeklyHours !== undefined) {
            const w = parseHoursS(body.weeklyHours);
            if (!(w > 0 && w <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
            fields.weekly_hours = w;
          }
          if (Object.keys(fields).length) await db.updateUser(id, fields);
          const updated = await db.findUserById(id);
          return sendJSON(res, 200, { user: db.publicUser(updated) });
        }

        const fields = {};
        if (body.name !== undefined && String(body.name).trim()) fields.name = String(body.name).trim();
        if (body.username !== undefined && String(body.username).trim().toLowerCase() !== target.username.toLowerCase()) {
          const username = String(body.username).trim().toLowerCase();
          if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return sendError(res, 400, 'Benutzername ungültig');
          const exists = await db.findUserByUsername(username);
          if (exists) return sendError(res, 400, 'Benutzername existiert bereits');
          fields.username = username;
        }
        if (body.role !== undefined) {
          if (!isRole(body.role)) return sendError(res, 400, 'Rolle ungültig');
          if (target.id === user.id && body.role !== 'admin') {
            const users = await db.listUsers();
            if (countAdmins(users) <= 1) return sendError(res, 400, 'Es muss mindestens einen Admin geben');
          }
          fields.role = body.role;
        }
        if (body.weeklyHours !== undefined) {
          const w = parseHoursS(body.weeklyHours);
          if (!(w > 0 && w <= 80)) return sendError(res, 400, 'Wochenstunden zwischen 0 und 80 (Format z. B. 40:00)');
          fields.weekly_hours = w;
        }
        if (body.balance !== undefined) {
          const b = parseHoursS(body.balance);
          if (isNaN(b) || Math.abs(b) > 5000) return sendError(res, 400, 'Stundenstand ungültig');
          fields.balance = b;
        }
        if (body.active !== undefined) {
          if (target.id === user.id && body.active === false) return sendError(res, 400, 'Sie können sich nicht selbst deaktivieren');
          if (target.role === 'admin' && body.active === false) {
            const users = await db.listUsers();
            if (countAdmins(users) <= 1) return sendError(res, 400, 'Es muss mindestens einen aktiven Admin geben');
          }
          fields.active = !!body.active;
        }
        if (Object.keys(fields).length) await db.updateUser(id, fields);
        const updated = await db.findUserById(id);
        return sendJSON(res, 200, { user: db.publicUser(updated) });
      }

      if (req.method === 'DELETE' && id) {
        if (!isAdmin) return sendError(res, 403, 'Nur der Admin kann Personen löschen');
        const target = await db.findUserById(id);
        if (!target) return sendError(res, 404, 'Person nicht gefunden');
        if (target.id === user.id) return sendError(res, 400, 'Sie können sich nicht selbst löschen');
        if (target.role === 'admin') {
          const users = await db.listUsers();
          if (countAdmins(users) <= 1) return sendError(res, 400, 'Es muss mindestens einen Admin geben');
        }
        await db.deleteUser(id); // cascade löscht sessions/entries/absences/notifications
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ---------- Einträge (Arbeit/Pause) ---------- */
    if (base === 'entries') {
      if (req.method === 'GET') {
        const params = url.searchParams;
        let userId = params.get('userId') || null;
        let from = params.get('from') || null;
        let to = params.get('to') || null;
        if (isStaff) userId = user.id;
        const list = await db.listEntries({ userId, from, to });
        return sendJSON(res, 200, { entries: list });
      }

      if (req.method === 'POST') {
        const targetUserId = body.userId || user.id;
        if (isStaff && targetUserId !== user.id) return sendError(res, 403, 'Sie können nur eigene Zeiten erfassen');
        if (isStaff && (body.source !== 'punch' || (body.end !== null && body.end !== undefined))) {
          return sendError(res, 403, 'Mitarbeiter können Zeiten nur per Stechuhr erfassen');
        }
        if (!isDate(body.date)) return sendError(res, 400, 'Datum ungültig');
        // Samstag/Sonntag: keine Arbeit möglich
        const dow = new Date(body.date + 'T00:00:00').getDay();
        if (dow === 0 || dow === 6) return sendError(res, 400, 'Am Wochenende kann nicht gearbeitet werden');
        if (!isEntryType(body.type)) return sendError(res, 400, 'Typ ungültig');
        if (!isTime(body.start)) return sendError(res, 400, 'Startzeit ungültig');
        if (body.end !== null && body.end !== undefined && !isTime(body.end)) return sendError(res, 400, 'Endzeit ungültig');

        if (body.overwrite === true && body.source === 'manual' && (isAdmin || isManager)) {
          const existing = await db.listEntries({ userId: targetUserId });
          const toRemove = existing.filter(en => en.date === body.date && en.type === body.type);
          for (const en of toRemove) await db.deleteEntry(en.id);
          if (toRemove.length) {
            await db.createNotification({ id: uid('n'), userId: targetUserId, type: 'entry-overwritten', detail: `${body.date} ${body.type === 'work' ? 'Arbeit' : 'Pause'}` });
          }
        }

        const entry = await db.createEntry({
          id: uid('e'), userId: targetUserId, date: body.date,
          type: body.type, start: body.start, end: body.end || null,
          note: String(body.note || '').slice(0, 300),
          source: body.source === 'manual' ? 'manual' : 'punch',
        });
        return sendJSON(res, 201, { entry });
      }

      if (req.method === 'PUT' && id) {
        const all = await db.listEntries({});
        const entry = all.find(e => e.id === id);
        if (!entry) return sendError(res, 404, 'Eintrag nicht gefunden');
        if (isStaff && entry.userId !== user.id) return sendError(res, 403, 'Keine Berechtigung');
        if (isStaff) {
          if (entry.end != null) return sendError(res, 403, 'Abgeschlossene Einträge können Mitarbeiter nicht ändern');
          if (body.end == null) return sendError(res, 403, 'Nur das Beenden des Stempels ist möglich');
        }
        const fields = {};
        if (body.date !== undefined && isDate(body.date)) fields.date = body.date;
        if (body.type !== undefined && isEntryType(body.type)) fields.type = body.type;
        if (body.start !== undefined && isTime(body.start)) fields.start = body.start;
        if (body.end !== undefined && (body.end === null || isTime(body.end))) fields.end = body.end;
        if (body.note !== undefined) fields.note = String(body.note || '').slice(0, 300);
        const updated = await db.updateEntry(id, fields);
        return sendJSON(res, 200, { entry: updated });
      }

      if (req.method === 'DELETE' && id) {
        const all = await db.listEntries({});
        const entry = all.find(e => e.id === id);
        if (!entry) return sendError(res, 404, 'Eintrag nicht gefunden');
        if (isStaff && entry.userId !== user.id) return sendError(res, 403, 'Keine Berechtigung');
        await db.deleteEntry(id);
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ---------- Abwesenheiten ---------- */
    if (base === 'absences') {
      if (req.method === 'GET') {
        const params = url.searchParams;
        let userId = params.get('userId') || null;
        let from = params.get('from') || null;
        let to = params.get('to') || null;
        if (isStaff) userId = user.id;
        const list = await db.listAbsences({ userId, from, to });
        return sendJSON(res, 200, { absences: list });
      }

      /* Bestätigen */
      if (seg[2] === 'confirm' && req.method === 'POST') {
        if (!isAdmin && !isManager) return sendError(res, 403, 'Nur Admin/Manager können bestätigen');
        const all = await db.listAbsences({});
        const absence = all.find(a => a.id === seg[1]);
        if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
        const updated = await db.updateAbsence(absence.id, { status: 'confirmed' });
        return sendJSON(res, 200, { absence: updated });
      }

      if (req.method === 'POST') {
        const targetUserId = body.userId || user.id;
        if (isStaff && targetUserId !== user.id) return sendError(res, 403, 'Sie können nur eigene Abwesenheiten eintragen');
        const dateFrom = body.date || body.dateFrom;
        const dateTo = body.dateTo || dateFrom;
        if (!isDate(dateFrom) || !isDate(dateTo)) return sendError(res, 400, 'Datum ungültig');
        if (dateTo < dateFrom) return sendError(res, 400, 'Bis-Datum muss nach Von-Datum liegen');
        if (!isAbsenceType(body.type)) return sendError(res, 400, 'Typ ungültig');

        let credited = true;
        if (body.type === 'fehltag') credited = isAdmin ? !!body.credited : false;
        const absence = await db.createAbsence({
          id: uid('a'), userId: targetUserId, dateFrom, dateTo,
          type: body.type, credited, status: 'pending',
          note: String(body.note || '').slice(0, 300), createdBy: user.id,
        });
        return sendJSON(res, 201, { absence });
      }

      if (req.method === 'PUT' && id) {
        const all = await db.listAbsences({});
        const absence = all.find(a => a.id === id);
        if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
        const isOwner = absence.userId === user.id;
        if (isStaff && !isOwner) return sendError(res, 403, 'Keine Berechtigung');
        if (isStaff) {
          if (absence.status !== 'pending') return sendError(res, 403, 'Bestätigte Abwesenheiten können Mitarbeiter nicht ändern');
          if (body.status !== undefined || body.credited !== undefined) return sendError(res, 403, 'Nur Admin/Manager ändern Status/Gutschrift');
        }
        const fields = {};
        if (body.dateFrom !== undefined || body.dateTo !== undefined || body.date !== undefined) {
          const df = body.dateFrom || body.date || absence.dateFrom;
          const dt = body.dateTo || df;
          if (!isDate(df) || !isDate(dt)) return sendError(res, 400, 'Datum ungültig');
          if (dt < df) return sendError(res, 400, 'Bis-Datum muss nach Von-Datum liegen');
          fields.date_from = df;
          fields.date_to = dt;
        }
        if (body.type !== undefined && isAbsenceType(body.type)) fields.type = body.type;
        if (body.note !== undefined && (isOwner || isAdmin || isManager)) fields.note = String(body.note || '').slice(0, 300);
        if (body.credited !== undefined && isAdmin) fields.credited = !!body.credited;
        else if (body.credited !== undefined && !isAdmin) return sendError(res, 403, 'Nur der Admin steuert die Gutschrift');
        if (body.status !== undefined) {
          if (!isAdmin && !isManager) return sendError(res, 403, 'Nur Admin/Manager können bestätigen');
          if (!['confirmed', 'pending'].includes(body.status)) return sendError(res, 400, 'Status ungültig');
          fields.status = body.status;
        }
        const updated = await db.updateAbsence(id, fields);
        return sendJSON(res, 200, { absence: updated });
      }

      if (req.method === 'DELETE' && id) {
        const all = await db.listAbsences({});
        const absence = all.find(a => a.id === id);
        if (!absence) return sendError(res, 404, 'Abwesenheit nicht gefunden');
        if (isStaff && (absence.userId !== user.id || absence.status === 'confirmed')) return sendError(res, 403, 'Nicht erlaubt');
        await db.deleteAbsence(id);
        return sendJSON(res, 200, { ok: true });
      }
    }

    /* ---------- Export ---------- */
    if (base === 'export' && req.method === 'GET') {
      if (isStaff) return sendError(res, 403, 'Keine Berechtigung');
      const from = url.searchParams.get('from') || null;
      const to = url.searchParams.get('to') || null;
      const users = (await db.listUsers()).map(db.publicUser);
      const entries = await db.listEntries({ from, to });
      const absences = await db.listAbsences({ from, to });
      return sendJSON(res, 200, { users, entries, absences });
    }

    return sendError(res, 404, 'Unbekannter API-Endpunkt');
  } catch (err) {
    console.error('API-Fehler:', err);
    return sendError(res, 500, 'Interner Serverfehler');
  }
}

module.exports = handler;
module.exports.config = { runtime: 'nodejs' };