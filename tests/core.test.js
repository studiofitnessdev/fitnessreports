// Tests for js/core.js. Run: npm test (or node --test). No dependencies: Node's built-in test runner.
// Brazil's time zone, as on the gym's phones: dates must stay on the right day.
process.env.TZ = 'America/Sao_Paulo';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const d = (iso, time = '10:00') => { // local date (and time) from "2026-11-17"
  const [h, m] = time.split(':').map(Number);
  const day = C.parseISODate(iso);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
};
const iso = (date) => C.toISODate(date);

test('addMonths clamps to the last day of the month', () => {
  assert.equal(iso(C.addMonths(d('2026-01-31'), 1)), '2026-02-28');
  assert.equal(iso(C.addMonths(d('2028-01-31'), 1)), '2028-02-29'); // leap year
  assert.equal(iso(C.addMonths(d('2028-02-29'), 12)), '2029-02-28');
  assert.equal(iso(C.addMonths(d('2026-03-31'), 1)), '2026-04-30');
  assert.equal(iso(C.addMonths(d('2026-05-31'), 3)), '2026-08-31');
  assert.equal(iso(C.addMonths(d('2026-11-30'), 3)), '2027-02-28');
  assert.equal(iso(C.addMonths(d('2026-11-15'), 3)), '2027-02-15'); // into the next year
  assert.equal(iso(C.addMonths(d('2026-12-31'), 12)), '2027-12-31');
  assert.equal(iso(C.addMonths(d('2026-11-17'), 0)), '2026-11-17');
});

test('addMonths backwards (Histórico "Últimos 6 meses")', () => {
  assert.equal(iso(C.addMonths(d('2026-08-31'), -6)), '2026-02-28');
  assert.equal(iso(C.addMonths(d('2026-03-31'), -1)), '2026-02-28');
  assert.equal(iso(C.addMonths(d('2026-01-15'), -12)), '2025-01-15');
});

test('planEnd per plan', () => {
  assert.equal(iso(C.planEnd('diaria', d('2026-11-17'))), '2026-11-17');
  assert.equal(iso(C.planEnd('mensal', d('2026-11-17'))), '2026-12-17');
  assert.equal(iso(C.planEnd('trimestral', d('2026-11-17'))), '2027-02-17');
  assert.equal(iso(C.planEnd('semestral', d('2026-08-31'))), '2027-02-28');
  assert.equal(iso(C.planEnd('anual', d('2026-11-17'))), '2027-11-17');
});

test('parseISODate gives local midnight of that day (new Date(iso) would be the day before in Brazil)', () => {
  const day = C.parseISODate('2026-11-17');
  assert.equal(day.getDate(), 17);
  assert.equal(day.getHours(), 0);
  assert.equal(new Date('2026-11-17').getDate(), 16); // the trap parseISODate avoids
  assert.equal(C.toISODate(C.parseISODate('2027-01-05')), '2027-01-05');
  assert.equal(C.fmtDate(day), '17/11/2026');
});

test('addDays and daysBetween across months, years and old daylight-saving days', () => {
  assert.equal(iso(C.addDays(d('2026-12-31'), 1)), '2027-01-01');
  assert.equal(iso(C.addDays(d('2026-03-01'), -1)), '2026-02-28');
  assert.equal(C.daysBetween(d('2026-11-01'), d('2026-12-01')), 30);
  assert.equal(C.daysBetween(d('2026-11-17', '23:59'), d('2026-11-18', '00:01')), 1);
  // Brazil still had DST in 2018: 04/11/2018 started at 01:00
  assert.equal(iso(C.addDays(d('2018-11-03'), 1)), '2018-11-04');
  assert.equal(C.daysBetween(d('2018-11-03'), d('2018-11-05')), 2);
});

test('autoNote matches sale_auto_note() in the database', () => {
  assert.equal(C.autoNote('mensal', d('2026-11-17'), d('2026-12-17')), 'Plano Mensal: 17/11/2026 a 17/12/2026');
  assert.equal(C.autoNote('trimestral', d('2026-11-17'), d('2027-02-17')), 'Plano Trimestral: 17/11/2026 a 17/02/2027');
  assert.equal(C.autoNote('diaria', d('2026-11-17'), d('2026-11-17')), 'Diária: 17/11/2026');
});

test('validCpf checks the two check digits', () => {
  assert.equal(C.validCpf('52998224725'), true);
  assert.equal(C.validCpf('11144477735'), true);
  assert.equal(C.validCpf('52998224724'), false); // last digit wrong
  assert.equal(C.validCpf('11111111111'), false); // all the same
  assert.equal(C.validCpf(C.CPF_NONE), false);
  assert.equal(C.validCpf('5299822472'), false); // 10 digits
  assert.equal(C.validCpf('529.982.247-25'), false); // digits only
});

test('searchKey drops accents and case', () => {
  assert.equal(C.searchKey('  João da Conceição '), 'JOAO DA CONCEICAO');
});

test('matchClients: name words in any order, accents ignored, CPF and WhatsApp digits', () => {
  const clients = [
    { id: 1, name: 'JOÃO DA SILVA', cpf: '52998224725', phone: '35999998888' },
    { id: 2, name: 'MARIA JOSÉ', cpf: C.CPF_NONE, phone: null },
    { id: 3, name: 'ANA SILVA', cpf: '11144477735' },
  ];
  const ids = (q) => C.matchClients(clients, q).map((c) => c.id);
  assert.deepEqual(ids('joao'), [1]);
  assert.deepEqual(ids('silva joão'), [1]);
  assert.deepEqual(ids('silva'), [1, 3]);
  assert.deepEqual(ids('jose'), [2]);
  assert.deepEqual(ids(''), [1, 2, 3]);
  assert.deepEqual(ids('529'), [1]);
  assert.deepEqual(ids('144'), [3]);
  assert.deepEqual(ids('000'), []); // never everyone without CPF
  assert.deepEqual(ids('9999'), [1]); // WhatsApp
  assert.deepEqual(ids('99'), []); // too few digits
});

// ── Renewals
let nextId = 1;
const sale = (client_id, created, plan, plan_start, plan_end, extra = {}) => ({
  id: nextId++, client_id, created_at: d(created).toISOString(), at: d(created), plan, plan_start, plan_end, ...extra,
});
const monthOf = (renewal, y, m) => renewal.find((r) => r.y === y && r.m === m - 1);

test('clientFlow renewal rate: renewed up to the 15th day after the end, not the 16th', () => {
  const sales = [
    sale(1, '2026-08-10', 'mensal', '2026-08-10', '2026-09-10'),
    sale(1, '2026-09-20', 'mensal', '2026-09-20', '2026-10-20'), // 10 days after: renewed
    sale(2, '2026-08-15', 'mensal', '2026-08-15', '2026-09-15'),
    sale(2, '2026-09-30', 'mensal', '2026-09-30', '2026-10-30'), // 15th day: renewed
    sale(3, '2026-08-20', 'mensal', '2026-08-20', '2026-09-20'),
    sale(3, '2026-10-06', 'mensal', '2026-10-06', '2026-11-06'), // 16th day: not renewed
    sale(4, '2026-08-25', 'mensal', '2026-08-25', '2026-09-25'), // never came back
    sale(5, '2026-09-12', 'diaria', '2026-09-12', '2026-09-12'), // a Diária is not a plan
    sale(null, '2026-08-01', 'mensal', '2026-08-01', '2026-09-01'), // deleted client: left out
  ];
  const { renewal } = C.clientFlow(sales, d('2026-11-17'));
  assert.deepEqual(monthOf(renewal, 2026, 9), { y: 2026, m: 8, total: 4, renewed: 2 });
  assert.deepEqual(monthOf(renewal, 2026, 10), { y: 2026, m: 9, total: 2, renewed: 0 });
  assert.equal(monthOf(renewal, 2026, 8), undefined); // no plan ended in August
});

test('clientFlow skips a month until its grace days are over', () => {
  const sales = [sale(1, '2026-09-30', 'mensal', '2026-09-30', '2026-10-30')];
  assert.equal(monthOf(C.clientFlow(sales, d('2026-11-15')).renewal, 2026, 10), undefined);
  assert.deepEqual(monthOf(C.clientFlow(sales, d('2026-11-16')).renewal, 2026, 10), { y: 2026, m: 9, total: 1, renewed: 0 });
});

test('clientFlow new clients vs renewals', () => {
  const sales = [
    sale(6, '2025-06-01', 'mensal', '2025-06-01', '2025-07-01'),
    sale(6, '2026-11-03', 'mensal', '2026-11-03', '2026-12-03'), // back after more than a year: new
    sale(7, '2025-12-10', 'mensal', '2025-12-10', '2026-01-10'),
    sale(7, '2026-11-05', 'mensal', '2026-11-05', '2026-12-05'), // less than a year: renewal
    sale(8, '2026-11-02', 'mensal', '2026-11-02', '2026-12-02'), // first plan: new
    sale(8, '2026-11-10', 'trimestral', '2026-11-10', '2027-02-10'), // same month again: renewal, still one new client
    sale(9, '2026-11-11', 'diaria', '2026-11-11', '2026-11-11'), // Diárias don't count
  ];
  const { flow } = C.clientFlow(sales, d('2026-11-17'));
  const nov = flow[flow.length - 1];
  assert.equal(nov.m, 10);
  assert.equal(nov.fresh, 2);
  assert.equal(nov.renewals, 2);
  assert.equal(flow.length, 6);
});

// ── Client page
const row = (created, plan, plan_start, plan_end, days_per_week, class_time, amount) => ({
  id: nextId++, created_at: d(created, '09:00').toISOString(), plan, plan_start, plan_end, days_per_week, class_time,
  ...(amount != null ? { amount: String(amount) } : {}), // the database sends numeric as text
});
const history = (withAmounts) => {
  const a = (v) => (withAmounts ? v : null);
  return [
    row('2026-05-02', 'mensal', '2026-05-02', '2026-06-02', '3', '07:00', a(150)),
    row('2026-06-10', 'mensal', '2026-06-10', '2026-07-10', '3', '07:00', a(150)), // 8 days late: renewed
    row('2026-08-01', 'trimestral', '2026-08-01', '2026-11-01', '2', '18:00', a(400)), // 22 days late: not renewed
    row('2026-11-05', 'diaria', '2026-11-05', '2026-11-05', '1', '18:00', a(30)),
    row('2026-11-10', 'mensal', '2026-11-10', '2026-12-10', '2', '18:00', a(150)), // 9 days late: renewed; still running
  ];
};

test('clientStats: purchases, money, renewals, time with a plan and routine', () => {
  const s = C.clientStats(history(true).reverse(), d('2026-11-17')); // any order in
  assert.equal(s.count, 5);
  assert.equal(s.plans, 4);
  assert.equal(s.diarias, 1);
  assert.equal(iso(s.first), '2026-05-02');
  assert.equal(s.total, 880);
  assert.equal(s.avg, 176);
  assert.equal(s.renewed, 2);
  assert.equal(s.judged, 3); // the running plan isn't judged yet
  assert.equal(s.coveredDays, 32 + 31 + 93 + 8); // both ends included, up to today; the Diária isn't a plan
  assert.equal(iso(s.since), '2026-08-01'); // the 22-day gap broke the run, the 9-day one didn't
  assert.equal(iso(s.lastEnd), '2026-12-10');
  assert.equal(s.days, '2'); // 2 and 3 tie: the most recent wins
  assert.equal(s.time, '18:00');
});

test('clientStats without values (Professor)', () => {
  const s = C.clientStats(history(false), d('2026-11-17'));
  assert.equal(s.total, null);
  assert.equal(s.avg, null);
  assert.equal(s.count, 5);
});

test('clientStats: no purchases, only Diárias, plan ended', () => {
  const none = C.clientStats([], d('2026-11-17'));
  assert.deepEqual([none.count, none.first, none.total, none.coveredDays, none.since, none.days, none.time, none.judged],
    [0, null, null, 0, null, null, null, 0]);

  const diarias = C.clientStats([row('2026-11-05', 'diaria', '2026-11-05', '2026-11-05', '1', '06:30', 30)], d('2026-11-17'));
  assert.equal(diarias.plans, 0);
  assert.equal(diarias.coveredDays, 0);
  assert.equal(diarias.since, null);
  assert.equal(diarias.days, null);
  assert.equal(diarias.time, '06:30');

  const ended = C.clientStats([row('2026-09-01', 'mensal', '2026-09-01', '2026-10-01', '3', '07:00')], d('2026-11-17'));
  assert.equal(ended.since, null); // no plan today
  assert.equal(ended.coveredDays, 31);
  assert.deepEqual([ended.renewed, ended.judged], [0, 1]);
});

test('clientStats: the first day counts, and an early renewal overlaps without counting twice', () => {
  const first = C.clientStats([row('2026-11-17', 'mensal', '2026-11-17', '2026-12-17', '3', '07:00')], d('2026-11-17'));
  assert.equal(first.coveredDays, 1);
  assert.equal(iso(first.since), '2026-11-17');
  const early = C.clientStats([
    row('2026-01-01', 'mensal', '2026-01-01', '2026-02-01', '3', '07:00'),
    row('2026-01-25', 'mensal', '2026-01-25', '2026-02-25', '3', '07:00'),
  ], d('2026-03-10'));
  assert.equal(early.coveredDays, 31 + 25);
  assert.deepEqual([early.renewed, early.judged], [1, 1]);
});

test('fmtSpan and fmtAgo', () => {
  assert.equal(C.fmtSpan(0), '0 dias');
  assert.equal(C.fmtSpan(1), '1 dia');
  assert.equal(C.fmtSpan(29), '29 dias');
  assert.equal(C.fmtSpan(30), '1 mês');
  assert.equal(C.fmtSpan(164), '5 meses');
  assert.equal(C.fmtSpan(365), '1 ano');
  assert.equal(C.fmtSpan(500), '1 ano e 4 meses');
  assert.equal(C.fmtSpan(730), '2 anos');
  const now = d('2026-11-17');
  assert.equal(C.fmtAgo(d('2026-11-17', '08:00'), now), 'hoje');
  assert.equal(C.fmtAgo(d('2026-11-16'), now), 'ontem');
  assert.equal(C.fmtAgo(d('2026-11-05'), now), 'há 12 dias');
  assert.equal(C.fmtAgo(d('2026-05-02'), now), 'há 6 meses');
  assert.equal(C.fmtAgo(d('2025-09-20'), now), 'há 1 ano e 1 mês'); // 17 < 20: not 14 months yet
  assert.equal(C.fmtAgo(d('2026-10-31'), d('2026-11-30')), 'há 30 dias');
});
