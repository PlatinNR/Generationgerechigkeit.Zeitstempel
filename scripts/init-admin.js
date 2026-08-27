'use strict';

/* ==========================================================================
   Ersten Admin anlegen (einmalig nach der Supabase-Einrichtung)
   Verwendung:
     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/init-admin.js
   Passwort nach dem ersten Login in der App ändern!
   ========================================================================== */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Bitte SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariablen setzen.');
  process.exit(1);
}

const username = process.env.ADMIN_USER || 'admin';
const password = process.env.ADMIN_PASSWORD || 'admin123';
const name = process.env.ADMIN_NAME || 'Administrator';

const sb = createClient(url, key);

async function main() {
  const { data: existing } = await sb.from('users').select('id').eq('username', username).maybeSingle();
  if (existing) {
    console.log(`Benutzername "${username}" existiert bereits – nichts zu tun.`);
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  const wd = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - wd);
  const lastSettledMonday = monday.toISOString().slice(0, 10);

  const { data, error } = await sb.from('users').insert({
    id: 'u_admin_' + crypto.randomBytes(4).toString('hex'),
    username, name, role: 'admin',
    weekly_hours: 38.5, balance: 0, active: true,
    salt, password_hash: hash,
    password_history: [], last_settled_monday: lastSettledMonday,
  }).select().single();

  if (error) {
    console.error('Fehler beim Anlegen:', error.message);
    process.exit(1);
  }
  console.log(`Admin angelegt: ${username} / ${password}`);
  console.log('WICHTIG: Passwort nach dem ersten Login in der App ändern!');
}

main();
