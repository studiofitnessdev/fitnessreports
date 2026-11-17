(() => {
  'use strict';

  const CFG = window.APP_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const PLAN_MONTHS = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
  const PLAN_LABEL = { mensal: 'Mensal', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual' };
  const PAYMENT_LABEL = { pix: 'Pix', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro' };
  const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

  const state = {
    role: null,        // 'owner' | 'teacher'
    clients: [],
    historyRange: 'today',
    history: null,     // last loaded history: { key, range, rows, total } — used by the exports
    historyReq: null,  // date range currently requested (ignores late answers for older filters)
    clientsDirty: true,
    clientsDay: null,  // day the Clientes list was last drawn (statuses change at midnight)
    subs: null,        // Map client_id → { plan, plan_start, plan_end } of the plan reaching furthest; null = not loaded
    subsAt: 0,
  };

  // ───────────────────────── Date helpers (always local time) ─────────────────────────
  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  // Same day N months later; clamps to the month's last day (31/01 + 1 month → 28/02).
  const addMonths = (d, n) => {
    const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
    return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
  };
  const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseISODate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const fmtDateTime = (d) => `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  // [from, to) → "dd/MM/yyyy a dd/MM/yyyy" (or a single date)
  const fmtRange = ([from, to]) => {
    const last = addDays(to, -1);
    return from.getTime() === last.getTime() ? fmtDate(from) : `${fmtDate(from)} a ${fmtDate(last)}`;
  };

  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtMoney = (n) => money.format(n);

  const fmtCpf = (digits) => {
    const d = (digits || '').replace(/\D/g, '').slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  };
  const normName = (s) => s.trim().replace(/\s+/g, ' ').toUpperCase();
  const CPF_NONE = '00000000000'; // stored for every client without CPF; shown as "Sem CPF"
  const showCpf = (cpf) => (cpf && cpf !== CPF_NONE ? fmtCpf(cpf) : ''); // '' = no CPF (null or CPF_NONE)
  const fmtPhone = (digits) => {
    const d = (digits || '').replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    if (d.length <= 2) return `(${d}`;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  };
  // "Maria Aparecida" from "MARIA APARECIDA SILVA" (WhatsApp greeting)
  const firstName = (name) => (name.split(' ')[0] || '').toLowerCase().replace(/^\p{L}/u, (ch) => ch.toUpperCase());

  // ───────────────────────── Small UI helpers ─────────────────────────
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  let toastTimer;
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  };

  const showError = (node, msg) => { node.textContent = msg; node.hidden = !msg; };

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touchScreen = window.matchMedia('(pointer: coarse)').matches;

  // ── On-screen keyboard: hide the bottom bar and the total bar while it's open (<html class="kb-open">).
  // Many Android browsers shrink the page when the keyboard opens, which lifts fixed bars on top of it.
  // Hidden on focus of a text field (the keyboard is coming), shown again on blur, and also when the
  // keyboard is closed with the back button while the field keeps focus (the visible area grows back).
  const typingField = (n) => !!n?.matches?.('textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="date"]):not([type="button"]):not([type="submit"])');
  const setKeyboard = (open) => document.documentElement.classList.toggle('kb-open', open);
  if (touchScreen) {
    document.addEventListener('focusin', (e) => { if (typingField(e.target)) setKeyboard(true); });
    document.addEventListener('focusout', () => setTimeout(() => { if (!typingField(document.activeElement)) setKeyboard(false); }, 60));
    const vv = window.visualViewport;
    if (vv) {
      let fullHeight = vv.height;
      vv.addEventListener('resize', () => {
        fullHeight = Math.max(fullHeight, vv.height);
        if (vv.height > fullHeight - 100) setKeyboard(false);
        else if (typingField(document.activeElement)) setKeyboard(true);
      });
      window.addEventListener('orientationchange', () => { fullHeight = 0; });
    }
  }

  // Run work when the browser is idle (falls back to a short timeout on Safari)
  const whenIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(fn, 16));

  // Render long lists in pieces: the first screenful right away, the rest in idle chunks,
  // so opening "Último ano" (thousands of rows) never freezes the screen.
  // With { lazy: true } the rest is drawn only as the user scrolls near the end of the list
  // (for long lists that have a search box, like Clientes).
  const listJobs = new WeakMap();
  const clearListJob = (listEl) => { listJobs.get(listEl)?.observer?.disconnect(); listJobs.delete(listEl); };
  function renderList(listEl, items, makeItem, emptyNode, { lazy = false } = {}) {
    const job = {};
    clearListJob(listEl);
    listJobs.set(listEl, job);
    const FIRST = 40, CHUNK = lazy ? 60 : 200;
    listEl.replaceChildren(...items.slice(0, FIRST).map(makeItem));
    if (!items.length && emptyNode) listEl.append(emptyNode);
    let i = FIRST;
    if (lazy && window.IntersectionObserver) { // without it, fall back to drawing everything in idle chunks
      if (i >= items.length) return;
      const sentinel = el('li', 'list-sentinel');
      sentinel.setAttribute('aria-hidden', 'true');
      listEl.append(sentinel);
      job.observer = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const frag = document.createDocumentFragment();
        for (const it of items.slice(i, i + CHUNK)) frag.append(makeItem(it));
        sentinel.before(frag);
        i += CHUNK;
        if (i >= items.length) { job.observer.disconnect(); sentinel.remove(); }
        else { job.observer.unobserve(sentinel); job.observer.observe(sentinel); } // re-check: still in view after a big jump
      }, { rootMargin: '1200px 0px' });
      job.observer.observe(sentinel);
      return;
    }
    const next = () => {
      if (listJobs.get(listEl) !== job || i >= items.length) return;
      const frag = document.createDocumentFragment();
      for (const it of items.slice(i, i + CHUNK)) frag.append(makeItem(it));
      listEl.append(frag);
      i += CHUNK;
      whenIdle(next);
    };
    whenIdle(next);
  }

  // "Venda fechada!" overlay with confetti
  const PHRASES = [
    'Mais um no time! 🔥', 'Partiu treino! 💪', 'Foco, força e fé!', 'Shape em construção!',
    'Sem dor, sem ganho!', 'É hora do show!', 'Ninguém segura!', 'Bora pra cima!',
  ];
  let celebrateTimer;
  let celebrateReceipt = null; // { canvas } once the receipt is drawn; null while preparing
  // With a receipt to print, the overlay stays until "Bora!" (no auto-close, backdrop taps ignored)
  // so the print button can't disappear before it's used.
  function celebrate(sub, receipt) {
    const box = $('#celebrate');
    $('#celebrate-phrase').textContent = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    $('#celebrate-sub').textContent = sub;
    const printBtn = $('#celebrate-print');
    celebrateReceipt = null;
    box.dataset.sticky = receipt ? '1' : '';
    printBtn.hidden = !receipt;
    if (receipt) {
      // Draw now, not on tap: the browser only opens the printer list within a moment of the tap.
      printBtn.disabled = true;
      $('#celebrate-print-label').textContent = 'Preparando recibo…';
      const job = {};
      celebrate.job = job;
      window.Receipt.render(receipt).then((canvas) => {
        saveReceiptPng(canvas, receipt); // every closed sale keeps a copy of its receipt, printed or not
        if (celebrate.job !== job) return;
        celebrateReceipt = { canvas };
        printBtn.disabled = false;
        $('#celebrate-print-label').textContent = 'Imprimir recibo';
      }).catch((err) => {
        console.error(err);
        if (celebrate.job === job) $('#celebrate-print-label').textContent = 'Recibo indisponível';
      });
    }

    const confetti = $('#confetti');
    confetti.replaceChildren();
    if (!reducedMotion()) {
      const colors = ['#e10600', '#ff2d1f', '#ffffff', '#c9ccd1', '#7a0000', '#ff6a5c'];
      for (let i = 0; i < 70; i++) {
        const p = el('i');
        p.style.left = `${Math.random() * 100}%`;
        p.style.background = colors[i % colors.length];
        p.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
        p.style.animationDelay = `${Math.random() * .4}s`;
        p.style.setProperty('--dx', `${(Math.random() - .5) * 160}px`);
        p.style.setProperty('--rot', `${(Math.random() > .5 ? 1 : -1) * (360 + Math.random() * 720)}deg`);
        if (i % 3 === 0) { p.style.width = '8px'; p.style.height = '8px'; p.style.borderRadius = '50%'; }
        confetti.append(p);
      }
    }
    box.hidden = false;
    try { navigator.vibrate?.([40, 60, 40]); } catch (_) { /* not supported */ }
    clearTimeout(celebrateTimer);
    if (!receipt) celebrateTimer = setTimeout(closeCelebrate, 3500);
  }
  function closeCelebrate() {
    clearTimeout(celebrateTimer);
    celebrate.job = null;
    celebrateReceipt = null;
    $('#celebrate').hidden = true;
    $('#confetti').replaceChildren();
  }
  $('#celebrate').addEventListener('click', (e) => {
    if ($('#celebrate').dataset.sticky && !e.target.closest('#celebrate-ok')) return;
    closeCelebrate();
  });
  $('#celebrate-print').addEventListener('click', (e) => {
    e.stopPropagation();
    if (celebrateReceipt) printReceipt(celebrateReceipt.canvas, e.currentTarget);
  });

  // ───────────────────────── Offline cache (sw.js) ─────────────────────────
  // Repeat launches load css/js/fonts from the phone instead of the network. Not on localhost, so files
  // edited during development (without running bump-version.sh) are never served from an old cache.
  if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker:', err)));
  }

  // ───────────────────────── Supabase ─────────────────────────
  const configured = CFG && !CFG.supabaseUrl.includes('YOUR-') && !CFG.supabaseKey.includes('YOUR-');
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

  // First page alone (most queries fit in it); if it's full, the next pages go out 4 at a time in parallel.
  // The query needs a unique final sort key (e.g. id) so pages never overlap or skip rows.
  const PARALLEL_PAGES = 4;
  async function fetchAll(buildQuery) {
    const page = async (n) => {
      const { data, error } = await buildQuery().range(n * PAGE_SIZE, (n + 1) * PAGE_SIZE - 1);
      if (error) throw error;
      return data;
    };
    const rows = await page(0);
    for (let n = 1; rows.length === n * PAGE_SIZE; n += PARALLEL_PAGES) {
      const pages = await Promise.all(Array.from({ length: PARALLEL_PAGES }, (_, k) => page(n + k)));
      for (const data of pages) rows.push(...data);
      if (pages.some((data) => data.length < PAGE_SIZE)) break;
    }
    return rows;
  }

  // ───────────────────────── Login ─────────────────────────
  const LAST_USER_KEY = 'sf:lastUser';

  function renderLoginUsers() {
    let last = 'teacher';
    try { last = localStorage.getItem(LAST_USER_KEY) || last; } catch (_) { /* storage unavailable */ }
    const box = $('#login-user');
    box.replaceChildren();
    for (const [key, u] of Object.entries(CFG.users)) {
      const label = el('label');
      const input = el('input');
      input.type = 'radio'; input.name = 'login-user'; input.value = key;
      input.checked = key === last;
      label.append(input, el('span', null, u.label));
      box.append(label);
    }
  }

  function showLogin(msg) {
    $('#app').hidden = true;
    $('#view-login').hidden = false;
    $('#login-password').value = '';
    showError($('#login-error'), msg || '');
    // Never leave one login's history (with values) on screen or in memory for the next login.
    historyCache.clear(); state.insights = null;
    $('#insights-body').replaceChildren();
    state.history = null;
    state.historyReq = null;
    clearListJob($('#history-list'));
    $('#history-list').replaceChildren();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return showError($('#login-error'), 'Configure o Supabase em js/config.js.');
    const key = document.querySelector('input[name="login-user"]:checked')?.value;
    const btn = e.submitter || $('#login-form button[type="submit"]');
    btn.disabled = true;
    showError($('#login-error'), '');
    const { data, error } = await sb.auth.signInWithPassword({
      email: CFG.users[key].email,
      password: $('#login-password').value,
    });
    btn.disabled = false;
    if (error) return showError($('#login-error'), 'Senha incorreta.');
    try { localStorage.setItem(LAST_USER_KEY, key); } catch (_) { /* ignore */ }
    enterApp(data.user);
  });

  $('#logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    state.role = null;
    showLogin();
  });

  // The role is cached per user so the app opens instantly on the next visit; it is re-checked
  // with the server right after (and the database rules enforce it regardless).
  const ROLE_KEY = 'sf:role:';
  function applyRole(role) {
    state.role = role;
    const isOwner = role === 'owner';
    $$('[data-owner-only]').forEach((n) => { n.hidden = !isOwner; });
    $('#who').textContent = isOwner ? CFG.users.owner.label : CFG.users.teacher.label;
  }
  function showApp() {
    $('#view-login').hidden = true;
    $('#app').hidden = false;
    showView('sale');
  }

  async function enterApp(user) {
    let cached = null;
    try { cached = localStorage.getItem(ROLE_KEY + user.id); } catch (_) { /* storage unavailable */ }
    if (cached) { applyRole(cached); showApp(); }
    loadClients();
    loadSubscriptions();

    const { data, error } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (error && cached) return; // network hiccup: keep going with the cached role
    if (error || !data) {
      try { localStorage.removeItem(ROLE_KEY + user.id); } catch (_) { /* ignore */ }
      await sb.auth.signOut();
      return showLogin('Usuário sem perfil configurado no banco.');
    }
    try { localStorage.setItem(ROLE_KEY + user.id, data.role); } catch (_) { /* ignore */ }
    if (data.role !== cached) { applyRole(data.role); showApp(); }
  }

  // ───────────────────────── Navigation ─────────────────────────
  const TITLES = { sale: 'Nova venda', history: 'Histórico', clients: 'Clientes', insights: 'Insights', settings: 'Configurações' };

  function showView(name) {
    if ((name === 'settings' || name === 'insights') && state.role !== 'owner') name = 'sale';
    for (const v of Object.keys(TITLES)) $(`#view-${v}`).hidden = v !== name;
    $$('.bottomnav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#view-title').textContent = TITLES[name];
    $('#totalbar').hidden = name !== 'history' || state.role !== 'owner';
    if (name === 'history') { loadHistory(); if (state.role === 'owner') whenIdle(() => loadPdfLibs().catch(() => {})); }
    if (name === 'settings') {
      loadUsage();
      $$('.pw-form').forEach((f) => { f.reset(); f.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid')); });
      $$('.pw-form .error').forEach((n) => showError(n, ''));
    }
    if (name === 'insights') loadInsights();
    if (name === 'clients') {
      if (state.clientsDirty || state.clientsDay !== toISODate(new Date())) renderClients();
      if (Date.now() - state.subsAt > 60_000) loadSubscriptions(); // pick up sales made on other phones
    }
    window.scrollTo(0, 0);
  }

  $$('.bottomnav [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ───────────────────────── Clients ─────────────────────────
  // The phone column comes with supabase/011_cpf_phone_edit_sale.sql; until it runs, clients load without it
  // and the WhatsApp fields stay hidden (so a deploy before the SQL never empties Clientes).
  const isMissingPhone = (err) => !!err && (err.code === '42703' || err.code === 'PGRST204' || /phone/.test(err.message || ''));
  state.hasPhone = false;
  async function loadClients() {
    const query = (cols) => fetchAll(() => sb.from('clients').select(cols).order('name').order('id'));
    try {
      try {
        state.clients = await query('id, name, cpf, phone');
        state.hasPhone = true;
      } catch (err) {
        if (!isMissingPhone(err)) throw err;
        state.clients = await query('id, name, cpf');
        state.hasPhone = false;
      }
      $$('.phone-field').forEach((n) => { n.hidden = !state.hasPhone; });
    } catch (err) {
      console.error(err);
      toast('Erro ao carregar clientes.');
      return;
    }
    for (const c of state.clients) c.key = searchKey(c.name);
    clientsChanged();
  }

  // Plan status per client. Comes from a database function that returns only plan dates (no values),
  // so it works for the teacher too, who can't read the sales table.
  async function loadSubscriptions() {
    state.subsAt = Date.now();
    try {
      const rows = await fetchAll(() => sb.rpc('client_subscriptions').order('client_id'));
      state.subs = new Map(rows.map((r) => [r.client_id, r]));
    } catch (err) {
      console.warn('Status do plano indisponível: rode supabase/003_subscriptions.sql no Supabase.', err);
      return;
    }
    clientsChanged();
  }

  function subStatus(clientId) {
    const s = state.subs.get(clientId);
    if (!s) return { cls: 'none', tag: 'Sem plano', detail: '' };
    const end = parseISODate(s.plan_end);
    const days = Math.round((end - startOfDay(new Date())) / 864e5);
    const plan = PLAN_LABEL[s.plan] || s.plan;
    if (days < 0) return { cls: 'expired', tag: 'Vencido', detail: `${plan} · venceu em ${fmtDate(end)}` };
    if (days === 0) return { cls: 'soon', tag: 'Vence hoje', detail: `${plan} · ${fmtDate(end)}` };
    if (days <= 7) return { cls: 'soon', tag: `Vence em ${days} dia${days > 1 ? 's' : ''}`, detail: `${plan} · até ${fmtDate(end)}` };
    return { cls: 'active', tag: 'Ativo', detail: `${plan} · até ${fmtDate(end)}` };
  }

  // Re-render client lists only where visible; the Clientes tab renders when opened.
  // Coalesced into one frame, so clients and plan statuses arriving together draw the list once.
  let clientsChangedFrame = 0;
  function clientsChanged() {
    state.clientsDirty = true;
    if (clientsChangedFrame) return;
    clientsChangedFrame = requestAnimationFrame(() => {
      clientsChangedFrame = 0;
      if (!$('#view-clients').hidden && state.clientsDirty) renderClients();
      if (!$('#client-options').hidden) renderCombo();
    });
  }

  // Days until the client's plan ends (negative = expired), null = no plan. Class as in subStatus().
  function subDays(clientId) {
    const sub = state.subs?.get(clientId);
    return sub ? Math.round((parseISODate(sub.plan_end) - startOfDay(new Date())) / 864e5) : null;
  }
  const statusOf = (days) => (days == null ? 'none' : days < 0 ? 'expired' : days <= 7 ? 'soon' : 'active');

  // WhatsApp link with a renewal message that fits the plan status
  function whatsappLink(c) {
    const sub = state.subs?.get(c.id);
    const days = subDays(c.id);
    const plan = sub ? `seu plano ${PLAN_LABEL[sub.plan] || sub.plan}` : '';
    const end = sub ? fmtDate(parseISODate(sub.plan_end)) : '';
    let text = `Olá, ${firstName(c.name)}!`;
    if (days != null && days < 0) text += ` ${plan[0].toUpperCase() + plan.slice(1)} no Studio Fitness venceu em ${end}. Bora voltar a treinar? 💪`;
    else if (days === 0) text += ` ${plan[0].toUpperCase() + plan.slice(1)} no Studio Fitness vence hoje. Bora renovar? 💪`;
    else if (days != null && days <= 7) text += ` ${plan[0].toUpperCase() + plan.slice(1)} no Studio Fitness vence em ${end}. Bora renovar? 💪`;
    return `https://wa.me/55${c.phone}?text=${encodeURIComponent(text)}`;
  }

  const FILTER_EMPTY = {
    soon: 'Nenhum plano vencendo nos próximos 7 dias.',
    expired: 'Nenhum plano vencido.',
    active: 'Nenhum cliente com plano ativo.',
    none: 'Todos os clientes têm plano.',
  };
  state.clientFilter = 'all';

  // Counts per status on the filter chips (all clients, ignoring the search)
  function renderClientFilters() {
    const box = $('#client-filters');
    box.hidden = !state.subs;
    if (!state.subs) return;
    const counts = { all: state.clients.length, soon: 0, expired: 0, active: 0, none: 0 };
    for (const c of state.clients) counts[statusOf(subDays(c.id))]++;
    box.querySelectorAll('.chip').forEach((chip) => {
      chip.querySelector('.chip-count').textContent = num.format(counts[chip.dataset.filter]);
      chip.classList.toggle('active', chip.dataset.filter === state.clientFilter);
    });
  }

  function renderClients({ counts = true } = {}) {
    state.clientsDirty = false;
    state.clientsDay = toISODate(new Date());
    if (counts) renderClientFilters();
    const q = $('#clients-search').value.trim();
    let items = matchClients(q);
    const f = state.subs ? state.clientFilter : 'all';
    if (f !== 'all') {
      items = items.filter((c) => statusOf(subDays(c.id)) === f);
      const end = (c) => state.subs.get(c.id).plan_end;
      // Vencendo: soonest first. Vencidos: most recent first (the likeliest to renew).
      if (f === 'soon') items.sort((a, b) => end(a).localeCompare(end(b)));
      if (f === 'expired') items.sort((a, b) => end(b).localeCompare(end(a)));
    }
    const empty = q ? 'Nenhum cliente encontrado.' : (FILTER_EMPTY[f] || 'Nenhum cliente cadastrado.');
    renderList($('#clients-list'), items, (c) => {
      const li = el('li');
      const parts = c.name.split(' ').filter(Boolean);
      const initials = (parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
      const info = el('div');
      info.append(el('div', 'row-name', c.name));
      info.append(el('div', 'row-meta', [showCpf(c.cpf) || 'Sem CPF', fmtPhone(c.phone)].filter(Boolean).join(' · ')));
      if (state.subs) {
        const st = subStatus(c.id);
        const line = el('div', `sub sub-${st.cls}`);
        line.append(el('span', 'sub-tag', st.tag));
        if (st.detail) line.append(el('span', 'sub-detail', st.detail));
        info.append(line);
      }
      li.append(el('span', 'avatar', initials), info);
      if (c.phone) {
        const wa = el('a', 'row-wa');
        wa.href = whatsappLink(c);
        wa.target = '_blank';
        wa.rel = 'noopener';
        wa.setAttribute('aria-label', `WhatsApp de ${c.name}`);
        wa.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-wa"/></svg>';
        wa.addEventListener('click', (e) => e.stopPropagation()); // don't open the edit form
        li.append(wa);
      }
      li.addEventListener('click', () => openClientForm(c));
      return li;
    }, el('li', 'muted', empty), { lazy: true });
  }

  $('#client-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.clientFilter = chip.dataset.filter;
    $$('#client-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderClients({ counts: false });
    window.scrollTo(0, 0);
  });

  function openClientForm(c) {
    $('#client-id').value = c?.id ?? '';
    $('#client-name').value = c?.name ?? '';
    $('#client-cpf').value = showCpf(c?.cpf);
    $('#client-phone').value = fmtPhone(c?.phone);
    showError($('#client-error'), '');
    $('#client-form').hidden = false;
    $('#client-name').focus();
    window.scrollTo(0, 0);
  }

  let clientsSearchFrame = 0; // at most one re-render per frame while typing
  const clientsSearch = $('#clients-search');
  const clientsSearchClear = $('#clients-search-clear');
  clientsSearchClear.addEventListener('click', () => {
    clientsSearch.value = '';
    clientsSearchClear.hidden = true;
    renderClients();
    clientsSearch.focus();
  });
  clientsSearch.addEventListener('input', () => {
    clientsSearchClear.hidden = !clientsSearch.value;
    cancelAnimationFrame(clientsSearchFrame);
    clientsSearchFrame = requestAnimationFrame(() => renderClients({ counts: false }));
  });
  $('#client-new').addEventListener('click', () => openClientForm(null));
  $('#client-cancel').addEventListener('click', () => { $('#client-form').hidden = true; });
  $('#client-cpf').addEventListener('input', (e) => { e.target.value = fmtCpf(e.target.value); });
  ['#client-phone', '#modal-client-phone'].forEach((sel) => $(sel).addEventListener('input', (e) => { e.target.value = fmtPhone(e.target.value); }));

  // Shared checks of both client forms. Returns { row } or { error }.
  function clientRow(nameInput, cpfInput, phoneInput, selfId) {
    const name = normName(nameInput.value);
    const cpf = cpfInput.value.replace(/\D/g, '') || CPF_NONE;
    const phone = phoneInput.value.replace(/\D/g, '');
    if (!name) return { error: 'Informe o nome.' };
    if (cpf.length !== 11) return { error: 'CPF deve ter 11 dígitos (ou deixe em branco).' };
    const dup = cpf !== CPF_NONE && state.clients.find((c) => c.cpf === cpf && String(c.id) !== String(selfId ?? ''));
    if (dup) return { error: `CPF já cadastrado para ${dup.name}.` };
    if (phone && phone.length !== 10 && phone.length !== 11) return { error: 'WhatsApp com DDD: (35) 99999-9999.' };
    return { row: { name, cpf, ...(state.hasPhone ? { phone: phone || null } : {}) } };
  }
  const saveErrorText = (error, fallback) => (error?.code === '23505' ? 'CPF já cadastrado para outro cliente.' : fallback);

  $('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#client-id').value;
    const { row, error: invalid } = clientRow($('#client-name'), $('#client-cpf'), $('#client-phone'), id);
    if (invalid) return showError($('#client-error'), invalid);

    const { error } = id
      ? await sb.from('clients').update(row).eq('id', id)
      : await sb.from('clients').insert(row);
    if (error) { console.error(error); return showError($('#client-error'), saveErrorText(error, 'Erro ao salvar cliente.')); }

    $('#client-form').hidden = true;
    toast(id ? 'Cliente atualizado.' : 'Cliente cadastrado.');
    loadClients();
  });

  // ───────────────────────── Config: database usage (Anderson only) ─────────────────────────
  // Free plan limits. Only the database size can be measured from the app (via db_usage());
  // bandwidth is only reported in the Supabase dashboard, which needs a secret key we can't ship.
  const LIMITS = { dbBytes: 500 * 1024 * 1024, users: 50000 };
  const num = new Intl.NumberFormat('pt-BR');
  const dec1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const fmtBytes = (b) => (b < 1024 * 1024 ? `${num.format(Math.max(1, Math.round(b / 1024)))} KB` : `${dec1.format(b / 1024 / 1024)} MB`);
  $('#supabase-link').href = `https://supabase.com/dashboard/project/${new URL(CFG.supabaseUrl).hostname.split('.')[0]}`;

  function usageRow(k, v, sub) {
    const li = el('li');
    const vEl = el('span', 'v', v);
    if (sub) vEl.append(el('small', null, sub));
    li.append(el('span', 'k', k), vEl);
    return li;
  }

  let usageReq = 0;
  async function loadUsage() {
    const req = ++usageReq;
    $('#usage-updated').textContent = 'Atualizando…';
    const { data, error } = await sb.rpc('db_usage');
    if (req !== usageReq) return;
    renderUsage(error ? null : data);
    if (error) console.error(error);
  }

  function renderUsage(u) {
    const errBox = $('#usage-error');
    $('#usage-body').hidden = !u;
    errBox.hidden = !!u;
    $('#usage-updated').textContent = u ? `Atualizado às ${fmtDateTime(new Date()).slice(11)}` : '';
    $('#plan-rows').replaceChildren(
      usageRow('Logins no mês', u ? `${num.format(u.users_month)} de ${num.format(LIMITS.users)}` : `até ${num.format(LIMITS.users)}`, u ? `${u.users} cadastrados · cadastro público bloqueado` : null),
      usageRow('Pausa automática', 'após 7 dias parado', 'qualquer acesso ao app conta como uso'),
    );
    if (!u) {
      errBox.textContent = 'Não foi possível ler o uso do banco. Se for a primeira vez, rode supabase/004_usage.sql no SQL Editor do Supabase.';
      return;
    }

    const pct = (u.db_bytes / LIMITS.dbBytes) * 100;
    const level = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
    $('#db-used').textContent = fmtBytes(u.db_bytes);
    const pctEl = $('#db-pct');
    pctEl.textContent = `${pct < 1 ? dec1.format(Math.max(pct, 0.1)) : num.format(Math.round(pct))}% usado`;
    pctEl.className = `usage-pct ${level}`;
    const fill = $('#db-meter-fill');
    fill.style.width = `${Math.min(100, pct)}%`;
    fill.className = `meter-fill ${level}`;
    $('#db-meter').setAttribute('aria-valuenow', String(Math.round(pct)));

    const system = Math.max(0, u.db_bytes - u.sales_bytes - u.clients_bytes);
    $('#db-rows').replaceChildren(
      usageRow('Vendas', fmtBytes(u.sales_bytes), `${num.format(u.sales_rows)} registros`),
      usageRow('Clientes', fmtBytes(u.clients_bytes), `${num.format(u.clients_rows)} registros`),
      usageRow('Sistema do Supabase', fmtBytes(system), 'logins e estrutura interna'),
      usageRow('Livre', fmtBytes(Math.max(0, LIMITS.dbBytes - u.db_bytes))),
    );

    // Growth forecast from the last 90 days (or since the first sale, if newer).
    const forecast = $('#db-forecast');
    if (!u.sales_rows || !u.first_sale) {
      forecast.textContent = 'Ainda não há vendas para estimar o crescimento.';
      return;
    }
    const daysOfData = Math.min(90, Math.max(1, (Date.now() - new Date(u.first_sale)) / 864e5));
    const perDay = u.sales_90d / daysOfData;
    // A sale costs its row plus ~150 bytes of row header and index entries.
    const perYear = perDay * 365 * (u.row_bytes + 150);
    const years = perYear > 0 ? (LIMITS.dbBytes - u.db_bytes) / perYear : Infinity;
    const yearsText = years > 100 ? 'mais de 100 anos' : years >= 2 ? `cerca de ${num.format(Math.floor(years))} anos` : `cerca de ${num.format(Math.max(1, Math.floor(years * 12)))} meses`;
    forecast.textContent = perDay > 0
      ? `No ritmo atual (≈ ${dec1.format(perDay)} vendas por dia), o banco cresce ≈ ${fmtBytes(perYear)} por ano. Espaço para ${yearsText}.`
      : 'Nenhuma venda nos últimos 90 dias: o banco não está crescendo.';
  }

  $('#usage-refresh').addEventListener('click', loadUsage);

  // ───────────────────────── Configurações: backup and wipe (Anderson only) ─────────────────────────
  // Backup = one .zip with vendas.csv and clientes.csv in the raw database format (comma separated,
  // ISO dates, dot decimals, original ids). Restoring keeps the receipt numbers, so it needs SQL
  // (ids are "generated always"): load the CSVs into temp tables, then insert … overriding system value.
  const SALE_COLS = ['id', 'created_at', 'client_id', 'client_name', 'amount', 'payment_method', 'class_time', 'plan',
    'days_per_week', 'plan_start', 'plan_end', 'notes', 'signature', 'created_by'];
  const CLIENT_COLS = ['id', 'name', 'cpf', 'created_at'];
  const BACKUP_README = [
    'Backup do Studio Fitness',
    '',
    'vendas.csv   - todas as vendas',
    'clientes.csv - todos os clientes',
    '',
    'Formato do banco (separado por virgula, datas AAAA-MM-DD, valores com ponto),',
    'com os numeros originais dos recibos e dos clientes.',
    'Para recuperar os dados no app, peca ajuda a quem configurou o sistema.',
    'Para abrir no Excel: Dados -> De Texto/CSV -> origem UTF-8, delimitador virgula.',
    'Para uma planilha de vendas facil de ler, use Historico -> CSV no app.',
  ].join('\r\n');

  function rawCsv(cols, rows) {
    const cell = (v) => {
      if (v == null) return '';
      const t = String(v);
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  // Minimal .zip writer (files stored without compression; a year of sales is well under 1 MB).
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      parts.push(local, name, data);
      central.push(cen, name);
      offset += 30 + name.length + data.length;
    }
    const cenSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  state.backup = null; // { at, maxSale, maxClient, sales, clients } — the wipe only deletes the sales this covers

  $('#backup-btn').addEventListener('click', async () => {
    const btn = $('#backup-btn');
    const errBox = $('#backup-error');
    showError(errBox, '');
    btn.disabled = true;
    try {
      const [sales, clients] = await Promise.all([
        fetchAll(() => sb.from('sales').select(SALE_COLS.join(',')).order('id')),
        fetchAll(() => sb.from('clients').select(CLIENT_COLS.join(',')).order('id')),
      ]);
      const stamp = toISODate(new Date());
      download(makeZip([
        { name: 'vendas.csv', text: rawCsv(SALE_COLS, sales) },
        { name: 'clientes.csv', text: rawCsv(CLIENT_COLS, clients) },
        { name: 'LEIA-ME.txt', text: BACKUP_README },
      ]), `studio-fitness-backup_${stamp}.zip`);
      state.backup = {
        at: new Date(),
        maxSale: sales.length ? sales[sales.length - 1].id : 0,
        maxClient: clients.length ? clients[clients.length - 1].id : 0,
        sales: sales.length,
        clients: clients.length,
      };
      const status = $('#backup-status');
      status.textContent = `Backup baixado às ${fmtDateTime(state.backup.at).slice(11)}: ${num.format(sales.length)} vendas e ${num.format(clients.length)} clientes.`;
      status.hidden = false;
      $('#wipe-btn').disabled = false;
      $('#wipe-hint').hidden = true;
    } catch (err) {
      console.error(err);
      showError(errBox, 'Não foi possível gerar o backup. Verifique a internet e tente de novo.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── Configurações: import clients (Anderson only) ─────────────────────────
  // Reads a spreadsheet (.xlsx or .csv) on the phone, finds the CPF and name columns by their content,
  // and registers every client not yet in the app. Clients without CPF get CPF_NONE. The file never
  // leaves the device except as the new client rows; running it again only adds what is missing.
  const IMPORT_BATCH = 500;

  // Minimal .zip reader for .xlsx (deflate via the browser's DecompressionStream).
  async function readZip(buf) {
    const v = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');
    const count = v.getUint16(eocd + 10, true);
    const dec = new TextDecoder();
    const files = new Map();
    for (let i = 0, p = v.getUint32(eocd + 16, true); i < count; i++) {
      const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      files.set(dec.decode(new Uint8Array(buf, p + 46, nameLen)), { method, size, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return async (name) => {
      const f = files.get(name);
      if (!f) return null;
      const start = f.local + 30 + v.getUint16(f.local + 26, true) + v.getUint16(f.local + 28, true);
      const raw = new Uint8Array(buf, start, f.size);
      if (f.method === 0) return dec.decode(raw);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    };
  }

  const xmlDoc = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const xmlAll = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));
  const xmlText = (node) => xmlAll(node, 't').map((t) => t.textContent).join('');
  const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

  // Rows of the workbook's first sheet, as arrays of cell texts (numbers as written in the file).
  async function readXlsx(buf) {
    const read = await readZip(buf);
    const shared = xmlAll(xmlDoc((await read('xl/sharedStrings.xml')) || '<sst/>'), 'si').map(xmlText);
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = xmlAll(xmlDoc(wb), 'sheet')[0];
      const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = xmlAll(xmlDoc(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) { const t = rel.getAttribute('Target'); sheetPath = t.startsWith('/') ? t.slice(1) : `xl/${t}`; }
    }
    const sheet = await read(sheetPath);
    if (!sheet) throw new Error('no sheet');
    return xmlAll(xmlDoc(sheet), 'row').map((row) => {
      const out = [];
      xmlAll(row, 'c').forEach((c, i) => {
        const ref = c.getAttribute('r');
        const type = c.getAttribute('t');
        const val = xmlAll(c, 'v')[0]?.textContent ?? '';
        out[ref ? colIndex(ref) : i] = type === 's' ? (shared[Number(val)] ?? '') : type === 'inlineStr' ? xmlText(c) : val;
      });
      return Array.from(out, (x) => x ?? '');
    });
  }

  // CSV with , or ; (Excel in pt-BR uses ;), quotes allowed.
  function readCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // The CPF column is the one with the most 11-digit values; the name column the one with the most letters.
  function parseClientRows(rows) {
    const width = Math.max(0, ...rows.map((r) => r.length));
    const score = (test) => Array.from({ length: width }, (_, c) => rows.reduce((n, r) => n + (test(String(r[c] ?? '')) ? 1 : 0), 0));
    const cpfScore = score((s) => /^[\d.\-\s/]*$/.test(s) && s.replace(/\D/g, '').length === 11);
    const nameScore = score((s) => /[A-Za-zÀ-ÿ]{2,}/.test(s));
    const cpfCol = cpfScore.indexOf(Math.max(...cpfScore));
    const nameCol = nameScore.indexOf(Math.max(...nameScore));
    if (nameCol < 0 || !nameScore[nameCol]) return null;
    const out = [];
    for (const r of rows) {
      const name = normName(String(r[nameCol] ?? ''));
      if (!name || /^NOMES?( DO CLIENTE| COMPLETO)?$/.test(name)) continue; // empty row or header
      const raw = cpfCol >= 0 && cpfCol !== nameCol ? String(r[cpfCol] ?? '').trim() : '';
      let cpf = raw.replace(/\D/g, '');
      if (cpf.length > 0 && cpf.length < 11 && /^\d+$/.test(raw)) cpf = cpf.padStart(11, '0'); // Excel dropped the leading zeros
      out.push({ name, cpf: cpf.length === 11 ? cpf : CPF_NONE });
    }
    return out;
  }

  let importPending = null; // rows ready to insert after the file was read

  function resetImport() {
    importPending = null;
    $('#import-confirm').hidden = true;
    $('#import-btn').hidden = false;
  }

  $('#import-btn').addEventListener('click', () => { $('#import-file').value = ''; $('#import-file').click(); });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const errBox = $('#import-error');
    const status = $('#import-status');
    showError(errBox, '');
    status.hidden = true;
    resetImport();
    if (!file) return;
    let rows;
    try {
      const buf = await file.arrayBuffer();
      const isZip = buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
      rows = parseClientRows(isZip ? await readXlsx(buf) : readCsv(new TextDecoder().decode(buf)));
    } catch (err) {
      console.error(err);
      return showError(errBox, 'Não foi possível ler a planilha. Use um arquivo .xlsx ou .csv.');
    }
    if (!rows || !rows.length) return showError(errBox, 'Nenhum cliente encontrado na planilha.');

    // Skip who is already in the app (or earlier in the file): same CPF, or same name when there is no CPF.
    const cpfs = new Set(state.clients.map((c) => c.cpf).filter((c) => c && c !== CPF_NONE));
    const names = new Set(state.clients.map((c) => c.name));
    const fresh = [];
    for (const r of rows) {
      if (r.cpf !== CPF_NONE ? cpfs.has(r.cpf) : names.has(r.name)) continue;
      if (r.cpf !== CPF_NONE) cpfs.add(r.cpf);
      names.add(r.name);
      fresh.push(r);
    }
    const noCpf = fresh.filter((r) => r.cpf === CPF_NONE).length;
    const skipped = rows.length - fresh.length;
    status.textContent = `${num.format(rows.length)} clientes na planilha: ${num.format(fresh.length)} novos`
      + (noCpf ? ` (${num.format(noCpf)} sem CPF)` : '')
      + (skipped ? `, ${num.format(skipped)} já cadastrados ou repetidos.` : '.');
    status.hidden = false;
    if (!fresh.length) return;
    status.textContent += ' Nada foi salvo ainda: toque no botão abaixo para cadastrar.';
    importPending = fresh;
    const ok = $('#import-confirm');
    ok.textContent = `Cadastrar ${num.format(fresh.length)} clientes`;
    ok.hidden = false;
    $('#import-btn').hidden = true;
  });

  $('#import-confirm').addEventListener('click', async () => {
    const rows = importPending;
    if (!rows) return;
    const btn = $('#import-confirm');
    const errBox = $('#import-error');
    const status = $('#import-status');
    showError(errBox, '');
    btn.disabled = true;
    let done = 0;
    try {
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const { error } = await sb.from('clients').insert(rows.slice(i, i + IMPORT_BATCH));
        if (error) throw error;
        done += Math.min(IMPORT_BATCH, rows.length - i);
        btn.textContent = `Cadastrando… ${num.format(done)} de ${num.format(rows.length)}`;
      }
      status.textContent = `${num.format(done)} clientes cadastrados.`;
      toast(`${num.format(done)} clientes importados.`);
    } catch (err) {
      console.error(err);
      status.textContent = `${num.format(done)} de ${num.format(rows.length)} clientes cadastrados.`;
      showError(errBox, err?.code === '23505'
        ? 'A importação parou: um CPF da planilha já está cadastrado (talvez em outro celular agora há pouco). Escolha a planilha de novo para cadastrar o que faltou.'
        : 'A importação parou (verifique a internet). Escolha a planilha de novo para cadastrar o que faltou.');
    } finally {
      await loadClients(); // the next file is compared against the clients just saved, so nothing repeats
      btn.disabled = false;
      resetImport();
      loadUsage();
    }
  });

  const wipeModal = $('#wipe-modal');
  $('#wipe-btn').addEventListener('click', () => {
    const b = state.backup;
    if (!b) return;
    const text = $('#wipe-modal-text');
    text.replaceChildren(
      'Serão apagadas ', el('strong', null, `${num.format(b.sales)} vendas`),
      ` (tudo o que está no backup das ${fmtDateTime(b.at).slice(11)}). Vendas feitas depois do backup continuam. `,
      el('strong', null, 'Os clientes continuam'), ' (ficam Sem plano), e os logins também. Não dá para desfazer.',
    );
    $('#wipe-modal-word').value = '';
    $('#wipe-modal-current').value = '';
    $('#wipe-modal-current-label').textContent = `Senha atual de ${CFG.users.owner.label}`;
    showError($('#wipe-modal-error'), '');
    wipeModal.showModal();
    $('#wipe-modal-word').focus();
  });
  $('#wipe-modal-cancel').addEventListener('click', () => wipeModal.close());
  wipeModal.addEventListener('click', (e) => { if (e.target === wipeModal) wipeModal.close(); }); // tap on backdrop
  wipeModal.addEventListener('close', () => { $('#wipe-modal-current').value = ''; });

  $('#wipe-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = state.backup;
    const errBox = $('#wipe-modal-error');
    if (!b) return wipeModal.close();
    if ($('#wipe-modal-word').value.trim().toUpperCase() !== 'APAGAR') return showError(errBox, 'Digite APAGAR para confirmar.');
    const current = $('#wipe-modal-current').value;
    if (!current) return showError(errBox, 'Digite a senha atual.');
    const btn = $('#wipe-modal-ok');
    btn.disabled = true;
    try {
      const { data: { user } } = await sb.auth.getUser();
      const check = await sb.auth.signInWithPassword({ email: user?.email || CFG.users.owner.email, password: current });
      if (check.error) return showError(errBox, 'Senha atual incorreta.');

      // Clients are never deleted. max_client_id: 0 also keeps them on a database still running the old
      // wipe_data() from 006_wipe.sql (it deleted clients up to that id); 010_wipe_sales_only.sql ignores it.
      const { data, error } = await sb.rpc('wipe_data', { max_sale_id: b.maxSale, max_client_id: 0 });
      if (error) {
        console.error(error);
        return showError(errBox, error.code === 'PGRST202'
          ? 'Falta configurar: rode supabase/006_wipe.sql no Supabase.'
          : 'Não foi possível apagar. Nada foi apagado. Tente de novo.');
      }
      wipeModal.close();
      // A new wipe needs a new backup.
      state.backup = null;
      $('#wipe-btn').disabled = true;
      $('#wipe-hint').hidden = false;
      $('#backup-status').hidden = true;
      historyCache.clear(); state.insights = null;
      state.subs = state.subs && new Map();
      loadClients();
      loadSubscriptions();
      loadUsage();
      toast(`Apagadas: ${num.format(data?.sales ?? 0)} vendas. Os clientes continuam.`);
    } catch (err) {
      console.error(err);
      showError(errBox, 'Sem conexão. Tente de novo.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── Configurações: passwords (Anderson only) ─────────────────────────
  // Anderson's own password goes through Supabase Auth; the Professor's through set_teacher_password()
  // (supabase/005_passwords.sql). Either change needs a confirmation with Anderson's current password.
  const PW_MIN = 6;
  $$('[data-label]').forEach((n) => { n.textContent = CFG.users[n.dataset.label].label; });
  const pwModal = $('#pw-modal');
  let pwPending = null; // { target, password, form }

  $$('.pw-form').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = form.dataset.target;
    const pass = $(`#pw-${target}-new`);
    const repeat = $(`#pw-${target}-repeat`);
    const errBox = $(`#pw-${target}-error`);
    if (pass.value.length < PW_MIN) { pass.classList.add('invalid'); return showError(errBox, `A senha precisa ter pelo menos ${PW_MIN} caracteres.`); }
    if (pass.value !== repeat.value) { repeat.classList.add('invalid'); return showError(errBox, 'As duas senhas não são iguais.'); }
    showError(errBox, '');

    pwPending = { target, password: pass.value, form };
    const owner = CFG.users.owner.label;
    const label = CFG.users[target].label;
    $('#pw-modal-heading').textContent = `Trocar senha de ${label}?`;
    const text = $('#pw-modal-text');
    text.replaceChildren();
    if (target === 'owner') {
      text.append('A senha de ', el('strong', null, owner), ' vai mudar. Use a nova senha no próximo login.');
    } else {
      text.append('A senha de ', el('strong', null, label), ' vai mudar. Quem estiver conectado como ', el('strong', null, label),
        ' vai precisar entrar de novo com a nova senha (em até 1 hora).');
    }
    $('#pw-modal-current-label').textContent = `Para confirmar, digite a senha atual de ${owner}`;
    $('#pw-modal-current').value = '';
    showError($('#pw-modal-error'), '');
    pwModal.showModal();
    $('#pw-modal-current').focus();
  }));

  $$('.pw-form input').forEach((i) => i.addEventListener('input', () => i.classList.remove('invalid')));
  const closePwModal = () => { pwModal.close(); pwPending = null; };
  $('#pw-modal-cancel').addEventListener('click', closePwModal);
  pwModal.addEventListener('click', (e) => { if (e.target === pwModal) closePwModal(); }); // tap on backdrop
  pwModal.addEventListener('close', () => { pwPending = null; $('#pw-modal-current').value = ''; });

  $('#pw-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pwPending) return;
    const { target, password, form } = pwPending;
    const errBox = $('#pw-modal-error');
    const current = $('#pw-modal-current').value;
    if (!current) return showError(errBox, 'Digite a senha atual.');
    const btn = $('#pw-modal-ok');
    btn.disabled = true;
    try {
      // Check the current password (also refreshes the login, which Supabase may require to change a password).
      const { data: { user } } = await sb.auth.getUser();
      const check = await sb.auth.signInWithPassword({ email: user?.email || CFG.users.owner.email, password: current });
      if (check.error) return showError(errBox, 'Senha atual incorreta.');

      const { error } = target === 'owner'
        ? await sb.auth.updateUser({ password })
        : await sb.rpc('set_teacher_password', { new_password: password });
      if (error) {
        console.error(error);
        const msg = error.code === 'same_password' ? 'A nova senha é igual à atual.'
          : error.code === 'weak_password' ? `Senha fraca: use pelo menos ${PW_MIN} caracteres.`
          : error.code === 'PGRST202' ? 'Falta configurar: rode supabase/005_passwords.sql no Supabase.'
          : 'Não foi possível trocar a senha. Tente de novo.';
        return showError(errBox, msg);
      }
      form.reset();
      closePwModal();
      toast(`Senha de ${CFG.users[target].label} alterada.`);
    } catch (err) {
      console.error(err);
      showError(errBox, 'Sem conexão. Tente de novo.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── Sale form ─────────────────────────
  const saleForm = $('#sale-form');
  const amountInput = $('#sale-amount');
  const radioValue = (name) => saleForm.querySelector(`input[name="${name}"]:checked`)?.value;

  // Class times: 05:00 → 21:00 every 30 min
  (function fillTimes() {
    const sel = $('#sale-time');
    for (let m = 5 * 60; m <= 21 * 60; m += 30) {
      const t = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
      const o = el('option', null, t);
      o.value = t;
      if (t === '07:00') o.defaultSelected = true; // default, also restored by "Limpar"
      sel.append(o);
    }
  })();

  // Money mask: digits typed are cents (like a card machine)
  const amountCents = () => parseInt(amountInput.value.replace(/\D/g, '') || '0', 10);
  amountInput.addEventListener('input', () => {
    amountInput.value = fmtMoney(amountCents() / 100);
  });
  amountInput.addEventListener('focus', () => {
    requestAnimationFrame(() => amountInput.setSelectionRange(amountInput.value.length, amountInput.value.length));
  });

  function planDates() {
    const start = startOfDay(new Date());
    const end = addMonths(start, PLAN_MONTHS[radioValue('plan')]);
    return { start, end };
  }

  // Observação is pre-filled with the plan period and stays editable.
  // When the plan changes, only the auto-generated text is swapped; anything else typed is kept.
  let lastAutoNote = '';
  function updateNotes() {
    const { start, end } = planDates();
    const auto = `Plano ${PLAN_LABEL[radioValue('plan')]}: ${fmtDate(start)} a ${fmtDate(end)}`;
    const notes = $('#sale-notes');
    if (!notes.value.trim()) notes.value = auto;
    else if (lastAutoNote && notes.value.includes(lastAutoNote)) notes.value = notes.value.replace(lastAutoNote, auto);
    lastAutoNote = auto;
  }

  saleForm.querySelectorAll('input[name="plan"]').forEach((r) => r.addEventListener('change', updateNotes));
  saleForm.addEventListener('reset', () => {
    state.selectedClient = null;
    $('#sale-client-clear').hidden = true;
    setTimeout(() => {
      saleForm.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
      showError($('#sale-error'), '');
      updateNotes();
    });
  });
  saleForm.addEventListener('input', (e) => {
    e.target.classList.remove('invalid');
    e.target.closest('.pills')?.classList.remove('invalid');
  });

  // ── Client picker: lists every client, filters while typing, offers "Cadastrar" when nothing matches
  const comboInput = $('#sale-client');
  const comboList = $('#client-options');
  const COMBO_MAX = 100;
  let comboItems = [];   // [{ li, action }]
  let comboActive = -1;
  state.selectedClient = null;

  const searchKey = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

  function matchClients(q) {
    const words = searchKey(q).split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, '');
    if (!words.length) return state.clients;
    return state.clients.filter((c) => {
      const name = c.key ?? searchKey(c.name);
      return words.every((w) => name.includes(w))
        || (digits.length >= 3 && c.cpf && c.cpf !== CPF_NONE && c.cpf.includes(digits)) // "000" mustn't list everyone without CPF
        || (digits.length >= 4 && !!c.phone && c.phone.includes(digits));
    });
  }

  function setComboActive(i) {
    comboActive = i;
    comboItems.forEach(({ li }, k) => li.setAttribute('aria-selected', String(k === i)));
    const cur = comboItems[i]?.li;
    if (cur) { comboInput.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
    else comboInput.removeAttribute('aria-activedescendant');
  }

  function comboOption(id, className, children, action) {
    const li = el('li', className);
    li.id = id;
    li.setAttribute('role', 'option');
    li.append(...children);
    li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
    li.addEventListener('click', action);
    comboItems.push({ li, action });
    return li;
  }

  function renderCombo() {
    const q = comboInput.value;
    const found = matchClients(q);
    comboItems = [];
    const nodes = found.slice(0, COMBO_MAX).map((c) => comboOption(`opt-${c.id}`, null, [
      el('span', 'combo-name', c.name),
      ...(showCpf(c.cpf) ? [el('span', 'combo-cpf', showCpf(c.cpf))] : []),
    ], () => selectClient(c)));

    if (found.length > COMBO_MAX) nodes.push(el('li', 'combo-hint', `+${found.length - COMBO_MAX} clientes… continue digitando`));
    // "Cadastrar" is always the last option.
    const typed = /\p{L}/u.test(q) ? normName(q) : ''; // digits only = a CPF search, not a name
    nodes.push(comboOption('opt-create', 'combo-create', [
      el('span', 'combo-plus', '+'),
      el('span', null, typed ? `Cadastrar "${typed}"` : 'Cadastrar novo cliente'),
    ], () => openClientModal(q)));
    comboList.replaceChildren(...nodes);
    setComboActive(q.trim() && comboItems.length ? 0 : -1);
  }

  // The list ends just above the keyboard, so every option can be reached by scrolling the list itself.
  function fitCombo() {
    if (comboList.hidden) return;
    const vv = window.visualViewport;
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const room = visibleBottom - comboInput.getBoundingClientRect().bottom - 20;
    comboList.style.maxHeight = `${Math.max(150, Math.min(280, room))}px`;
  }
  window.visualViewport?.addEventListener('resize', fitCombo);
  window.addEventListener('scroll', fitCombo, { passive: true });

  function openCombo() {
    renderCombo();
    comboList.hidden = false;
    comboInput.setAttribute('aria-expanded', 'true');
    fitCombo();
  }
  // Phones: bring the client box to the top of the screen, leaving room for the list above the keyboard.
  if (touchScreen) {
    comboInput.addEventListener('focus', () => setTimeout(() => {
      comboInput.closest('.panel').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, 300));
  }
  function closeCombo() {
    comboList.hidden = true;
    comboInput.setAttribute('aria-expanded', 'false');
    setComboActive(-1);
  }

  function selectClient(c) {
    state.selectedClient = c;
    comboInput.value = c.name;
    syncComboClear();
    comboInput.classList.remove('invalid');
    showError($('#sale-error'), '');
    closeCombo();
  }

  comboInput.addEventListener('focus', openCombo);
  comboInput.addEventListener('click', () => { if (comboList.hidden) openCombo(); });
  comboInput.addEventListener('input', () => { state.selectedClient = null; syncComboClear(); openCombo(); });
  // Don't close on blur: on touch screens the input loses focus *before* the tap's click fires,
  // so closing there collapses the list and the tap lands on whatever was underneath.
  // Close instead when the user touches or focuses something outside the picker.
  const comboClear = $('#sale-client-clear');
  const syncComboClear = () => { comboClear.hidden = !comboInput.value; };
  const inCombo = (t) => t === comboInput || comboList.contains(t) || comboClear.contains(t);
  comboClear.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
  comboClear.addEventListener('click', () => {
    comboInput.value = '';
    state.selectedClient = null;
    syncComboClear();
    comboInput.focus();
    openCombo();
  });
  document.addEventListener('pointerdown', (e) => { if (!comboList.hidden && !inCombo(e.target)) closeCombo(); }, true);
  document.addEventListener('focusin', (e) => { if (!comboList.hidden && !inCombo(e.target)) closeCombo(); });
  comboInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { closeCombo(); return; }
    if (comboList.hidden && e.key === 'ArrowDown') { openCombo(); e.preventDefault(); return; }
    if (comboList.hidden) return;
    if (e.key === 'ArrowDown') { setComboActive(Math.min(comboActive + 1, comboItems.length - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setComboActive(Math.max(comboActive - 1, 0)); e.preventDefault(); }
    else if (e.key === 'Enter' && comboActive >= 0) { comboItems[comboActive].action(); e.preventDefault(); }
    else if (e.key === 'Escape') { closeCombo(); }
  });

  // ── "Novo cliente" modal
  const clientModal = $('#client-modal');
  const modalName = $('#modal-client-name');
  const modalCpf = $('#modal-client-cpf');

  function openClientModal(q) {
    closeCombo();
    // Typed a name → prefill Nome; typed only digits (a CPF search) → prefill CPF.
    const isName = /\p{L}/u.test(q || '');
    modalName.value = isName ? normName(q) : '';
    modalCpf.value = isName ? '' : fmtCpf(q || '');
    $('#modal-client-phone').value = '';
    showError($('#modal-client-error'), '');
    clientModal.showModal();
    (modalName.value ? modalCpf : modalName).focus();
  }

  modalCpf.addEventListener('input', () => { modalCpf.value = fmtCpf(modalCpf.value); });
  $('#modal-client-cancel').addEventListener('click', () => clientModal.close());
  clientModal.addEventListener('click', (e) => { if (e.target === clientModal) clientModal.close(); }); // tap on backdrop

  $('#client-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#modal-client-error');
    const { row, error: invalid } = clientRow(modalName, modalCpf, $('#modal-client-phone'), null);
    if (invalid) return showError(errBox, invalid);

    const btn = e.submitter || $('#client-modal-form button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await sb.from('clients').insert(row).select(state.hasPhone ? 'id, name, cpf, phone' : 'id, name, cpf').single();
    btn.disabled = false;
    if (error) { console.error(error); return showError(errBox, saveErrorText(error, 'Erro ao cadastrar. Verifique a internet.')); }

    data.key = searchKey(data.name);
    state.clients = [...state.clients, data].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    clientsChanged();
    clientModal.close();
    selectClient(data);
    toast('Cliente cadastrado! 💪');
  });

  saleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#sale-error');
    const timeSelect = $('#sale-time');
    const typedName = normName(comboInput.value);
    const cents = amountCents();
    const days = radioValue('days');

    // The client must be one from the list (picked, or typed exactly as registered)
    let client = state.selectedClient;
    if (!client || client.name !== typedName) client = state.clients.find((c) => c.name === typedName) || null;

    const missing = [];
    if (!typedName) { missing.push('cliente'); comboInput.classList.add('invalid'); }
    if (cents <= 0) { missing.push('valor'); amountInput.classList.add('invalid'); }
    if (!days) { missing.push('dias/semana'); saleForm.querySelector('input[name="days"]').closest('.pills').classList.add('invalid'); }
    if (!timeSelect.value) { missing.push('horário'); timeSelect.classList.add('invalid'); }
    if (missing.length) return showError(errBox, `Preencha: ${missing.join(', ')}.`);
    if (!client) {
      comboInput.classList.add('invalid');
      comboInput.focus();
      return showError(errBox, 'Cliente não cadastrado. Escolha da lista ou toque em "Cadastrar".');
    }
    showError(errBox, '');

    const btn = saleForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const clientName = client.name;
      const { start, end } = planDates();
      const row = {
        client_id: client.id,
        client_name: clientName,
        amount: cents / 100,
        payment_method: radioValue('payment'),
        class_time: timeSelect.value,
        plan: radioValue('plan'),
        days_per_week: days,
        plan_start: toISODate(start),
        plan_end: toISODate(end),
        notes: $('#sale-notes').value.trim() || null,
        signature: $('#sale-signature').value.trim() || null,
      };

      // add_sale() returns the receipt number to both logins (the teacher can't read sales back).
      // Without supabase/007_receipt.sql: plain insert, and only the owner gets the number.
      let saved = {};
      const rpc = await sb.rpc('add_sale', { sale: row });
      if (!rpc.error) saved = rpc.data || {};
      else if (rpc.error.code !== 'PGRST202') throw rpc.error;
      else if (state.role === 'owner') {
        const { data, error } = await sb.from('sales').insert(row).select('id, created_at').single();
        if (error) throw error;
        saved = data;
      } else {
        const { error } = await sb.from('sales').insert(row);
        if (error) throw error;
      }
      const sub = saved.id ? `#${saved.id} · ${clientName}` : clientName;
      const receipt = receiptData({ ...row, id: saved.id, created_at: saved.created_at, cpf: client.cpf });
      historyCache.clear(); state.insights = null;
      // Show the new plan in Clientes right away (the server copy refreshes in the background).
      if (state.subs) {
        const prev = state.subs.get(client.id);
        if (!prev || row.plan_end >= prev.plan_end) {
          state.subs.set(client.id, { client_id: client.id, plan: row.plan, plan_start: row.plan_start, plan_end: row.plan_end });
          clientsChanged();
        }
      }
      loadSubscriptions();
      saleForm.reset();
      celebrate(sub, receipt);
    } catch (err) {
      console.error(err);
      showError(errBox, 'Erro ao salvar a venda. Verifique a internet e tente novamente.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── History ─────────────────────────
  // Anderson reads the sales table (values, totals, exports). The Professor gets the same list without
  // any values through staff_history() (supabase/008_delete_sale.sql). Both can delete a sale.
  const RANGE_LABEL = {
    today: 'Hoje', yesterday: 'Ontem', week: 'Semana passada', month: 'Mês atual',
    lastMonth: 'Mês passado', '6m': 'Últimos 6 meses', '1y': 'Último ano', custom: 'Período',
  };

  // Returns [from, to) in local time.
  function getRange(key) {
    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    switch (key) {
      case 'today': return [today, tomorrow];
      case 'yesterday': return [addDays(today, -1), today];
      case 'week': { // previous Monday → Sunday
        const thisMonday = addDays(today, -((today.getDay() + 6) % 7));
        return [addDays(thisMonday, -7), thisMonday];
      }
      case 'month': return [firstOfMonth, tomorrow];
      case 'lastMonth': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), firstOfMonth];
      case '6m': return [addMonths(today, -6), tomorrow];
      case '1y': return [addMonths(today, -12), tomorrow];
      case 'custom': {
        const f = $('#range-from').value, t = $('#range-to').value;
        if (!f || !t) return null;
        let from = parseISODate(f), to = parseISODate(t);
        if (from > to) [from, to] = [to, from];
        return [from, addDays(to, 1)];
      }
    }
    return null;
  }

  // Cache per date range: switching filters back shows the list instantly, then refreshes quietly.
  const historyCache = new Map(); // "fromISO|toISO" → { rows, at }
  const HISTORY_FRESH_MS = 60 * 1000;
  const sameRows = (a, b) => a.length === b.length && a.every((r, i) => r.id === b[i].id && r.amount === b[i].amount);

  async function loadHistory() {
    const key = state.historyRange;
    const range = getRange(key);
    const status = $('#history-status');
    $('#total-label').textContent = `Total ${RANGE_LABEL[key]}`;

    if (!range) {
      state.history = null;
      state.historyReq = null;
      $('#export-bar').hidden = true;
      clearListJob($('#history-list'));
      $('#history-list').replaceChildren();
      status.textContent = 'Escolha as datas e toque em Filtrar.';
      $('#total-value').textContent = fmtMoney(0);
      return;
    }

    const ck = `${state.role}|${range[0].toISOString()}|${range[1].toISOString()}`;
    state.historyReq = ck;
    const cached = historyCache.get(ck);
    if (cached) renderHistory(key, range, cached.rows);
    else {
      state.history = null;
      $('#export-bar').hidden = true;
      status.textContent = 'Carregando…';
    }
    if (cached && Date.now() - cached.at < HISTORY_FRESH_MS) return;

    let rows;
    try {
      rows = await fetchAll(() => (state.role === 'owner'
        ? sb.from('sales')
          .select('id, created_at, client_id, client_name, amount, payment_method, class_time, plan, days_per_week, plan_start, plan_end, notes, signature, clients(cpf)')
          .gte('created_at', range[0].toISOString())
          .lt('created_at', range[1].toISOString())
        : sb.rpc('staff_history', { from_ts: range[0].toISOString(), to_ts: range[1].toISOString() }))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }));
    } catch (err) {
      console.error(err);
      if (!cached && state.historyReq === ck) {
        status.textContent = err.code === 'PGRST202'
          ? 'Falta configurar: rode supabase/008_delete_sale.sql no Supabase.'
          : 'Erro ao carregar o histórico.';
      }
      return;
    }
    historyCache.set(ck, { rows, at: Date.now() });
    if (state.historyReq !== ck) return; // user switched filter meanwhile
    if (cached && sameRows(cached.rows, rows)) return; // nothing changed, keep what's on screen
    renderHistory(key, range, rows);
  }

  function renderHistory(key, range, rows) {
    const isOwner = state.role === 'owner';
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    $('#total-value').textContent = fmtMoney(total);
    state.history = { key, range, rows, total };
    $('#export-bar').hidden = !rows.length || !isOwner;
    $('#history-status').textContent = `${rows.length === 1 ? '1 venda' : `${rows.length} vendas`} · ${fmtRange(range)}`;

    renderList($('#history-list'), rows, (r) => {
      const li = el('li');
      const top = el('div', 'row');
      const print = el('button', 'row-print');
      print.type = 'button';
      print.setAttribute('aria-label', `Imprimir recibo #${r.id}`);
      print.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-print"/></svg>Recibo';
      print.addEventListener('click', () => reprintReceipt(r, print));
      top.append(el('span', 'row-title', `#${r.id} - ${fmtDateTime(new Date(r.created_at))}`));
      const mid = el('div', 'row');
      mid.append(el('span', 'row-name', r.client_name));
      if (isOwner) mid.append(el('span', 'row-amount', fmtMoney(Number(r.amount))));
      const meta = el('div', 'row-meta', [
        PLAN_LABEL[r.plan],
        isOwner && PAYMENT_LABEL[r.payment_method],
        r.class_time,
        `${r.days_per_week}x/sem`,
        `até ${fmtDate(parseISODate(r.plan_end))}`,
      ].filter(Boolean).join(' · '));
      const del = el('button', 'row-print row-del');
      del.type = 'button';
      del.setAttribute('aria-label', `Apagar venda #${r.id}`);
      del.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg>';
      del.addEventListener('click', () => askDeleteSale(r));
      const edit = el('button', 'row-print row-del');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Editar venda #${r.id}`);
      edit.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-pen"/></svg>';
      edit.addEventListener('click', () => openEditSale(r));
      const btns = el('span', 'row-actions');
      if (isOwner) btns.append(print); // the receipt has the amount: Anderson only
      btns.append(edit, del);
      const bottom = el('div', 'row row-bottom');
      bottom.append(meta, btns);
      li.append(top, mid, bottom);
      return li;
    }, el('li', 'muted', 'Nenhuma venda nesse período. Bora vender!'), { lazy: true });
  }

  // Delete one sale (both logins, whoever registered it) through delete_sale() (supabase/008_delete_sale.sql).
  // The client's plan status is recomputed from their other sales by client_subscriptions().
  const delModal = $('#del-modal');
  let delSale = null;
  function askDeleteSale(r) {
    delSale = r;
    $('#del-modal-heading').textContent = `Apagar a venda #${r.id}?`;
    const items = [
      ['Cliente', r.client_name],
      ['Data', fmtDateTime(new Date(r.created_at))],
      ['Plano', `${PLAN_LABEL[r.plan]} · ${fmtDate(parseISODate(r.plan_start))} a ${fmtDate(parseISODate(r.plan_end))}`],
    ];
    if (state.role === 'owner') items.push(['Valor', `${fmtMoney(Number(r.amount))} · ${PAYMENT_LABEL[r.payment_method]}`]);
    $('#del-modal-summary').replaceChildren(...items.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
    showError($('#del-modal-error'), '');
    delModal.showModal();
  }
  $('#del-modal-cancel').addEventListener('click', () => delModal.close());
  delModal.addEventListener('click', (e) => { if (e.target === delModal) delModal.close(); }); // tap on backdrop
  delModal.addEventListener('close', () => { delSale = null; });

  $('#del-modal-ok').addEventListener('click', async () => {
    const r = delSale;
    if (!r) return delModal.close();
    const btn = $('#del-modal-ok');
    btn.disabled = true;
    try {
      let deleted;
      const rpc = await sb.rpc('delete_sale', { sale_id: r.id });
      if (!rpc.error) deleted = rpc.data;
      else if (rpc.error.code !== 'PGRST202') throw rpc.error;
      else if (state.role === 'owner') { // without 008: Anderson can still delete directly
        const { data, error } = await sb.from('sales').delete().eq('id', r.id).select('id');
        if (error) throw error;
        deleted = data.length;
      } else {
        return showError($('#del-modal-error'), 'Falta configurar: rode supabase/008_delete_sale.sql no Supabase.');
      }
      historyCache.clear(); state.insights = null;
      loadSubscriptions();
      if (!deleted) { // already deleted on another phone, or not allowed (the database deletes nothing)
        delModal.close();
        loadHistory();
        return toast(`A venda #${r.id} não foi apagada (talvez já tenha sido apagada).`);
      }
      delModal.close();
      const h = state.history;
      if (h) renderHistory(h.key, h.range, h.rows.filter((x) => x.id !== r.id));
      toast(`Venda #${r.id} apagada.`);
    } catch (err) {
      console.error(err);
      showError($('#del-modal-error'), 'Não foi possível apagar. Verifique a internet e tente de novo.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── Editar venda (Histórico, both logins) ─────────────────────────
  // Fixes a sale in place through edit_sale() (supabase/011_cpf_phone_edit_sale.sql): same receipt number.
  // The Professor can change client, plan, days, time and start date; value, payment and observação are
  // Anderson's only (hidden for the Professor, and the database ignores them from that login anyway).
  const editModal = $('#edit-modal');
  const editForm = $('#edit-form');
  const editAmount = $('#edit-amount');
  let editSale = null;   // the history row being edited
  let editClient = null; // { id, name, cpf } picked in the dialog
  const editRadio = (name) => editForm.querySelector(`input[name="${name}"]:checked`)?.value;
  const editCents = () => parseInt(editAmount.value.replace(/\D/g, '') || '0', 10);

  // Same pills and times as the sale form
  $('#edit-plan-pills').innerHTML = saleForm.querySelector('.pills-plan').innerHTML.replace(/name="plan"/g, 'name="edit-plan"');
  $('#edit-pay-pills').innerHTML = saleForm.querySelector('.pills-pay').innerHTML.replace(/name="payment"/g, 'name="edit-payment"');
  $('#edit-time').replaceChildren(...$$('#sale-time option').filter((o) => o.value).map((o) => o.cloneNode(true)));

  function editEnd() {
    const start = $('#edit-start').value;
    const months = PLAN_MONTHS[editRadio('edit-plan')];
    return start && months ? addMonths(parseISODate(start), months) : null;
  }
  function showEditEnd() {
    const end = editEnd();
    $('#edit-end').textContent = end ? `Vence em ${fmtDate(end)}` : '';
  }

  function openEditSale(r) {
    editSale = r;
    editClient = state.clients.find((c) => c.id === r.client_id) || (r.client_id ? { id: r.client_id, name: r.client_name } : null);
    $('#edit-heading').textContent = `Editar venda #${r.id}`;
    $('#edit-client').value = r.client_name;
    $('#edit-client-options').hidden = true;
    editForm.querySelectorAll('input[name="edit-plan"]').forEach((i) => { i.checked = i.value === r.plan; });
    // Older sales may have 1 or 4+ days: keep that value as an extra option instead of changing it silently
    const days = ['2', '3', '4', '5'];
    if (!days.includes(r.days_per_week)) days.push(r.days_per_week);
    $('#edit-days-pills').replaceChildren(...days.map((d) => {
      const label = el('label');
      const input = el('input');
      input.type = 'radio'; input.name = 'edit-days'; input.value = d; input.checked = d === r.days_per_week;
      label.append(input, el('span', null, d));
      return label;
    }));
    const time = $('#edit-time');
    if (![...time.options].some((o) => o.value === r.class_time)) {
      const o = el('option', null, r.class_time); o.value = r.class_time; time.prepend(o);
    }
    time.value = r.class_time;
    setDateInput('edit-start', r.plan_start);
    showEditEnd();
    if (state.role === 'owner') {
      editAmount.value = fmtMoney(Number(r.amount));
      editForm.querySelectorAll('input[name="edit-payment"]').forEach((i) => { i.checked = i.value === r.payment_method; });
      $('#edit-notes').value = r.notes || '';
    }
    showError($('#edit-error'), '');
    editModal.showModal();
    editModal.querySelector('.panel').scrollTop = 0;
  }

  // Client: type to search, tap to pick (at most 8 matches)
  const editClientInput = $('#edit-client');
  const editOptions = $('#edit-client-options');
  editClientInput.addEventListener('input', () => {
    const q = editClientInput.value.trim();
    if (!q) { editOptions.hidden = true; return; }
    const found = matchClients(q).slice(0, 8);
    editOptions.replaceChildren(...(found.length ? found.map((c) => {
      const li = el('li');
      li.append(el('span', 'combo-name', c.name), ...(showCpf(c.cpf) ? [el('span', 'combo-cpf', showCpf(c.cpf))] : []));
      li.addEventListener('click', () => {
        editClient = c;
        editClientInput.value = c.name;
        editOptions.hidden = true;
      });
      return li;
    }) : [el('li', 'combo-hint', 'Nenhum cliente encontrado.')]));
    editOptions.hidden = false;
  });
  editForm.addEventListener('change', (e) => { if (e.target.name === 'edit-plan') showEditEnd(); });
  $('#edit-start').addEventListener('change', () => { setDateInput('edit-start', $('#edit-start').value); showEditEnd(); });
  $('#edit-start').addEventListener('click', () => { try { $('#edit-start').showPicker(); } catch (_) { /* opens natively */ } });
  editAmount.addEventListener('input', () => { editAmount.value = fmtMoney(editCents() / 100); });
  $('#edit-cancel').addEventListener('click', () => editModal.close());
  editModal.addEventListener('click', (e) => { if (e.target === editModal) editModal.close(); }); // tap on backdrop
  editModal.addEventListener('close', () => { editSale = null; });

  // Put the saved sale back into the open list and every cached period that has it
  function patchHistoryRow(id, patch) {
    const fix = (rows) => rows.map((x) => (x.id === id ? { ...x, ...patch } : x));
    for (const entry of historyCache.values()) entry.rows = fix(entry.rows);
    const h = state.history;
    if (h) renderHistory(h.key, h.range, fix(h.rows));
  }

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = editSale;
    if (!r) return editModal.close();
    const errBox = $('#edit-error');
    const isOwner = state.role === 'owner';
    if (!editClient || editClientInput.value.trim() !== editClient.name) return showError(errBox, 'Escolha o cliente na lista.');
    const end = editEnd();
    if (!end) return showError(errBox, 'Informe o início do plano.');
    const changes = {
      client_id: editClient.id,
      plan: editRadio('edit-plan'),
      days_per_week: editRadio('edit-days'),
      class_time: $('#edit-time').value,
    };
    const start = $('#edit-start').value;
    if (changes.plan !== r.plan || start !== r.plan_start) { // otherwise keep the dates exactly as they were
      changes.plan_start = start;
      changes.plan_end = toISODate(end);
    }
    if (isOwner) {
      if (editCents() <= 0) return showError(errBox, 'Informe o valor.');
      changes.amount = editCents() / 100;
      changes.payment_method = editRadio('edit-payment');
      changes.notes = $('#edit-notes').value.trim();
    }
    const btn = $('#edit-ok');
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('edit_sale', { sale_id: r.id, changes });
      if (error) {
        console.error(error);
        return showError(errBox, error.code === 'PGRST202' ? 'Falta configurar: rode supabase/011_cpf_phone_edit_sale.sql no Supabase.'
          : error.code === 'P0002' ? 'Essa venda (ou o cliente) não existe mais. Atualize o histórico.'
            : 'Não foi possível salvar. Verifique a internet e tente de novo.');
      }
      editModal.close();
      const client = state.clients.find((c) => c.id === data.client_id);
      patchHistoryRow(r.id, {
        ...data,
        ...(isOwner ? { amount: changes.amount, payment_method: changes.payment_method, notes: changes.notes || null } : {}),
        clients: { cpf: client?.cpf ?? null },
      });
      state.insights = null;
      loadSubscriptions();
      toast(`Venda #${r.id} atualizada.`);
    } catch (err) {
      console.error(err);
      showError(errBox, 'Sem conexão. Tente de novo.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── Insights (Anderson only) ─────────────────────────
  // The last 12 months of sales (this month included), grouped by the phone's local time, never by the
  // UTC date (a sale at 22:00 in Brazil is already the next day in UTC). Charts are plain HTML bars in
  // one color: values are always written next to them, so nothing depends on color alone.
  const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const INSIGHTS_FRESH_MS = 60 * 1000;
  state.insights = null; // { at, rows }
  const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

  async function loadInsights() {
    const status = $('#insights-status');
    if (state.insights) renderInsights(state.insights.rows);
    if (state.insights && Date.now() - state.insights.at < INSIGHTS_FRESH_MS) return;
    if (!state.insights) { status.textContent = 'Carregando…'; $('#insights-body').replaceChildren(); }
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    try {
      const rows = await fetchAll(() => sb.from('sales')
        .select('id, created_at, amount, payment_method, plan, days_per_week, class_time')
        .gte('created_at', from.toISOString())
        .order('created_at').order('id'));
      if (state.role !== 'owner') return; // logged out meanwhile
      state.insights = { at: Date.now(), rows };
      if (!$('#view-insights').hidden) renderInsights(rows);
    } catch (err) {
      console.error(err);
      if (!state.insights) status.textContent = 'Erro ao carregar. Verifique a internet.';
    }
  }

  function insightPanel(title, sub) {
    const panel = el('section', 'panel insight');
    panel.append(el('div', 'panel-head', title));
    if (sub) panel.append(el('p', 'insight-sub', sub));
    return panel;
  }

  // Comparison line: "▲ 12% vs 1–16 de outubro" (arrow + text, not color alone)
  function deltaLine(cur, prev, label) {
    if (!prev) return el('span', 'kpi-delta', cur ? `sem vendas em ${label}` : '');
    const d = Math.round(((cur - prev) / prev) * 100);
    const node = el('span', `kpi-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`, `${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${Math.abs(d)}% vs ${label}`);
    return node;
  }

  function kpi(label, value, extra) {
    const tile = el('div', 'kpi');
    tile.append(el('span', 'kpi-label', label), el('strong', 'kpi-value', value));
    if (extra) tile.append(extra);
    return tile;
  }

  // Horizontal bars: [{ label, value, text }] — bar length = value / biggest value
  function hbars(items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const list = el('ul', 'hbars');
    for (const it of items) {
      const li = el('li', 'hbar');
      const track = el('span', 'hbar-track');
      const fill = el('span', 'hbar-fill');
      fill.style.width = `${(it.value / max) * 100}%`;
      track.append(fill);
      li.append(el('span', 'hbar-label', it.label), track, el('span', 'hbar-value', it.text));
      list.append(li);
    }
    return list;
  }

  // Count and revenue per key, biggest first (or in the given key order)
  function groupBy(sales, keyOf, order) {
    const map = new Map((order || []).map((k) => [k, { key: k, count: 0, total: 0 }]));
    for (const sale of sales) {
      const k = keyOf(sale);
      if (!map.has(k)) map.set(k, { key: k, count: 0, total: 0 });
      const g = map.get(k);
      g.count++; g.total += sale.value;
    }
    const groups = [...map.values()];
    return order ? groups.filter((g) => g.count || order.includes(g.key)) : groups.sort((a, b) => b.count - a.count);
  }

  function monthChart(months) {
    const max = Math.max(1, ...months.map((m) => m.total));
    const best = months.reduce((a, b) => (b.total > a.total ? b : a));
    const withSales = months.filter((m) => m.count);
    const avg = withSales.length ? withSales.reduce((n, m) => n + m.total, 0) / withSales.length : 0;
    const panel = insightPanel('Receita por mês', `Média de ${fmtMoney(avg)} por mês com vendas · melhor: ${MONTHS_SHORT[best.m]}/${String(best.y).slice(2)} (${fmtMoney(best.total)})`);
    const readout = el('p', 'chart-readout');
    const bars = el('div', 'mbars');
    const select = (i) => {
      const m = months[i];
      readout.replaceChildren(el('strong', null, fmtMoney(m.total)),
        ` · ${m.count === 1 ? '1 venda' : `${num.format(m.count)} vendas`} · ${MONTHS_LONG[m.m]} de ${m.y}`);
      [...bars.children].forEach((b, k) => b.classList.toggle('selected', k === i));
    };
    months.forEach((m, i) => {
      const b = el('button', `mbar${i === months.length - 1 ? ' current' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-label', `${MONTHS_LONG[m.m]} de ${m.y}: ${fmtMoney(m.total)}, ${m.count} vendas`);
      const fill = el('span', 'mbar-fill');
      fill.style.height = m.total ? `${Math.max(2, (m.total / max) * 100)}%` : '0';
      const col = el('span', 'mbar-col');
      col.append(fill);
      b.append(col, el('span', 'mbar-label', MONTHS_SHORT[m.m]));
      b.addEventListener('click', () => select(i));
      bars.append(b);
    });
    select(months.length - 1);
    panel.append(readout, bars);
    return panel;
  }

  function renderInsights(rows) {
    const body = $('#insights-body');
    const now = new Date();
    $('#insights-status').textContent = rows.length
      ? `${num.format(rows.length)} vendas desde ${MONTHS_LONG[new Date(now.getFullYear(), now.getMonth() - 11, 1).getMonth()]} de ${now.getFullYear() - (now.getMonth() < 11 ? 1 : 0)}`
      : '';
    const sales = rows.map((r) => ({ ...r, at: new Date(r.created_at), value: Number(r.amount) }));

    // Clients (from client_subscriptions(), also works with no sales in the period)
    let active = 0, soon = 0;
    if (state.subs) for (const c of state.clients) { const st = statusOf(subDays(c.id)); if (st === 'active') active++; if (st === 'soon') soon++; }
    const soonLink = el('button', 'kpi-link', soon ? `${num.format(soon)} vencendo em 7 dias →` : 'nenhum vencendo em 7 dias');
    soonLink.type = 'button';
    soonLink.addEventListener('click', () => {
      state.clientFilter = 'soon';
      $('#clients-search').value = '';
      $('#clients-search-clear').hidden = true;
      state.clientsDirty = true;
      showView('clients');
    });
    const clientsTile = kpi('Clientes com plano', state.subs ? num.format(active + soon) : '—', soonLink);

    if (!sales.length) {
      const grid = el('div', 'kpis');
      grid.append(clientsTile);
      body.replaceChildren(grid, el('p', 'insights-empty', 'Ainda não há vendas nos últimos 12 meses. Os gráficos aparecem com as primeiras vendas.'));
      return;
    }

    // Months (local time), oldest → this month
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      return { y: d.getFullYear(), m: d.getMonth(), total: 0, count: 0 };
    });
    for (const sale of sales) {
      const k = (sale.at.getFullYear() - months[0].y) * 12 + sale.at.getMonth() - months[0].m;
      if (k >= 0 && k < 12) { months[k].total += sale.value; months[k].count++; }
    }
    const cur = months[11], prev = months[10];
    // This month so far vs the same days of last month (1st up to today's day and time)
    const prevStart = new Date(prev.y, prev.m, 1);
    const curStart = new Date(cur.y, cur.m, 1);
    const cutoff = new Date(Math.min(new Date(prev.y, prev.m, now.getDate(), now.getHours(), now.getMinutes()), curStart));
    const prevSame = sales.filter((s) => s.at >= prevStart && s.at < cutoff);
    const prevSameTotal = prevSame.reduce((n, s) => n + s.value, 0);
    const sameLabel = `1–${Math.min(now.getDate(), new Date(cur.y, cur.m, 0).getDate())} de ${MONTHS_SHORT[prev.m]}`;
    const total12 = sales.reduce((n, s) => n + s.value, 0);

    const grid = el('div', 'kpis');
    grid.append(
      kpi(`Receita em ${MONTHS_LONG[cur.m]}`, fmtMoney(cur.total), deltaLine(cur.total, prevSameTotal, sameLabel)),
      kpi(`Vendas em ${MONTHS_LONG[cur.m]}`, num.format(cur.count), deltaLine(cur.count, prevSame.length, sameLabel)),
      kpi('Ticket médio', fmtMoney(total12 / sales.length), el('span', 'kpi-delta', 'últimos 12 meses')),
      clientsTile,
    );

    const panels = [grid, monthChart(months)];

    const plans = groupBy(sales, (s) => s.plan, ['mensal', 'trimestral', 'semestral', 'anual']);
    const topPlan = [...plans].sort((a, b) => b.count - a.count)[0];
    const plansPanel = insightPanel('Planos', `${PLAN_LABEL[topPlan.key] || topPlan.key} é o mais vendido: ${pct(topPlan.count, sales.length)}% das vendas`);
    plansPanel.append(hbars(plans.map((g) => ({ label: PLAN_LABEL[g.key] || g.key, value: g.count, text: `${pct(g.count, sales.length)}% · ${fmtMoney(g.total)}` }))));
    panels.push(plansPanel);

    const pays = groupBy(sales, (s) => s.payment_method, ['pix', 'credito', 'debito', 'dinheiro']);
    const topPay = [...pays].sort((a, b) => b.total - a.total)[0];
    const payPanel = insightPanel('Forma de pagamento', `${PAYMENT_LABEL[topPay.key] || topPay.key} traz ${pct(topPay.total, total12)}% da receita`);
    payPanel.append(hbars(pays.map((g) => ({ label: PAYMENT_LABEL[g.key] || g.key, value: g.total, text: `${pct(g.total, total12)}% · ${fmtMoney(g.total)}` }))));
    panels.push(payPanel);

    const times = groupBy(sales, (s) => s.class_time).slice(0, 6);
    const timesPanel = insightPanel('Horários mais procurados', `${times[0].key} é o horário com mais vendas`);
    timesPanel.append(hbars(times.map((g) => ({ label: g.key, value: g.count, text: g.count === 1 ? '1 venda' : `${num.format(g.count)} vendas` }))));
    panels.push(timesPanel);

    const days = groupBy(sales, (s) => s.days_per_week, ['2', '3', '4', '5']);
    const topDays = [...days].sort((a, b) => b.count - a.count)[0];
    const daysPanel = insightPanel('Dias por semana', `A maioria treina ${topDays.key}x por semana (${pct(topDays.count, sales.length)}%)`);
    daysPanel.append(hbars(days.map((g) => ({ label: g.key.includes('+') ? g.key : `${g.key}x`, value: g.count, text: `${pct(g.count, sales.length)}%` }))));
    panels.push(daysPanel);

    const weekdays = groupBy(sales, (s) => s.at.getDay(), [1, 2, 3, 4, 5, 6, 0]);
    const topWd = [...weekdays].sort((a, b) => b.count - a.count)[0];
    const wdPanel = insightPanel('Dias com mais vendas', `${WEEKDAYS[topWd.key]} é o dia que mais vende (${pct(topWd.count, sales.length)}%)`);
    wdPanel.append(hbars(weekdays.map((g) => ({ label: WEEKDAYS[g.key].slice(0, 3), value: g.count, text: g.count === 1 ? '1 venda' : `${num.format(g.count)} vendas` }))));
    panels.push(wdPanel);

    body.replaceChildren(...panels);
  }

  // ───────────────────────── Export (CSV / PDF) ─────────────────────────
  const GYM = {
    phone: '(35) 3292-6830',
    address: 'Av. Henrique Munhoz Garcia, 327 · Jd. Boa Esperança',
    logo: 'img/emblem.svg', // swap for the real logo (PNG/SVG) when it arrives
  };

  // ───────────────────────── Receipt (58 mm Bluetooth thermal printer, printed directly) ─────────────────────────
  // js/receipt.js draws it, js/printer.js sends it to the printer. Problems open #print-modal with
  // what to do and buttons to retry or pick another printer (each is a new tap, which the browser requires).
  function receiptData(s) {
    return {
      gym: { phone: GYM.phone, address: GYM.address.split(' · ') },
      number: s.id ? String(s.id) : '',
      when: fmtDateTime(s.created_at ? new Date(s.created_at) : new Date()),
      client: s.client_name,
      cpf: showCpf(s.cpf),
      plan: PLAN_LABEL[s.plan] || s.plan,
      days: s.days_per_week === '4+' ? '4 ou mais' : s.days_per_week,
      time: s.class_time,
      start: fmtDate(parseISODate(s.plan_start)),
      end: fmtDate(parseISODate(s.plan_end)),
      payment: PAYMENT_LABEL[s.payment_method] || s.payment_method,
      amount: fmtMoney(Number(s.amount)),
      notes: s.notes || '',
      signature: s.signature || '',
    };
  }

  // Downloads the receipt exactly as it goes to the printer: recibo-6518_09-11-2026_15h42.png
  function saveReceiptPng(canvas, r) {
    const [date, time = ''] = r.when.split(' ');
    const name = `recibo-${r.number || 'sem-numero'}_${date.replace(/\//g, '-')}_${time.replace(':', 'h')}.png`;
    canvas.toBlob((blob) => {
      if (blob) download(blob, name);
      else console.error('Receipt PNG not created');
    }, 'image/png');
  }

  const printModal = $('#print-modal');
  let printJob = null; // { canvas, btn } — the receipt the modal's buttons retry
  let printing = false;

  const BUSY = 'Ela some da lista quando está conectada a outro celular, a outro app (como o Mini Impressora) ou a outra aba deste app aberta: feche esses.';
  function printErrorText(err, opts) {
    const serial = (opts.via || window.Printer.saved()?.via) === 'serial';
    switch (err.name) {
      case 'NotSupported':
        return 'Este navegador não imprime direto na impressora. Abra o app no Google Chrome, no Android.';
      case 'NoSerial':
        return 'Este Chrome não imprime em impressora pareada. Atualize o Google Chrome pela Play Store, ou toque em Escolher outra impressora.';
      case 'NeedsTap':
        return 'Toque em Tentar de novo para escolher a impressora.';
      case 'NotFoundError': // list closed without picking, printer not listed, or Bluetooth off
        return serial
          ? 'Nenhuma impressora escolhida. Ela precisa estar ligada e pareada no Bluetooth do celular (Configurações → Bluetooth).'
          : `A impressora não foi escolhida ou não apareceu na lista. Confira se o Bluetooth do celular e a impressora estão ligados. ${BUSY}`;
      case 'SecurityError':
      case 'NotAllowedError':
        return 'O navegador não deixou abrir a impressora. Toque em Tentar de novo.';
      case 'NoPrinterService':
        return 'Esse aparelho Bluetooth não aceita impressão. Toque em Escolher outra impressora.';
      default: // PrinterOff, NetworkError (connection lost)…
        return `A impressora não respondeu. Confira se ela está ligada, com papel e perto do celular. ${BUSY.replace('Ela some da lista', 'Ela também não responde')}`;
    }
  }

  // Must start from a tap: the browser shows the printer list only right after one.
  async function printReceipt(canvas, btn, opts = {}) {
    if (printing) return;
    printing = true;
    printJob = { canvas, btn };
    btn.disabled = true;
    toast('Imprimindo recibo…');
    try {
      await window.Printer.print(canvas, opts);
      toast('Recibo impresso! 🧾');
    } catch (err) {
      console.error(err);
      $('#toast').hidden = true;
      const P = window.Printer;
      const name = P.saved()?.name;
      $('#print-modal-text').textContent = printErrorText(err, opts);
      $('#print-modal-printer').textContent = name ? `Impressora salva: ${name}` : '';
      $('#print-modal-printer').hidden = !name;
      $('#print-modal-retry').hidden = err.name === 'NotSupported';
      $('#print-modal-choose').hidden = err.name === 'NotSupported' || !P.hasBle();
      $('#print-modal-serial').hidden = err.name === 'NotSupported' || !P.hasSerial();
      printModal.showModal();
    } finally {
      printing = false;
      btn.disabled = false;
    }
  }

  const retryPrint = (opts) => {
    printModal.close();
    if (printJob) printReceipt(printJob.canvas, printJob.btn, opts);
  };
  $('#print-modal-close').addEventListener('click', () => printModal.close());
  printModal.addEventListener('click', (e) => { if (e.target === printModal) printModal.close(); }); // tap on backdrop
  $('#print-modal-retry').addEventListener('click', () => retryPrint({}));
  $('#print-modal-choose').addEventListener('click', () => retryPrint({ choose: true, via: 'ble' }));
  $('#print-modal-serial').addEventListener('click', () => retryPrint({ choose: true, via: 'serial' }));

  async function reprintReceipt(sale, btn) {
    let canvas;
    try {
      canvas = await window.Receipt.render(receiptData({ ...sale, cpf: sale.clients?.cpf }));
    } catch (err) {
      console.error(err);
      return toast('Erro ao gerar o recibo.');
    }
    printReceipt(canvas, btn);
  }

  const fileDate = (d) => fmtDate(d).replace(/\//g, '-');
  function exportFileName(h, ext) {
    const slug = RANGE_LABEL[h.key].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '-');
    const from = h.range[0], last = addDays(h.range[1], -1);
    const dates = from.getTime() === last.getTime() ? fileDate(from) : `${fileDate(from)}_a_${fileDate(last)}`;
    return `vendas_${slug}_${dates}.${ext}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url; a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportCsv() {
    const h = state.history;
    if (!h?.rows.length) return;
    // Brazilian Excel: ";" separator, decimal comma, UTF-8 BOM so accents open correctly.
    const header = ['#', 'Data', 'Cliente', 'CPF', 'Valor', 'Forma de pagamento', 'Plano', 'Dias/semana',
      'Horário', 'Início do plano', 'Fim do plano', 'Observação', 'Assinatura'];
    const lines = h.rows.map((r) => [
      r.id,
      fmtDateTime(new Date(r.created_at)),
      r.client_name,
      showCpf(r.clients?.cpf),
      Number(r.amount).toFixed(2).replace('.', ','),
      PAYMENT_LABEL[r.payment_method],
      PLAN_LABEL[r.plan],
      r.days_per_week,
      r.class_time,
      fmtDate(parseISODate(r.plan_start)),
      fmtDate(parseISODate(r.plan_end)),
      r.notes || '',
      r.signature || '',
    ]);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [header, ...lines].map((cols) => cols.map(esc).join(';')).join('\r\n');
    download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), exportFileName(h, 'csv'));
  }

  // PDF libraries are loaded only the first time a PDF is exported.
  const PDF_LIBS = [
    'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
    'https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.8/dist/jspdf.plugin.autotable.min.js',
  ];
  let pdfLibsPromise;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    document.head.append(s);
  });
  const loadPdfLibs = () => (pdfLibsPromise ??= PDF_LIBS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
    .catch((err) => { pdfLibsPromise = null; throw err; }));

  // Rasterize the logo (SVG or PNG) so it can go into the PDF.
  function logoPng(size = 256) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = size;
          c.getContext('2d').drawImage(img, 0, 0, size, size);
          resolve(c.toDataURL('image/png'));
        } catch (err) {
          console.warn('Logo not added to PDF', err);
          resolve(null); // PDF still works, just without the logo
        }
      };
      img.onerror = () => resolve(null);
      img.src = GYM.logo;
    });
  }

  async function buildPdf(h) {
    await loadPdfLibs();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const logo = await logoPng();

    const W = 210, H = 297, M = 12;
    const RED = [225, 6, 0], RED_BRIGHT = [255, 45, 31], BLACK = [10, 10, 10];
    const GRAY = [120, 120, 128], LIGHT = [243, 243, 245], WHITE = [255, 255, 255], SILVER = [205, 207, 212];
    const fill = (c) => doc.setFillColor(...c);
    const color = (c) => doc.setTextColor(...c);
    const draw = (c) => doc.setDrawColor(...c);
    const font = (style, size) => { doc.setFont('helvetica', style); doc.setFontSize(size); };
    const opacity = (o) => doc.setGState(new doc.GState({ opacity: o }));
    const rangeText = fmtRange(h.range);
    const periodLabel = h.key === 'custom' ? 'Período personalizado' : RANGE_LABEL[h.key];

    // Red light beams like the gym's art
    // Beams run along the bottom of the band (and one along the top) so they never cross the text.
    function beams(top, bottom) {
      const h = bottom - top, big = h > 20;
      const lines = [
        [W * .28, bottom, W + 4, bottom - (big ? 7 : 3.2), RED, .9, .7],
        [W * .42, bottom, W + 4, bottom - (big ? 4.5 : 2), RED_BRIGHT, .35, .9],
        [W * .22, bottom, W + 4, bottom - (big ? 8 : 3.8), WHITE, .2, .5],
        [W * .55, bottom, W + 4, bottom - (big ? 2.5 : 1.2), RED, .5, .6],
        ...(big ? [[W * .5, top - 1, W + 4, top + 7, RED, .4, .5]] : []),
      ];
      for (const [x1, y1, x2, y2, c, w, o] of lines) {
        opacity(o); draw(c); doc.setLineWidth(w); doc.line(x1, y1, x2, y2);
      }
      opacity(1);
    }

    function speedStripes(x, y, n = 6) {
      fill(RED);
      for (let i = 0; i < n; i++) {
        const sx = x + i * 6;
        doc.triangle(sx + 1.5, y, sx + 5, y, sx + 3.5, y + 2, 'F');
        doc.triangle(sx + 1.5, y, sx + 3.5, y + 2, sx, y + 2, 'F');
      }
    }

    function fullHeader() {
      fill(BLACK); doc.rect(0, 0, W, 44, 'F');
      beams(0, 44);
      if (logo) doc.addImage(logo, 'PNG', M, 8, 28, 28);
      const tx = M + 33;
      font('bolditalic', 24); color(RED_BRIGHT); doc.text('Studio', tx, 20);
      font('bolditalic', 21); color(SILVER); doc.text('Fitness', tx + 3, 29);
      font('bold', 7); color(WHITE); doc.text('TREINAMENTO PERSONALIZADO', tx, 35.5, { charSpace: .4 });

      font('bolditalic', 15); color(WHITE); doc.text('RELATÓRIO DE VENDAS', W - M, 17, { align: 'right' });
      font('bolditalic', 11); color(RED_BRIGHT); doc.text(periodLabel.toUpperCase(), W - M, 24.5, { align: 'right' });
      font('normal', 9); color(SILVER); doc.text(rangeText, W - M, 30.5, { align: 'right' });
      font('normal', 7); color(GRAY); doc.text(`Gerado em ${fmtDateTime(new Date())}`, W - M, 34.5, { align: 'right' });

      fill(RED); doc.rect(0, 44, W, 1.2, 'F');
    }

    function slimHeader() {
      fill(BLACK); doc.rect(0, 0, W, 14, 'F');
      beams(0, 14);
      if (logo) doc.addImage(logo, 'PNG', M, 2.5, 9, 9);
      font('bolditalic', 11); color(RED_BRIGHT); doc.text('Studio', M + 12, 9);
      color(SILVER); doc.text('Fitness', M + 12 + doc.getTextWidth('Studio '), 9);
      font('normal', 8); color(SILVER); doc.text(`Relatório de vendas · ${periodLabel} · ${rangeText}`, W - M, 9, { align: 'right' });
      fill(RED); doc.rect(0, 14, W, .8, 'F');
    }

    function footer(page) {
      draw(RED); doc.setLineWidth(.4); doc.line(M, H - 13, W - M, H - 13);
      font('bold', 7.5); color(BLACK); doc.text('STUDIO FITNESS', M, H - 8.5);
      font('normal', 7); color(GRAY);
      doc.text(`WhatsApp ${GYM.phone} · ${GYM.address}`, M + doc.getTextWidth('STUDIO FITNESS  ') + 1, H - 8.5);
      font('bolditalic', 8); color(BLACK);
      doc.text(`Página ${page} de ${doc.getNumberOfPages()}`, W - M, H - 8.5, { align: 'right' });
    }

    // ── Page 1 header + summary cards
    fullHeader();
    speedStripes(M, 49);

    const byPay = Object.fromEntries(Object.keys(PAYMENT_LABEL).map((k) => [k, [0, 0]]));
    for (const r of h.rows) { byPay[r.payment_method][0] += Number(r.amount); byPay[r.payment_method][1]++; }

    const cy = 55, ch = 22, gap = 4;
    const totalW = 54;
    const count = h.rows.length;
    fill(BLACK); doc.roundedRect(M, cy, totalW, ch, 2, 2, 'F');
    draw(RED); doc.setLineWidth(.6); doc.roundedRect(M, cy, totalW, ch, 2, 2, 'S');
    font('bolditalic', 8); color(RED_BRIGHT); doc.text('TOTAL DO PERÍODO', M + 5, cy + 6.5);
    font('bolditalic', 16); color(WHITE); doc.text(fmtMoney(h.total), M + 5, cy + 14.5);
    font('normal', 6.5); color(SILVER);
    doc.text(`${count} ${count === 1 ? 'venda' : 'vendas'} · média ${fmtMoney(count ? h.total / count : 0)}`, M + 5, cy + 19);

    const cards = Object.entries(PAYMENT_LABEL).map(([k, label]) =>
      [label.toUpperCase(), fmtMoney(byPay[k][0]), `${byPay[k][1]} venda(s)`]);
    const cw = (W - 2 * M - totalW - gap * cards.length) / cards.length;
    cards.forEach(([label, value, sub], i) => {
      const x = M + totalW + gap + i * (cw + gap);
      fill(LIGHT); doc.roundedRect(x, cy, cw, ch, 2, 2, 'F');
      fill(RED); doc.rect(x, cy + 4, 1, ch - 8, 'F');
      font('bold', 7); color(GRAY); doc.text(label, x + 4, cy + 7);
      font('bolditalic', 11); color(BLACK); doc.text(value, x + 4, cy + 14);
      font('normal', 6.5); color(GRAY); doc.text(sub, x + 4, cy + 19);
    });

    // ── Sales table
    const body = h.rows.map((r) => [
      `#${r.id}`,
      fmtDateTime(new Date(r.created_at)),
      r.client_name + (showCpf(r.clients?.cpf) ? `\n${showCpf(r.clients.cpf)}` : ''),
      `${PLAN_LABEL[r.plan]} · ${r.days_per_week}x/sem\naté ${fmtDate(parseISODate(r.plan_end))}`,
      PAYMENT_LABEL[r.payment_method],
      r.class_time,
      r.signature || '—',
      fmtMoney(Number(r.amount)),
    ]);

    const autoTable = window.autoTable || ((d, o) => d.autoTable(o));
    autoTable(doc, {
      startY: cy + ch + 7,
      margin: { top: 22, bottom: 18, left: M, right: M },
      head: [['#', 'Data', 'Cliente', 'Plano', 'Pagto.', 'Hora', 'Atendente', 'Valor']],
      body,
      foot: [[
        { content: `TOTAL · ${h.rows.length} ${h.rows.length === 1 ? 'venda' : 'vendas'}`, colSpan: 7, styles: { halign: 'right' } },
        fmtMoney(h.total),
      ]],
      showFoot: 'lastPage',
      rowPageBreak: 'avoid', // never split a sale across pages
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: 7.8, cellPadding: { top: 2.6, bottom: 2.6, left: 2, right: 2 }, textColor: [30, 30, 34], valign: 'middle', lineColor: [228, 228, 232] },
      headStyles: { fillColor: BLACK, textColor: WHITE, fontStyle: 'bolditalic', fontSize: 8.5 },
      footStyles: { fillColor: BLACK, textColor: WHITE, fontStyle: 'bolditalic', fontSize: 9.5 },
      alternateRowStyles: { fillColor: [247, 247, 249] },
      columnStyles: {
        0: { fontStyle: 'bold', textColor: RED, cellWidth: 14 },
        1: { cellWidth: 25 },
        2: { fontStyle: 'bold', cellWidth: 'auto' },
        3: { cellWidth: 31 },
        4: { cellWidth: 17 },
        5: { cellWidth: 14, halign: 'center' },
        6: { cellWidth: 20 },
        7: { halign: 'right', fontStyle: 'bolditalic', cellWidth: 28 },
      },
      didParseCell: (data) => {
        if (data.section === 'foot' && data.column.index === 7) Object.assign(data.cell.styles, { textColor: RED_BRIGHT, halign: 'right' });
        if (data.section === 'head' && data.column.index === 7) data.cell.styles.halign = 'right';
      },
      didDrawCell: (data) => {
        if (data.section === 'body') { // row separator
          draw([228, 228, 232]); doc.setLineWidth(.15);
          doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
        }
        if (data.section === 'head') { // red underline on the header row
          fill(RED); doc.rect(data.cell.x, data.cell.y + data.cell.height - .8, data.cell.width, .8, 'F');
        }
      },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) slimHeader();
      },
    });

    // Footers last, once the page count is known
    for (let p = 1; p <= doc.getNumberOfPages(); p++) { doc.setPage(p); footer(p); }
    return doc;
  }

  async function exportPdf() {
    const h = state.history;
    if (!h?.rows.length) return;
    const btn = $('#export-pdf');
    btn.disabled = true;
    toast('Gerando PDF…');
    try {
      const doc = await buildPdf(h);
      download(doc.output('blob'), exportFileName(h, 'pdf'));
      toast('PDF pronto! 💪');
    } catch (err) {
      console.error(err);
      toast('Erro ao gerar o PDF. Verifique a internet.');
    } finally {
      btn.disabled = false;
    }
  }

  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-pdf').addEventListener('click', exportPdf);

  // Long press on a filter shows which dates it covers, without applying it.
  const filters = $('#history-filters');
  let pressTimer = null;
  let longPressed = false;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };

  filters.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    longPressed = false;
    cancelPress();
    pressTimer = setTimeout(() => {
      longPressed = true;
      const range = getRange(chip.dataset.range);
      toast(range ? `${RANGE_LABEL[chip.dataset.range]}: ${fmtRange(range)}` : 'Escolha as datas do período.');
      try { navigator.vibrate?.(30); } catch (_) { /* not supported */ }
    }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => filters.addEventListener(ev, cancelPress));
  filters.addEventListener('contextmenu', (e) => e.preventDefault());

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (longPressed) { longPressed = false; return; } // it was a long press, not a tap
    $$('#history-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.historyRange = chip.dataset.range;
    $('#custom-range').hidden = state.historyRange !== 'custom';
    if (state.historyRange === 'custom' && !$('#range-from').value) {
      const today = toISODate(new Date());
      setDateInput('range-from', today);
      setDateInput('range-to', today);
    }
    loadHistory();
  });
  $('#range-apply').addEventListener('click', loadHistory);

  // Custom range: native picker underneath, dd/MM/yyyy text on display
  function setDateInput(id, iso) {
    $(`#${id}`).value = iso;
    $(`#${id}-text`).value = iso ? fmtDate(parseISODate(iso)) : '';
  }
  ['range-from', 'range-to'].forEach((id) => {
    const input = $(`#${id}`);
    input.addEventListener('change', () => setDateInput(id, input.value));
    input.addEventListener('click', () => { try { input.showPicker(); } catch (_) { /* opens natively */ } });
  });

  // ───────────────────────── Boot ─────────────────────────
  (async function boot() {
    renderLoginUsers();
    updateNotes();
    if (!sb) return showLogin('Configure o Supabase em js/config.js.');
    const { data: { session } } = await sb.auth.getSession();
    if (session) enterApp(session.user); else showLogin();
    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showLogin(); });
  })();
})();
