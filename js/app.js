(() => {
  'use strict';

  const CFG = window.APP_CONFIG;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const PLAN_MONTHS = { mensal: 1, semestral: 6, anual: 12 };
  const PLAN_LABEL = { mensal: 'Mensal', semestral: 'Semestral', anual: 'Anual' };
  const PAYMENT_LABEL = { pix: 'Pix', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro' };
  const PAGE_SIZE = 1000; // Supabase returns at most 1000 rows per request

  const state = {
    role: null,        // 'owner' | 'teacher'
    clients: [],
    historyRange: 'today',
    history: null,     // last loaded history: { key, range, rows, total } — used by the exports
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
    renderClients();
    if (!$('#client-options').hidden) renderCombo();
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
    state.selectedClient = null;
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
      const name = searchKey(c.name);
      return words.every((w) => name.includes(w)) || (digits.length >= 3 && (c.cpf || '').includes(digits));
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
      ...(c.cpf ? [el('span', 'combo-cpf', fmtCpf(c.cpf))] : []),
    ], () => selectClient(c)));

    if (found.length > COMBO_MAX) nodes.push(el('li', 'combo-hint', `+${found.length - COMBO_MAX} clientes… continue digitando`));
    if (!found.length) {
      nodes.push(q.trim()
        ? comboOption('opt-create', 'combo-create', [el('span', 'combo-plus', '+'), el('span', null, `Cadastrar "${normName(q)}"`)], () => openClientModal(q))
        : el('li', 'combo-hint', 'Nenhum cliente cadastrado. Digite um nome para cadastrar.'));
    }
    comboList.replaceChildren(...nodes);
    setComboActive(q.trim() && comboItems.length ? 0 : -1);
  }

  function openCombo() {
    renderCombo();
    comboList.hidden = false;
    comboInput.setAttribute('aria-expanded', 'true');
  }
  function closeCombo() {
    comboList.hidden = true;
    comboInput.setAttribute('aria-expanded', 'false');
    setComboActive(-1);
  }

  function selectClient(c) {
    state.selectedClient = c;
    comboInput.value = c.name;
    comboInput.classList.remove('invalid');
    showError($('#sale-error'), '');
    closeCombo();
  }

  comboInput.addEventListener('focus', openCombo);
  comboInput.addEventListener('click', () => { if (comboList.hidden) openCombo(); });
  comboInput.addEventListener('input', () => { state.selectedClient = null; openCombo(); });
  comboInput.addEventListener('blur', closeCombo);
  comboInput.addEventListener('keydown', (e) => {
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
    modalName.value = normName(q || '');
    modalCpf.value = '';
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
    const name = normName(modalName.value);
    const cpf = modalCpf.value.replace(/\D/g, '');
    if (!name) return showError(errBox, 'Informe o nome.');
    if (cpf && cpf.length !== 11) return showError(errBox, 'CPF deve ter 11 dígitos.');
    const dup = cpf && state.clients.find((c) => c.cpf === cpf);
    if (dup) return showError(errBox, `CPF já cadastrado para ${dup.name}.`);

    const btn = e.submitter || $('#client-modal-form button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await sb.from('clients').insert({ name, cpf: cpf || null }).select('id, name, cpf').single();
    btn.disabled = false;
    if (error) { console.error(error); return showError(errBox, 'Erro ao cadastrar. Verifique a internet.'); }

    state.clients = [...state.clients, data].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    renderClients();
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

    state.history = null;
    $('#export-bar').hidden = true;

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
        .select('id, created_at, client_name, amount, payment_method, class_time, plan, days_per_week, plan_start, plan_end, notes, signature, clients(cpf)')
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
    state.history = { key, range, rows, total };
    $('#export-bar').hidden = !rows.length || state.role !== 'owner';
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

  // ───────────────────────── Export (CSV / PDF) ─────────────────────────
  const GYM = {
    phone: '(35) 3292-6830',
    address: 'Av. Henrique Munhoz Garcia, 327 · Jd. Boa Esperança',
    logo: 'img/emblem.svg', // swap for the real logo (PNG/SVG) when it arrives
  };

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
      r.clients?.cpf ? fmtCpf(r.clients.cpf) : '',
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
      r.client_name + (r.clients?.cpf ? `\n${fmtCpf(r.clients.cpf)}` : ''),
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
