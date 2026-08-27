'use strict';

/* ==========================================================================
   DB-Client + Mapping Supabase ↔ API (camelCase ↔ snake_case)
   ========================================================================== */

const { createClient } = require('@supabase/supabase-js');

let _db = null;
function getDb() {
  if (!_db) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY müssen gesetzt sein');
    _db = createClient(url, key);
  }
  return _db;
}

/* --------------------------------------------------------------------------
   Mapping: Datenbank-Spalten (snake_case) → API-Objekte (camelCase)
   -------------------------------------------------------------------------- */
const USER_MAP = {
  id:1, username:1, name:1, role:1,
  weekly_hours:'weeklyHours', balance:1, active:1,
  salt:1, password_hash:'passwordHash',
  password_history:'passwordHistory',
  last_settled_monday:'lastSettledMonday',
  created_at:'createdAt', last_login:'lastLogin',
};

const ENTRY_MAP = {
  id:1, user_id:'userId', date:1, type:1, start:1,
  end:1, note:1, source:1, created_at:'createdAt',
};

const ABSENCE_MAP = {
  id:1, user_id:'userId', date_from:'dateFrom', date_to:'dateTo',
  type:1, credited:1, status:1, note:1,
  created_by:'createdBy', created_at:'createdAt',
};

const NOTIF_MAP = {
  id:1, user_id:'userId', type:1, detail:1,
  ref_id:'refId', read:1, created_at:'createdAt',
};

function mapRow(row, map) {
  if (!row) return null;
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const key = map[col] === 1 ? col : map[col];
    out[key] = val;
  }
  return out;
}

function mapList(rows, map) {
  return (rows || []).map(r => mapRow(r, map));
}

/* Public user: nimmt EIN BEREITS gemapptes (camelCase-)Objekt und entfernt sensible Felder */
function publicUser(u) {
  if (!u) return null;
  const out = { ...u };
  delete out.salt;
  delete out.passwordHash;
  delete out.passwordHistory;
  return out;
}

/* --------------------------------------------------------------------------
   DB-Operationen
   -------------------------------------------------------------------------- */
const db = () => getDb();

/* ── Nutzer ── */
async function listUsers() {
  const { data, error } = await db().from('users').select('*').order('name');
  if (error) throw error;
  return mapList(data, USER_MAP);
}

async function findUserByUsername(username) {
  const { data, error } = await db().from('users').select('*').eq('username', username).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data ? mapRow(data, USER_MAP) : null;
}

async function findUserById(id) {
  const { data, error } = await db().from('users').select('*').eq('id', id).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data ? mapRow(data, USER_MAP) : null;
}

async function createUser(user) {
  const { data, error } = await db().from('users').insert({
    id: user.id, username: user.username, name: user.name,
    role: user.role, weekly_hours: user.weeklyHours, balance: user.balance || 0,
    active: user.active !== false, salt: user.salt, password_hash: user.passwordHash,
    password_history: user.passwordHistory || '[]',
    last_settled_monday: user.lastSettledMonday || null,
  }).select().single();
  if (error) throw error;
  return publicUser(mapRow(data, USER_MAP));
}

async function updateUser(id, fields) {
  const { data, error } = await db().from('users').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return publicUser(mapRow(data, USER_MAP));
}

async function deleteUser(id) {
  const { error } = await db().from('users').delete().eq('id', id);
  if (error) throw error;
}

/* ── Sitzungen ── */
async function createSession(token, userId) {
  const { error } = await db().from('sessions').insert({ token, user_id: userId });
  if (error) throw error;
}

async function destroySession(token) {
  await db().from('sessions').delete().eq('token', token);
}

async function findSession(token) {
  const { data, error } = await db()
    .from('sessions').select('*, users!inner(*)')
    .eq('token', token).single();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return { user: mapRow(data.users, USER_MAP) };
}

/* ── Einträge ── */
async function listEntries({ userId, from, to } = {}) {
  let q = db().from('entries').select('*').order('date').order('start');
  if (userId) q = q.eq('user_id', userId);
  if (from) q = q.gte('date', from);
  if (to) q = q.lte('date', to);
  const { data, error } = await q;
  if (error) throw error;
  return mapList(data, ENTRY_MAP);
}

async function createEntry(entry) {
  const { data, error } = await db().from('entries').insert({
    id: entry.id, user_id: entry.userId, date: entry.date,
    type: entry.type, start: entry.start, end: entry.end || null,
    note: entry.note || '', source: entry.source || 'punch',
  }).select().single();
  if (error) throw error;
  return mapRow(data, ENTRY_MAP);
}

async function updateEntry(id, fields) {
  const { data, error } = await db().from('entries').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return mapRow(data, ENTRY_MAP);
}

async function deleteEntry(id) {
  const { error } = await db().from('entries').delete().eq('id', id);
  if (error) throw error;
}

/* ── Abwesenheiten ── */
async function listAbsences({ userId, from, to } = {}) {
  let q = db().from('absences').select('*').order('date_from');
  if (userId) q = q.eq('user_id', userId);
  if (from) q = q.gte('date_to', from);
  if (to) q = q.lte('date_from', to);
  const { data, error } = await q;
  if (error) throw error;
  return mapList(data, ABSENCE_MAP);
}

async function createAbsence(absence) {
  const { data, error } = await db().from('absences').insert({
    id: absence.id, user_id: absence.userId,
    date_from: absence.dateFrom, date_to: absence.dateTo,
    type: absence.type, credited: absence.credited !== false,
    status: absence.status || 'pending', note: absence.note || '',
    created_by: absence.createdBy,
  }).select().single();
  if (error) throw error;
  return mapRow(data, ABSENCE_MAP);
}

async function updateAbsence(id, fields) {
  const { data, error } = await db().from('absences').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return mapRow(data, ABSENCE_MAP);
}

async function deleteAbsence(id) {
  const { error } = await db().from('absences').delete().eq('id', id);
  if (error) throw error;
}

/* ── Benachrichtigungen ── */
async function listNotifications(userId) {
  const { data, error } = await db()
    .from('notifications').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return mapList(data, NOTIF_MAP);
}

async function createNotification(notif) {
  const { error } = await db().from('notifications').insert({
    id: notif.id, user_id: notif.userId, type: notif.type,
    detail: notif.detail || '', ref_id: notif.refId || '',
    read: false,
  });
  if (error) throw error;
}

async function markNotificationRead(id) {
  const { error } = await db().from('notifications').update({ read: true }).eq('id', id);
  if (error) throw error;
}

/* ── Export ── */
async function exportData({ from, to, users } = {}) {
  const entries = await listEntries({ from, to });
  const absences = await listAbsences({ from, to });
  return { users, entries, absences };
}

module.exports = {
  getDb,
  // Nutzer
  listUsers, findUserByUsername, findUserById, createUser, updateUser, deleteUser, publicUser,
  // Sessions
  createSession, destroySession, findSession,
  // Einträge
  listEntries, createEntry, updateEntry, deleteEntry,
  // Abwesenheiten
  listAbsences, createAbsence, updateAbsence, deleteAbsence,
  // Benachrichtigungen
  listNotifications, createNotification, markNotificationRead,
  // Export
  exportData,
  // Mapping (für settleWeeks)
  mapRow, USER_MAP, ENTRY_MAP, ABSENCE_MAP,
};