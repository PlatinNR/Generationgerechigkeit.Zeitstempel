# Zeitaufnahme · Interne Zeiterfassung

Zeiterfassung für die Stiftung Generationengerechtigkeit.
Rollen: **Admin**, **Manager**, **Mitarbeiter** – Login ohne E-Mail, Zugangsdaten vergibt der Admin.

---

## Architektur

| Teil | Technologie | Zweck |
|---|---|---|
| **Frontend** | HTML/CSS/JS (statisch) | Oberfläche |
| **API** | Vercel Serverless Functions (`/api/...`) | Backend-Logik |
| **Datenbank** | Supabase (Postgres) | Nutzer, Zeiten, Abwesenheiten, Benachrichtigungen |
| **Code-Hosting** | GitHub | Quellcode + Versionierung |

- Jeder mit gültigen Zugangsdaten kann sich anmelden (öffentliche URL).
- Sessions laufen über ein Cookie (`za_session`), gespeichert in der Supabase-Tabelle `sessions`.

---

## Erstmalige Bereitstellung (Deploy)

### 1. Supabase-Projekt anlegen (Datenbank)
1. Auf [supabase.com](https://supabase.com) registrieren → **New Project**
2. Region nahe wählen, Passwort merken
3. Nach dem Erstellen: **SQL Editor** öffnen → Inhalt von `supabase/schema.sql` einfügen → **Run**
4. Unter **Settings → API** notieren:
   - `Project URL` (z. B. `https://abc.supabase.co`)
   - `service_role` Key (geheim – **nur server-seitig**, nie im Frontend)

### 2. Code auf GitHub
1. Dieses Projekt in ein **neues GitHub-Repo** pushen (siehe unten)
2. Wenn du kein Repo hast: auf GitHub.com → **New repository** → Namen z. B. `zeitaufnahme`

### 3. Vercel verbinden
1. Auf [vercel.com](https://vercel.com) → **New Project** → GitHub-Repo importieren
2. Unter **Settings → Environment Variables** eintragen:
   - `SUPABASE_URL` = deine Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = dein service_role Key
3. **Deploy** klicken → nach 1–2 Minuten hast du eine URL, z. B. `https://zeitaufnahme.vercel.app`

### 4. Erster Admin
Beim allerersten Start legt das System noch **keinen** Admin an. Lege ihn einmalig mit dem Skript an (siehe Abschnitt „Ersten Admin anlegen").

---

## Lokal testen (vor dem Deploy)

```bash
npm install
vercel dev
```
Dann brauchst du die Umgebungsvariablen lokal:
```bash
# .env.local anlegen:
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

---

## Ersten Admin anlegen

Da die App bewusst **keine öffentliche Registrierung** hat, wird der erste Admin einmalig direkt in Supabase angelegt. Mitgeliefertes Skript:

```bash
# aus dem Projektverzeichnis:
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/init-admin.js
```

Das legt `admin / admin123` an (Name „Administrator"). Danach das Passwort in der App unter **Personen Konfigurieren → Bearbeiten → Passwort zurücksetzen** ändern.

---

## Übergabe an einen neuen Betreiber

Damit jemand anderes die App selbst pflegen kann, übergibst du vier Zugänge:

| Was | Wie übertragen |
|---|---|
| **GitHub-Repo** | Repo **übertragen** (Settings → Danger Zone → Transfer) oder Collaborator hinzufügen |
| **Vercel-Projekt** | Settings → Members einladen, oder Projekt **übertragen** |
| **Supabase-Projekt** | Settings → Access / Collaborators einladen (Owner-Rechte für volle Kontrolle) |
| **App-Admin-Konto** | Admin-Login der App (z. B. `admin`/Passwort) |

**Wichtig:** Der neue Betreiber braucht die Umgebungsvariablen (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Diese stehen in den Vercel-Einstellungen, NICHT im Code.

### Änderungen nach der Übergabe
- **Code ändern:** Datei editieren → `git push` → Vercel baut automatisch neu
- **Daten ändern:** direkt in Supabase oder über die App (Admin)
- **Backup:** Supabase bietet automatische Backups; zusätzlich kann der Admin in „Personen Konfigurieren → Rohdaten entnehmen" CSV/JSON exportieren

---

## Sicherheitshinweise
- Der `service_role`-Key ist **hochsensibel** – er gehört nur in die Vercel-Umgebungsvariablen, nie ins Frontend oder Repo.
- Standard-Passwörter (z. B. `admin123`) nach dem ersten Login ändern.
- Passwörter werden mit `scrypt` gehasht gespeichert (niemals im Klartext).
