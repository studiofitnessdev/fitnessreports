// Pure helpers (no screen, no network): dates, plans, CPF, client search, renewals and the numbers of the
// client page. Shared by js/app.js (window.SFCore) and the tests (tests/core.test.js, run with `npm test`),
// so the parts that are easiest to get silently wrong are checked on every commit.
(() => {
  'use strict';

  // ───────────────────────── Dates (always local time) ─────────────────────────
  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  // Same day N months later; clamps to the month's last day (31/01 + 1 month → 28/02).
  const addMonths = (d, n) => {
    const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
    return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
  };
  const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // "2026-11-17" → local midnight of that day. Never new Date("2026-11-17"): that is UTC midnight, the
  // evening before in Brazil.
  const parseISODate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  // Whole days from a to b (calendar days; rounding absorbs a 23/25-hour day)
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);

  // "3 meses", "1 ano e 2 meses"
  const fmtMonths = (m) => {
    const months = (n) => `${n} ${n === 1 ? 'mês' : 'meses'}`;
    if (m < 12) return months(m);
    const y = Math.floor(m / 12), r = m % 12;
    return `${y} ano${y > 1 ? 's' : ''}${r ? ` e ${months(r)}` : ''}`;
  };
  // A number of days as a length of time: "12 dias", then to the nearest month: "1 mês", "1 ano e 3 meses"
  const fmtSpan = (days) => (days < 30 ? `${days} dia${days === 1 ? '' : 's'}` : fmtMonths(Math.max(1, Math.round(days / 30.4375))));
  // How long ago: "hoje", "ontem", "há 12 dias", "há 3 meses", "há 1 ano e 2 meses" (calendar months)
  const fmtAgo = (d, now) => {
    let m = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
    if (now.getDate() < d.getDate()) m--;
    if (m >= 1) return `há ${fmtMonths(m)}`;
    const days = daysBetween(d, now);
    return days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days} dias`;
  };

  // ───────────────────────── Plans ─────────────────────────
  const PLAN_MONTHS = { diaria: 0, mensal: 1, trimestral: 3, semestral: 6, anual: 12 }; // diária: starts and ends on the sale day
  const PLAN_LABEL = { diaria: 'Diária', mensal: 'Mensal', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual' };
  const planEnd = (plan, start) => addMonths(start, PLAN_MONTHS[plan]);

  // The Observação text filled in for a sale ("Plano Mensal: 17/11/2026 a 17/12/2026"). Same text as
  // sale_auto_note() in supabase/013_notes_diaria_subs.sql, which swaps it when a sale is edited.
  const autoNote = (plan, start, end) => (plan === 'diaria'
    ? `Diária: ${fmtDate(start)}`
    : `Plano ${PLAN_LABEL[plan]}: ${fmtDate(start)} a ${fmtDate(end)}`);

  // ───────────────────────── Clients ─────────────────────────
  const CPF_NONE = '00000000000'; // stored for every client without CPF; shown as "Sem CPF"

  // Real CPFs end in two check digits; a phone or a code almost never does.
  const validCpf = (d) => {
    if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
    const check = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
      return ((sum * 10) % 11) % 10;
    };
    return check(9) === Number(d[9]) && check(10) === Number(d[10]);
  };

  // Uppercase without accents ("João" → "JOAO"), for searching
  const searchKey = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

  // Clients matching what was typed: every word of the name (any order, accents ignored), or 3+ digits of
  // the CPF, or 4+ digits of the WhatsApp. `c.key` is searchKey(c.name), when already computed.
  function matchClients(clients, q) {
    const words = searchKey(q).split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, '');
    if (!words.length) return clients;
    return clients.filter((c) => {
      const name = c.key ?? searchKey(c.name);
      return words.every((w) => name.includes(w))
        || (digits.length >= 3 && c.cpf && c.cpf !== CPF_NONE && c.cpf.includes(digits)) // "000" mustn't list everyone without CPF
        || (digits.length >= 4 && !!c.phone && c.phone.includes(digits));
    });
  }

  // ───────────────────────── Renewals (Insights and the client page) ─────────────────────────
  const INSIGHTS_MONTHS = 18;
  const RENEW_GRACE_DAYS = 15; // a plan renewed up to 15 days after it ended still counts as renewed
  // A plan counts as renewed when the client's next plan was bought before this day (the 15th day after the end included)
  const renewLimit = (planEndISO) => addDays(parseISODate(planEndISO), RENEW_GRACE_DAYS + 1);

  // New clients and renewals, from plan sales only (a Diária is a visit, counted on its own).
  // `all`: sales with { id, at (Date of created_at), plan, client_id, plan_end }.
  // - A plan sale is a renewal when the same client had a plan that ended less than a year before it (or is
  //   still running); otherwise the client is new (first plan, or back after a year or more without one).
  //   Needs history before the month, so it is only given for the last 6 of the 18 months loaded.
  // - Renewal rate of a month: of the plans that ended in it, how many were followed by another plan of the
  //   same client up to RENEW_GRACE_DAYS after the end. Only months whose grace period is already over.
  function clientFlow(all, now) {
    const plans = all.filter((s) => s.plan !== 'diaria' && s.client_id != null).sort((a, b) => a.at - b.at || a.id - b.id);
    const byClient = new Map();
    for (const s of plans) {
      if (!byClient.has(s.client_id)) byClient.set(s.client_id, []);
      byClient.get(s.client_id).push(s);
    }
    const isRenewal = new Map(); // sale → bought a plan in the year before
    const renewed = new Map(); // sale → followed by another plan in time
    for (const list of byClient.values()) {
      let lastEnd = null; // furthest plan end of the client's earlier sales
      list.forEach((s, i) => {
        isRenewal.set(s, !!lastEnd && s.at < addDays(lastEnd, 366));
        const end = parseISODate(s.plan_end);
        if (!lastEnd || end > lastEnd) lastEnd = end;
        const next = list[i + 1];
        renewed.set(s, !!next && next.at < renewLimit(s.plan_end));
      });
    }
    const monthOf = (k) => new Date(now.getFullYear(), now.getMonth() - k, 1); // k = 0 this month
    const flow = [];
    for (let k = 5; k >= 0; k--) {
      const start = monthOf(k), end = monthOf(k - 1);
      const inMonth = plans.filter((s) => s.at >= start && s.at < end);
      const fresh = new Set(inMonth.filter((s) => !isRenewal.get(s)).map((s) => s.client_id));
      flow.push({ y: start.getFullYear(), m: start.getMonth(), start, fresh: fresh.size, renewals: inMonth.filter((s) => isRenewal.get(s)).length, sales: inMonth });
    }
    const today = startOfDay(now);
    const renewal = [];
    for (let k = 1; k < INSIGHTS_MONTHS && renewal.length < 6; k++) {
      const start = monthOf(k), end = monthOf(k - 1);
      if (addDays(end, RENEW_GRACE_DAYS) > today) continue; // some plans of this month are still in their grace days
      const ended = plans.filter((s) => { const e = parseISODate(s.plan_end); return e >= start && e < end; });
      if (ended.length) renewal.unshift({ y: start.getFullYear(), m: start.getMonth(), total: ended.length, renewed: ended.filter((s) => renewed.get(s)).length });
    }
    return { flow, renewal, isRenewal };
  }

  // The numbers on one client's page. `rows`: all their sales, any order, with { id, created_at, plan,
  // days_per_week, class_time, plan_start, plan_end } and, for Anderson only, amount. Plan periods are
  // calendar days, both ends included; purchases are ordered by created_at (as in clientFlow).
  function clientStats(rows, now) {
    const today = startOfDay(now);
    const sales = rows.map((r) => ({ ...r, at: new Date(r.created_at) })).sort((a, b) => a.at - b.at || a.id - b.id);
    const plans = sales.filter((s) => s.plan !== 'diaria');
    const paid = sales.filter((s) => s.amount != null);
    const total = paid.length ? paid.reduce((n, s) => n + Number(s.amount), 0) : null;

    // Renewed on time: same rule as the Insights renewal rate. A plan still in its grace days (and not
    // renewed yet) isn't counted either way.
    let renewed = 0, judged = 0;
    plans.forEach((s, i) => {
      const next = plans[i + 1];
      const limit = renewLimit(s.plan_end);
      const ok = !!next && next.at < limit;
      if (ok || limit <= today) { judged++; if (ok) renewed++; }
    });

    // Days with a plan, up to today (a plan bought early overlaps the previous one: those days count once)
    const spans = plans.map((s) => [parseISODate(s.plan_start), parseISODate(s.plan_end)]).filter(([start]) => start <= today)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0, runStart = null, runEnd = null;
    for (const [start, end] of spans) {
      const upTo = end > today ? today : end;
      if (runEnd && start <= addDays(runEnd, 1)) { if (upTo > runEnd) runEnd = upTo; continue; }
      if (runEnd) covered += daysBetween(runStart, runEnd) + 1;
      runStart = start; runEnd = upTo;
    }
    if (runEnd) covered += daysBetween(runStart, runEnd) + 1;

    // With a plan today: since when without stopping (a renewal up to RENEW_GRACE_DAYS late doesn't break it)
    let since = null;
    if (spans.some(([start, end]) => start <= today && end >= today)) {
      let gEnd = null;
      for (const [start, end] of spans) {
        if (!gEnd || start >= addDays(gEnd, RENEW_GRACE_DAYS + 1)) since = start;
        if (!gEnd || end > gEnd) gEnd = end;
      }
    }

    // The most common value; on a tie, the one of the most recent purchase
    const mostCommon = (list, key) => {
      const count = new Map();
      for (const s of list) if (s[key]) count.set(s[key], (count.get(s[key]) || 0) + 1);
      let best = null;
      for (let i = list.length - 1; i >= 0; i--) {
        const k = list[i][key];
        if (k && (best == null || count.get(k) > count.get(best))) best = k;
      }
      return best;
    };

    const lastEnd = plans.reduce((m, s) => (!m || s.plan_end > m ? s.plan_end : m), null);
    return {
      count: sales.length,
      plans: plans.length,
      diarias: sales.length - plans.length,
      first: sales.length ? sales[0].at : null,
      last: sales.length ? sales[sales.length - 1].at : null,
      total,
      avg: total != null ? total / paid.length : null,
      renewed, judged,
      coveredDays: covered,
      since,
      lastEnd: lastEnd ? parseISODate(lastEnd) : null,
      days: mostCommon(plans, 'days_per_week'),
      time: mostCommon(sales, 'class_time'),
    };
  }

  const api = {
    pad2, startOfDay, addDays, addMonths, toISODate, parseISODate, fmtDate, daysBetween, fmtMonths, fmtSpan, fmtAgo,
    PLAN_MONTHS, PLAN_LABEL, planEnd, autoNote,
    CPF_NONE, validCpf, searchKey, matchClients,
    INSIGHTS_MONTHS, RENEW_GRACE_DAYS, renewLimit, clientFlow, clientStats,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.SFCore = api;
})();
