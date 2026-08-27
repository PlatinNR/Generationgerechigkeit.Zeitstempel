/* ==========================================================================
   API-Client · fetch + Cookie
   ========================================================================== */
'use strict';

const API = {
  async _fetch(method, url, body) {
    const opts = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) {
      window.apiLogout();
      throw new Error('Nicht angemeldet');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fehler');
    return data;
  },

  get(url) { return this._fetch('GET', url); },
  post(url, body) { return this._fetch('POST', url, body); },
  put(url, body) { return this._fetch('PUT', url, body); },
  del(url) { return this._fetch('DELETE', url); },

  /* -- Auth -- */
  login(username, password) { return this.post('/api/login', { username, password }); },
  logout() { return this.post('/api/logout'); },
  me() { return this.get('/api/me'); },

  /* -- Users -- */
  getUsers() { return this.get('/api/users'); },
  createUser(data) { return this.post('/api/users', data); },
  updateUser(id, data) { return this.put('/api/users/' + id, data); },
  deleteUser(id) { return this.del('/api/users/' + id); },
  setPassword(id, password) { return this.post('/api/users/' + id + '/password', { password }); },

  /* -- Entries -- */
  getEntries(params = {}) {
    const q = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return this.get('/api/entries' + (q ? '?' + q : ''));
  },
  createEntry(data) { return this.post('/api/entries', data); },
  updateEntry(id, data) { return this.put('/api/entries/' + id, data); },
  deleteEntry(id) { return this.del('/api/entries/' + id); },

  /* -- Absences -- */
  getAbsences(params = {}) {
    const q = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return this.get('/api/absences' + (q ? '?' + q : ''));
  },
  createAbsence(data) { return this.post('/api/absences', data); },
  updateAbsence(id, data) { return this.put('/api/absences/' + id, data); },
  confirmAbsence(id) { return this.post('/api/absences/' + id + '/confirm'); },
  deleteAbsence(id) { return this.del('/api/absences/' + id); },

  /* -- Notifications -- */
  getNotifications() { return this.get('/api/notifications'); },
  markNotificationRead(id) { return this.post('/api/notifications/' + id + '/read'); },

  /* -- Export -- */
  exportData(params = {}) {
    const q = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return this.get('/api/export' + (q ? '?' + q : ''));
  },
};