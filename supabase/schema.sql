-- ============================================================================
-- Zeiterfassung · Supabase-Schema
-- In Supabase ausführen unter: SQL-Editor → New Query → Run
-- ============================================================================

-- ---------- Nutzer ----------
create table if not exists users (
  id text primary key,
  username text unique not null,
  name text not null,
  role text not null check (role in ('admin','manager','mitarbeiter')),
  weekly_hours double precision not null default 38.5,
  balance double precision not null default 0,
  active boolean not null default true,
  salt text not null,
  password_hash text not null,
  password_history jsonb not null default '[]',
  last_settled_monday text,
  last_settled_day text,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- ---------- Sitzungen ----------
create table if not exists sessions (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- Zeiteinträge (Arbeit / Pause) ----------
create table if not exists entries (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  date text not null,
  type text not null check (type in ('work','break')),
  start text not null,
  "end" text,
  note text not null default '',
  source text not null default 'punch',
  created_at timestamptz not null default now()
);

-- ---------- Abwesenheiten (Urlaub / Krankheit / Fehltag) ----------
create table if not exists absences (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  date_from text not null,
  date_to text not null,
  type text not null check (type in ('urlaub','krank','fehltag')),
  credited boolean not null default true,
  status text not null default 'pending' check (status in ('pending','confirmed')),
  note text not null default '',
  created_by text not null,
  created_at timestamptz not null default now()
);

-- ---------- Benachrichtigungen ----------
create table if not exists notifications (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null,
  detail text not null default '',
  ref_id text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Indizes für schnelle Abfragen ----------
create index if not exists idx_entries_user_date on entries(user_id, date);
create index if not exists idx_absences_user on absences(user_id);
create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_notifications_user on notifications(user_id);
