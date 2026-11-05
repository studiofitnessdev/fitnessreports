# Studio Fitness — vendas

Simple sales app for the gym: register a sale (receipt), list clients, and, for the owner, see the sales history with totals.
Plain HTML/CSS/JS hosted on GitHub Pages, data in Supabase (free plan).

## Logins

| Login | Can do |
|---|---|
| **Dono** (owner) | Register sales, manage clients, see history, values and totals |
| **Professor** (teacher) | Register sales and manage clients. Cannot read any sale back (enforced by the database, not just hidden in the UI) |

## Setup (one time)

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> with the Proton email or the `studiofitnessdev` GitHub account.
2. Create a new project (free plan). Region: **South America (São Paulo)**. Save the database password somewhere safe.

### 2. Create the tables
1. Open **SQL Editor → New query**.
2. Paste all of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.

### 3. Block public sign-ups (important)
The site's key is public, so nobody else must be able to create an account.
**Authentication → Sign In / Providers → turn OFF "Allow new users to sign up"** and save.

### 4. Create the two logins
1. **Authentication → Users → Add user → Create new user**.
2. Email `dono@studiofitness.app`, a password for the owner, check **Auto Confirm User**.
3. Repeat with `professor@studiofitness.app` and the teacher's password.
   (These emails are only internal identifiers; no email is ever sent. If you use different ones, change them in `js/config.js` and `supabase/users.sql`.)
4. In the SQL Editor, run [`supabase/users.sql`](supabase/users.sql). The last query should list both emails with `owner` / `teacher`.

### 5. Connect the site to the project
In **Project Settings → API Keys** (or **API** on older projects) copy:
- the **Project URL**
- the **publishable** key (called **anon** on older projects)

Put them in [`js/config.js`](js/config.js). **Never use the `secret` / `service_role` key**: it bypasses all the rules and this file is public.

### 6. Publish on GitHub Pages
1. Commit and push to `main`.
2. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / root** → Save.
3. After a minute the app is at `https://studiofitnessdev.github.io/fitnessreports/`.

Free GitHub Pages requires a public repo. That's fine: no client data is stored in the repo, only the code.

## Check that the teacher really can't see values
1. Open the site, log in as **Professor**.
2. Open the browser console (desktop Chrome: F12) and run:
   ```js
   (await supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseKey).from('sales').select('*'))
   ```
   Because the session is shared, it runs as the teacher. It must return `data: []` even when sales exist.
3. Log in as **Dono**, open **Histórico**: the sales show up.

## Run locally
Any static server works, e.g. `python3 -m http.server 8000` in this folder, then open <http://localhost:8000>.

## Rules built in
- **Receipt numbers** continue from the old app: the first sale is **#6518** (change `start with` in `schema.sql` before running it if needed).
- **Plan dates**: start = day of the sale, end = same day 1/6/12 months later (31/01 + 1 month → 28/02).
- **Observação** is pre-filled with the plan period and can be edited.
- **Defaults**: Pix, Mensal, 3 dias/semana, 07:00.
- **Cliente**: pick from the list or type a new name; unknown names are saved as new clients automatically. Names are stored in uppercase.
- **Histórico** filters: Hoje, Ontem, Semana passada (previous Monday–Sunday), Mês atual, Mês passado, Últimos 6 meses, Último ano, or a custom date range. Long-press a filter to see which dates it covers.
- All dates are shown as dd/MM/yyyy.
- Free Supabase projects pause after **7 days without use**. If that happens (e.g. holidays), log into Supabase and click **Restore**; no data is lost.
