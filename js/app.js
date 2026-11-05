(() => {
  'use strict';

  const CFG = window.APP_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const PLAN_MONTHS = { mensal: 1, semestral: 6, anual: 12 };
  const PLAN_LABEL = { mensal: 'Mensal', semestral: 'Semestral', anual: 'Anual' };
  const PAYMENT_LABEL = { pix: 'Pix', credito: 'Crédito', debito: 'Débito' };
  const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

  const state = {
    role: null,        // 'owner' | 'teacher'
    clients: [],
    historyRange: 'today',
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

  // Animated money counter (scoreboard)
  function countUp(node, target) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = target;
    if (reducedMotion() || from === target) { node.textContent = fmtMoney(target); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmtMoney(from + (target - from) * eased);
      if (p < 1 && node.dataset.value == target) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // "Venda fechada!" overlay with confetti
  const PHRASES = [
    'Mais um no time! 🔥', 'Partiu treino! 💪', 'Foco, força e fé!', 'Shape em construção!',
    'Sem dor, sem ganho!', 'É hora do show!', 'Ninguém segura!', 'Bora pra cima!',
  ];
  let celebrateTimer;
  function celebrate(sub) {
    const box = $('#celebrate');
    $('#celebrate-phrase').textContent = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    $('#celebrate-sub').textContent = sub;

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
    celebrateTimer = setTimeout(closeCelebrate, 3500);
  }
  function closeCelebrate() {
    clearTimeout(celebrateTimer);
    $('#celebrate').hidden = true;
    $('#confetti').replaceChildren();
  }
  $('#celebrate').addEventListener('click', closeCelebrate);

  // ───────────────────────── Supabase ─────────────────────────
  const configured = CFG && !CFG.supabaseUrl.includes('YOUR-') && !CFG.supabaseKey.includes('YOUR-');
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

  async function fetchAll(buildQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE_SIZE) return rows;
    }
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

  async function enterApp(user) {
    const { data, error } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (error || !data) {
      await sb.auth.signOut();
      return showLogin('Usuário sem perfil configurado no banco.');
    }
    state.role = data.role;
    const isOwner = state.role === 'owner';
    $$('[data-owner-only]').forEach((n) => { n.hidden = !isOwner; });
    $('#who').textContent = isOwner ? CFG.users.owner.label : CFG.users.teacher.label;

    $('#view-login').hidden = true;
    $('#app').hidden = false;
    showView('sale');
    loadClients();
  }

  // ───────────────────────── Navigation ─────────────────────────
  const TITLES = { sale: 'Nova venda', history: 'Histórico', clients: 'Clientes' };

  function showView(name) {
    if (name === 'history' && state.role !== 'owner') name = 'sale';
    for (const v of Object.keys(TITLES)) $(`#view-${v}`).hidden = v !== name;
    $$('.bottomnav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('#view-title').textContent = TITLES[name];
    $('#totalbar').hidden = name !== 'history';
    if (name === 'history') loadHistory();
    window.scrollTo(0, 0);
  }

  $$('.bottomnav [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ───────────────────────── Clients ─────────────────────────
  async function loadClients() {
    try {
      state.clients = await fetchAll(() => sb.from('clients').select('id, name, cpf').order('name'));
    } catch (err) {
      console.error(err);
      toast('Erro ao carregar clientes.');
      return;
    }
    const dl = $('#clients-datalist');
    dl.replaceChildren(...state.clients.map((c) => {
      const o = el('option');
      o.value = c.name;
      if (c.cpf) o.label = fmtCpf(c.cpf);
      return o;
    }));
    renderClients();
  }

  function renderClients() {
    const q = $('#clients-search').value.trim().toUpperCase();
    const qDigits = q.replace(/\D/g, '');
    const list = state.clients.filter((c) =>
      !q || c.name.includes(q) || (qDigits && (c.cpf || '').includes(qDigits)));

    $('#clients-list').replaceChildren(...list.map((c) => {
      const li = el('li');
      const parts = c.name.split(' ').filter(Boolean);
      const initials = (parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
      const info = el('div');
      info.append(el('div', 'row-name', c.name));
      if (c.cpf) info.append(el('div', 'row-meta', fmtCpf(c.cpf)));
      li.append(el('span', 'avatar', initials), info);
      li.addEventListener('click', () => openClientForm(c));
      return li;
    }));
    if (!list.length) $('#clients-list').append(el('li', 'muted', q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado.'));
  }

  function openClientForm(c) {
    $('#client-id').value = c?.id ?? '';
    $('#client-name').value = c?.name ?? '';
    $('#client-cpf').value = fmtCpf(c?.cpf ?? '');
    showError($('#client-error'), '');
    $('#client-form').hidden = false;
    $('#client-name').focus();
    window.scrollTo(0, 0);
  }

  $('#clients-search').addEventListener('input', renderClients);
  $('#client-new').addEventListener('click', () => openClientForm(null));
  $('#client-cancel').addEventListener('click', () => { $('#client-form').hidden = true; });
  $('#client-cpf').addEventListener('input', (e) => { e.target.value = fmtCpf(e.target.value); });

  $('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#client-id').value;
    const name = normName($('#client-name').value);
    const cpf = $('#client-cpf').value.replace(/\D/g, '');
    if (!name) return showError($('#client-error'), 'Informe o nome.');
    if (cpf && cpf.length !== 11) return showError($('#client-error'), 'CPF deve ter 11 dígitos.');

    const row = { name, cpf: cpf || null };
    const { error } = id
      ? await sb.from('clients').update(row).eq('id', id)
      : await sb.from('clients').insert(row);
    if (error) { console.error(error); return showError($('#client-error'), 'Erro ao salvar cliente.'); }

    $('#client-form').hidden = true;
    toast(id ? 'Cliente atualizado.' : 'Cliente cadastrado.');
    loadClients();
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

  async function findOrCreateClient(name) {
    const existing = state.clients.find((c) => c.name === name);
    if (existing) return existing.id;
    const { data, error } = await sb.from('clients').insert({ name }).select('id, name, cpf').single();
    if (error) throw error;
    loadClients();
    return data.id;
  }

  saleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#sale-error');
    const clientInput = $('#sale-client');
    const timeSelect = $('#sale-time');
    const clientName = normName(clientInput.value);
    const cents = amountCents();
    const days = radioValue('days');

    const missing = [];
    if (!clientName) { missing.push('cliente'); clientInput.classList.add('invalid'); }
    if (cents <= 0) { missing.push('valor'); amountInput.classList.add('invalid'); }
    if (!days) { missing.push('dias/semana'); saleForm.querySelector('input[name="days"]').closest('.pills').classList.add('invalid'); }
    if (!timeSelect.value) { missing.push('horário'); timeSelect.classList.add('invalid'); }
    if (missing.length) return showError(errBox, `Preencha: ${missing.join(', ')}.`);
    showError(errBox, '');

    const btn = saleForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const clientId = await findOrCreateClient(clientName);
      const { start, end } = planDates();
      const row = {
        client_id: clientId,
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

      // The teacher has no permission to read sales, so only the owner asks for the new number back.
      let sub = clientName;
      if (state.role === 'owner') {
        const { data, error } = await sb.from('sales').insert(row).select('id').single();
        if (error) throw error;
        sub = `#${data.id} · ${clientName}`;
      } else {
        const { error } = await sb.from('sales').insert(row);
        if (error) throw error;
      }
      saleForm.reset();
      celebrate(sub);
    } catch (err) {
      console.error(err);
      showError(errBox, 'Erro ao salvar a venda. Verifique a internet e tente novamente.');
    } finally {
      btn.disabled = false;
    }
  });

  // ───────────────────────── History (owner only) ─────────────────────────
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

  async function loadHistory() {
    const key = state.historyRange;
    const range = getRange(key);
    const status = $('#history-status');
    const list = $('#history-list');
    $('#total-label').textContent = `Total ${RANGE_LABEL[key]}`;

    if (!range) {
      list.replaceChildren();
      status.textContent = 'Escolha as datas e toque em Filtrar.';
      countUp($('#total-value'), 0);
      return;
    }

    status.textContent = 'Carregando…';
    let rows;
    try {
      rows = await fetchAll(() => sb.from('sales')
        .select('id, created_at, client_name, amount, payment_method, class_time, plan, days_per_week, plan_end')
        .gte('created_at', range[0].toISOString())
        .lt('created_at', range[1].toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }));
    } catch (err) {
      console.error(err);
      status.textContent = 'Erro ao carregar o histórico.';
      return;
    }
    if (state.historyRange !== key) return; // user switched filter meanwhile

    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    countUp($('#total-value'), total);
    status.textContent = `${rows.length === 1 ? '1 venda' : `${rows.length} vendas`} · ${fmtRange(range)}`;

    list.replaceChildren(...rows.map((r) => {
      const li = el('li');
      const top = el('div', 'row');
      top.append(el('span', 'row-title', `#${r.id} - ${fmtDateTime(new Date(r.created_at))}`));
      const mid = el('div', 'row');
      mid.append(el('span', 'row-name', r.client_name), el('span', 'row-amount', fmtMoney(Number(r.amount))));
      const meta = el('div', 'row-meta', [
        PLAN_LABEL[r.plan],
        PAYMENT_LABEL[r.payment_method],
        r.class_time,
        `${r.days_per_week}x/sem`,
        `até ${fmtDate(parseISODate(r.plan_end))}`,
      ].join(' · '));
      li.append(top, mid, meta);
      return li;
    }));
    if (!rows.length) list.append(el('li', 'muted', 'Nenhuma venda nesse período. Bora vender!'));
  }

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
