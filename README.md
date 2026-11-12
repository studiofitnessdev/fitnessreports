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
Run each in the SQL Editor, once: [`002_dinheiro.sql`](supabase/002_dinheiro.sql) (cash payments), [`003_subscriptions.sql`](supabase/003_subscriptions.sql) (plan status in Clientes), [`004_usage.sql`](supabase/004_usage.sql) (database usage in Configurações), [`005_passwords.sql`](supabase/005_passwords.sql) (Anderson changes the Professor password), [`006_wipe.sql`](supabase/006_wipe.sql) (Apagar todos os dados), [`007_receipt.sql`](supabase/007_receipt.sql) (receipt number on the Professor's printed receipts), [`008_delete_sale.sql`](supabase/008_delete_sale.sql) (Professor's Histórico and Apagar venda).

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
- **Cliente**: tapping the field lists every client; typing filters by name (any order, accents ignored) or CPF. "Cadastrar" is always the last option and opens a form with Nome and CPF, prefilled with what was typed (a name, or a CPF when only digits were typed). Both search fields have an × button to clear them. A sale can only be saved for a registered client. Names are stored in uppercase.
- **Plan status** in Clientes (both logins): each client shows **Ativo**, **Vence em N dias** (7 days or less), **Vence hoje**, **Vencido** or **Sem plano**, based on the sale whose plan reaches the furthest date (renewing early never shortens it). A plan is active up to and including its end date. The teacher gets only these dates through the `client_subscriptions()` database function, never values.
- **Dados** in Configurações (Anderson only):
  - **Baixar backup** downloads `studio-fitness-backup_<date>.zip` with `vendas.csv` and `clientes.csv`. These are in the raw database format: comma separated, ISO dates, original ids.
  - **Apagar todos os dados** unlocks only after a backup in the same session. It asks you to type APAGAR and enter Anderson's password.
  - It deletes only the rows in that backup, in one transaction (`wipe_data()`). Logins stay, and receipt numbers keep counting, so no number repeats.
  - Restoring needs SQL, because ids are `generated always`: import the CSVs into temporary tables, then `insert into public.clients … overriding system value select … ;` (clients first, then sales).
- **Senhas** in Configurações (Anderson only): change Anderson's or the Professor's password. Every change asks for confirmation with Anderson's current password. Changing the Professor password signs that login out everywhere: open screens keep working for up to about 1 hour, then must log in with the new password. The database function can only change the teacher login, never any other account.
- **Configurações** (Anderson only): database size against the free plan's 500 MB, space used by sales and clients, and a growth forecast from the last 90 days. It also lists the other free-plan limits. Bandwidth (5 GB/month) can't be measured from the app because the Supabase usage API needs a secret key; check it in the Supabase dashboard (linked on the screen).
- **Histórico** for the Professor: the same list and filters, but without amount, payment method, total, exports or receipt reprint. It comes from the `staff_history()` database function, which never returns values.
- **Apagar venda** in Histórico (both logins): the trash button on each sale deletes it after a confirmation, whoever registered it. The client's plan status in Clientes is recomputed from their other sales (**Sem plano** if none is left). The receipt number is not reused. It goes through the `delete_sale()` database function; without `008_delete_sale.sql` only Anderson can delete.
- **Histórico** filters: Hoje, Ontem, Semana passada (previous Monday–Sunday), Mês atual, Mês passado, Últimos 6 meses, Último ano, or a custom date range. Long-press a filter to see which dates it covers.
- **Imprimir recibo**: after "Fechar venda" the celebration screen has an **Imprimir recibo** button (it then stays open until **Bora!**). It prints straight to the 58 mm Bluetooth thermal printer, with no other app, a receipt with everything about the sale: number, date and time, client and CPF, plan, days per week, class time, start and due date, payment method, total, observação and who attended, plus the gym's address and WhatsApp.   - Needs **Google Chrome on Android** (other browsers and iPhone can't talk to Bluetooth printers). The device's Bluetooth must be on and the printer on and nearby; it doesn't need to be paired in the Bluetooth settings.
  - The first print after opening the app shows Chrome's list of nearby Bluetooth devices: pick the printer. It stays connected while the app is open, so later receipts print with one tap.
  - The receipt is sent over Bluetooth Low Energy (Web Bluetooth) as a black-and-white image in ESC/POS, the standard command language of thermal printers (`js/printer.js`).
  - If it doesn't print, a window says why (wrong browser, Bluetooth off, printer off or out of range) with **Tentar de novo** and **Escolher outra impressora**.
  - Every closed sale also downloads its receipt image to the device (`recibo-6518_09-11-2026_15h42.png`), exactly as it goes to the printer, whether or not it was printed. The first time, Chrome may ask to allow the site to download multiple files: allow it.
  - Anderson can reprint any receipt in **Histórico** (**Recibo** button on each sale). Both logins get the receipt number through the `add_sale()` database function, which returns only the new sale's number and time. Without `007_receipt.sql` the sale still saves, but the Professor's receipt prints without a number.
- All dates are shown as dd/MM/yyyy.
- Free Supabase projects pause after **7 days without use**. If that happens (e.g. holidays), log into Supabase and click **Restore**; no data is lost.

## Deploying an update
A git hook runs `scripts/bump-version.sh` on every commit (enabled once per clone with `git config core.hooksPath .githooks`). It stamps the CSS/JS links in `index.html` with a hash of their contents, so phones never combine a new page with old cached files. GitHub Pages caches each file for 10 minutes, and a mix of old and new files breaks new screens.
