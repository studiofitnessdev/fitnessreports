# Studio Fitness — vendas

Simple sales app for the gym: register a sale (receipt), list clients, and, for the owner, see the sales history with totals.
Plain HTML/CSS/JS hosted on GitHub Pages, data in Supabase (free plan).

## Logins

| Login | Can do |
|---|---|
| **Dono** (owner) | Register sales, manage clients, see history, values and totals, delete sales |
| **Professor** (teacher) | Register sales, manage clients, see a history **without values** and delete sales. Cannot read any sale value back (enforced by the database, not just hidden in the UI): the history shows only number, date, client and plan details, and the receipt number and time of the sale just registered come back for printing |

## Setup (one time)

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> with the Proton email or the `studiofitnessdev` GitHub account.
2. Create a new project (free plan). Region: **South America (São Paulo)**. Save the database password somewhere safe.

### 2. Create the tables
1. Open **SQL Editor → New query**.
2. Paste all of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.

### 2b. Updates (only if you ran `schema.sql` before these files existed)
Run each in the SQL Editor, once: [`002_dinheiro.sql`](supabase/002_dinheiro.sql) (cash payments), [`003_subscriptions.sql`](supabase/003_subscriptions.sql) (plan status in Clientes), [`004_usage.sql`](supabase/004_usage.sql) (database usage in Configurações), [`005_passwords.sql`](supabase/005_passwords.sql) (Anderson changes the Professor password), [`006_wipe.sql`](supabase/006_wipe.sql) (Apagar vendas), [`007_receipt.sql`](supabase/007_receipt.sql) (receipt number on the Professor's printed receipts), [`008_delete_sale.sql`](supabase/008_delete_sale.sql) (Professor's Histórico and Apagar venda), [`009_plans.sql`](supabase/009_plans.sql) (Trimestral plan and 2–5 dias/semana), [`010_wipe_sales_only.sql`](supabase/010_wipe_sales_only.sql) (Apagar vendas keeps the clients), [`011_cpf_phone_edit_sale.sql`](supabase/011_cpf_phone_edit_sale.sql) (unique CPF, WhatsApp, Editar venda), [`012_diaria.sql`](supabase/012_diaria.sql) (Diária plan), [`013_notes_diaria_subs.sql`](supabase/013_notes_diaria_subs.sql) (Observação follows an edited sale; Diárias don't count as plans in Clientes). If 011 stops with "CPFs repetidos", fix those clients in Clientes and run it again.

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

## Service worker (fast launches on an old phone)
[`sw.js`](sw.js) keeps the app's files on the phone, so after the first visit the app opens without waiting for the network:
- **The page** (`index.html`) opens from the phone's copy at once. Meanwhile the fresh page is fetched and saved. When it changed (a new deploy), the app reloads itself into the new version: right away if nobody has touched the screen yet, otherwise the next time it goes to the background with nothing half done (no sale, client, password or window being filled in). So a deploy shows up on that launch or the next one, never in the middle of a sale. With no copy yet (first visit), it waits for the network.
- **css/js** (with `?v=`), images, fonts and the pinned CDN libraries (supabase-js, the PDF libraries) come from the phone's cache. `scripts/bump-version.sh` changes their `?v=` and the cache name in `sw.js`, so **always run it before committing** (the git hook does it): without it, phones keep the old files.
- **Supabase** (logins, clients, sales) is never cached by the service worker: requests always go to the database.
- It doesn't run on `localhost` / `127.0.0.1`, so local edits always show up. (`http://[::1]:8000` does run it, for testing.)

**Opening before the network answers.** The app opens on the screen the login saw last, using the role saved on the phone, while supabase-js checks the session (it refreshes the token when it's over an hour old). If the session was refused (e.g. the Professor password changed), it goes to the login screen. Without internet it stays open with what's saved, and the requests show their own errors.

**Clients saved on the phone.** The client list and plan statuses (names, CPFs, WhatsApp numbers, plan dates; never sale values) are saved on the phone after each load, per login, so the client search in Nova venda works the moment the app opens. Every launch reloads them from the database. **Sair** (or a refused session) deletes the saved copy. On a first login, until the clients arrive the list says "Carregando clientes…" and no client can be registered (so nobody is registered twice).

**Fonts** are served from this site ([`fonts/`](fonts/), SIL Open Font License), not from Google Fonts: one server fewer to wait for on the first visit.

**Kill switch**: if the cache ever causes trouble, replace all of `sw.js` with this and deploy. On their next launch phones drop the cache and the service worker; the launch after that loads everything from the network (harmless to leave in place, even with the registration still in `js/app.js`):
```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
})()));
```

## Home-screen icon
On Android, Chrome's menu → **Adicionar à tela inicial** / **Instalar app** installs the app with the emblem as its icon, opening full screen without the address bar ([`manifest.webmanifest`](manifest.webmanifest)). The icons are PNGs rendered from `img/emblem.svg`: after replacing the logo, run `sh scripts/make-icons.sh`, then `sh scripts/bump-version.sh`.

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
- **Plan dates**: start = day of the sale, end = same day 1/3/6/12 months later (Mensal, Trimestral, Semestral, Anual); a **Diária** (day pass) starts and ends on the day of the sale (31/01 + 1 month → 28/02). A Diária has no days per week and is never a plan to renew: it doesn't count in Clientes (Vencendo / Vencidos / Ativos) or for WhatsApp messages; the client's status comes from their real plans (**Sem plano** if they only did Diárias).
- **Observação** is pre-filled with the plan period and can be edited.
- **Dias por semana**: 2, 3, 4 or 5 (older sales with 1 or 4+ still show as they were).
- **Defaults**: Pix, Mensal, 3 dias/semana, 07:00.
- **Cliente**: tapping the field lists every client; typing filters by name (any order, accents ignored) or CPF. "Cadastrar" is always the last option and opens a form with Nome and CPF, prefilled with what was typed (a name, or a CPF when only digits were typed). Both search fields have an × button to clear them. A sale can only be saved for a registered client. Names are stored in uppercase.
- **Plan status** in Clientes (both logins): each client shows **Ativo**, **Vence em N dias** (7 days or less), **Vence hoje**, **Vencido** or **Sem plano**, based on the sale whose plan reaches the furthest date (renewing early never shortens it). A plan is active up to and including its end date. The teacher gets only these dates through the `client_subscriptions()` database function, never values.
- **CPF**: each real CPF can belong to only one client (checked in the app and enforced by the database). Clients without CPF are stored as `00000000000` and shown as **Sem CPF**; searching digits never matches them.
- **Renovações** in Clientes (both logins): filters **Todos · Vencendo** (7 days or less, soonest first) **· Vencidos** (most recent first) **· Ativos · Sem plano**, with counts. Clients with a WhatsApp number get a green button that opens WhatsApp with a renewal message for their plan. The WhatsApp field appears after `011_cpf_phone_edit_sale.sql` runs; until then the app works as before.
- **Same name** (homonyms): lists show what tells them apart (CPF, else WhatsApp, else `Sem CPF · cód. <id>`). In Nova venda, a name that more than one client has must be picked from the list; typing it is not enough, so a sale never lands on the wrong person.
- **Apagar cliente** (Anderson only): in Clientes, tap the client, then **Apagar cliente**. The confirmation shows the client, their plan and how many sales they have. Their sales stay in Histórico with the name (values, totals and receipts don't change), but without the CPF and without counting as a plan in Clientes. It can't be undone.
- **Login errors**: "Senha incorreta" only when the server says the password is wrong; no internet, too many attempts and a server error each get their own message (also in the password confirmations in Configurações).
- **Editar venda** in Histórico (pencil): fixes client, plan, days, time and start date (end date recalculated), keeping the receipt number. When plan or dates change, the automatic period text in the Observação ("Plano Mensal: 17/11/2026 a 17/12/2026") follows them; anything else written there is kept (for the Professor's edits this happens in the database, with `013_notes_diaria_subs.sql`). Anderson also edits value, payment and observação; the Professor never sees them, and the database ignores them from that login. Older sales with 1 or 4+ days keep that value unless changed.
- **Insights** (Anderson only, in the bottom bar): last 12 months of sales, by the phone's local time. This month's revenue and sales against the same days of last month, average ticket, clients with a plan (and how many expire within 7 days, linking to the renewal list), new clients this month (first plan in 12 months, plus the month's renewals), Diárias this month (count and revenue, when there are any), renewal rate (of the plans that ended in each of the last 6 months, how many were renewed up to 15 days after the end), new clients per month (last 6 months), revenue per month (tap a bar for its value), and plans, payment methods, busiest class times, days per week and weekdays. In the bar, Configurações is labeled **Ajustes** to fit six buttons.
- **Version stamps**: a git pre-commit hook (`.githooks/pre-commit`) runs `scripts/bump-version.sh` and stages `index.html` and `sw.js` on every commit. It's enabled per clone with `git config core.hooksPath .githooks`.
- **Dados** in Configurações (Anderson only):
  - **Baixar backup** downloads `studio-fitness-backup_<date>.zip` with `vendas.csv` and `clientes.csv` (with the WhatsApp numbers). These are in the raw database format: comma separated, ISO dates, original ids.
  - **Apagar todas as vendas** unlocks only after a backup in the same session. It asks you to type APAGAR and enter Anderson's password.
  - It deletes only the sales in that backup (`wipe_data()`). **Clients are never deleted**: they stay, shown as **Sem plano**. Logins stay too, and receipt numbers keep counting, so no number repeats.
  - Restoring needs SQL, because ids are `generated always`: import the CSVs into temporary tables, then `insert into public.sales … overriding system value select … ;` (the clients are still there after Apagar vendas; if they're ever missing, insert them first).
- **Importar clientes** in Configurações → Dados (Anderson only): pick a spreadsheet (.xlsx or .csv, header row optional). The app finds the CPF column (most valid CPFs, check digits included; a sheet with no CPFs gets none, so row numbers never become CPFs) and the name column (most letters) by content, so column order doesn't matter. A plain number of 9–10 digits in the CPF column is a CPF that lost its leading zeros in Excel; shorter numbers are ignored. A WhatsApp column is optional: a header like Telefone, Celular, WhatsApp or Contato, or a column where at least half of the cells are phone numbers (with DDD; +55 and a leading 0 are removed). New clients get it, and clients already in the app without WhatsApp get the sheet's number when the match is certain (same CPF, or a name only one client has). It shows how many clients are new before saving. Clients without CPF get `00000000000`. Anyone already in the app is skipped (same CPF, or same name when there's no CPF), and so are repeats inside the file, so importing again never duplicates. The file is read on the phone and never stored in the repo (it holds personal data).
- **Senhas** in Configurações (Anderson only): change Anderson's or the Professor's password. Every change asks for confirmation with Anderson's current password. Changing the Professor password signs that login out everywhere: open screens keep working for up to about 1 hour, then must log in with the new password. The database function can only change the teacher login, never any other account.
- **Configurações** (Anderson only): database size against the free plan's 500 MB, space used by sales and clients, and a growth forecast from the last 90 days. It also lists the other free-plan limits. Bandwidth (5 GB/month) can't be measured from the app because the Supabase usage API needs a secret key; check it in the Supabase dashboard (linked on the screen).
- **Histórico** for the Professor: the same list and filters, but without amount, payment method, total, exports or receipt reprint. It comes from the `staff_history()` database function, which never returns values.
- **Apagar venda** in Histórico (both logins): the trash button on each sale deletes it after a confirmation, whoever registered it. The client's plan status in Clientes is recomputed from their other sales (**Sem plano** if none is left). The receipt number is not reused. It goes through the `delete_sale()` database function; without `008_delete_sale.sql` only Anderson can delete.
- **Histórico** filters: Hoje, Ontem, Semana passada (previous Monday–Sunday), Mês atual, Mês passado, Últimos 6 meses, Último ano, or a custom date range. Long-press a filter to see which dates it covers.
- **Imprimir recibo**: after "Fechar venda" the celebration screen has an **Imprimir recibo** button (it then stays open until **Bora!**). It prints straight to the 58 mm Bluetooth thermal printer, with no other app, a receipt with everything about the sale: number, date and time, client and CPF, plan, days per week, class time, start and due date, payment method, total, observação and who attended, plus the gym's address and WhatsApp.
  - Needs **Google Chrome on Android** (other browsers and iPhone can't talk to Bluetooth printers). The phone's Bluetooth must be on and the printer on and nearby.
  - **The printer is remembered.** The first print shows Chrome's list of nearby Bluetooth devices: pick the printer. From then on that phone prints to it by default. Where Chrome can reconnect on its own it prints with no list at all; otherwise the list shows only that printer, so it's one tap.
  - The app lets go of the printer 3 seconds after each print and when it goes to the background. A Bluetooth (BLE) printer disappears from every list while another phone, app (like Mini Impressora) or open tab is connected to it, so keep only one of them connected.
  - If it doesn't print, a window says why, with the saved printer's name and these buttons: **Tentar de novo** (same printer), **Escolher outra impressora** (full Bluetooth list) and **Usar impressora pareada (Bluetooth clássico)**. The last one is for when the printer never shows up in the Bluetooth list: pair it first in the phone's Bluetooth settings. Chrome then remembers it permanently and prints with no list.
  - The receipt is sent as a black-and-white image in ESC/POS, the standard command language of thermal printers (`js/printer.js`), over Bluetooth Low Energy (Web Bluetooth) or Bluetooth classic (Web Serial).
  - Every closed sale also downloads its receipt image to the device (`recibo-6518_09-11-2026_15h42.png`), exactly as it goes to the printer, whether or not it was printed. The first time, Chrome may ask to allow the site to download multiple files: allow it.
  - Anderson can reprint any receipt in **Histórico** (**Recibo** button on each sale). Both logins get the receipt number through the `add_sale()` database function, which returns only the new sale's number and time. Without `007_receipt.sql` the sale still saves, but the Professor's receipt prints without a number.
- All dates are shown as dd/MM/yyyy.
- Free Supabase projects pause after **7 days without use**. If that happens (e.g. holidays), log into Supabase and click **Restore**; no data is lost.

## Deploying an update
A git hook runs `scripts/bump-version.sh` on every commit (enabled once per clone with `git config core.hooksPath .githooks`). It stamps the CSS/JS links in `index.html` with a hash of their contents, so phones never combine a new page with old cached files. GitHub Pages caches each file for 10 minutes, and a mix of old and new files breaks new screens.
