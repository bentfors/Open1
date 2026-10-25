import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, seedApprovedWeek } from './world.js';
import { createUser, PASSWORD } from './helpers.js';
import { today } from '../src/dates.js';

describe('ändringslogg', () => {
  let w, admin, sup, basic, anna, bo, cia, dan, eve;

  before(async () => {
    w = await buildWorld();
    ({ anna, bo, cia, dan, eve } = w.users);
    admin = w.admin;
    sup = await createUser(w.app, admin, { email: 'sara@t.se', name: 'Sara Superuser', finance: 2 });
    basic = await createUser(w.app, admin, { email: 'ella@t.se', name: 'Ella Ekonomi', finance: 1 });
  });
  after(() => w.close());

  const read = async (client, query = '') => {
    const r = await client.get(`/api/audit${query}`);
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const rowsOf = async (query) => (await read(admin, query)).rows;
  const count = () => w.app.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;

  test('ändring av en användare loggas med vem, vad, före och efter, och namn i stället för id', async () => {
    assert.equal((await sup.client.patch(`/api/users/${anna.id}`, { bm_id: cia.id, cost_rate: 650 })).status, 200);
    const rows = await rowsOf(`?entity=user&actor_id=${sup.id}&user_id=${anna.id}`);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row.actor_name, row.action, row.label, row.user_label], ['Sara Superuser', 'update', 'Anna Konsult', 'Anna Konsult']);
    assert.deepEqual(row.changes, [
      { field: 'BM', from: '–', to: 'Cia BM' },
      { field: 'Timkostnad', from: '500', to: '650' },
    ]);
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(row.day, today());

    // En sparning som inte ändrar något är ingen ändring.
    const before = count();
    assert.equal((await sup.client.patch(`/api/users/${anna.id}`, { cost_rate: 650 })).status, 200);
    assert.equal(count(), before);
  });

  test('nya användare och lösenord: lösenordet hamnar aldrig i loggen', async () => {
    const created = await sup.client.post('/api/users', { email: 'pelle@t.se', name: 'Pelle Pettersson', role: 'user', password: 'hemligt-tillfalligt-1', cost_rate: 400 });
    assert.equal(created.status, 200);
    assert.equal((await sup.client.post(`/api/users/${created.json.id}/password`, { password: 'annat-hemligt-losen-2' })).status, 200);

    const rows = await rowsOf(`?user_id=${created.json.id}`);
    assert.deepEqual(rows.map((r) => r.action).sort(), ['create', 'password']);
    const create = rows.find((r) => r.action === 'create');
    assert.ok(create.changes.some((c) => c.field === 'Timkostnad' && c.to === '400'));
    assert.ok(rows.find((r) => r.action === 'password').note.includes('Tillfälligt lösenord'));
    const everything = JSON.stringify(await read(sup.client, '?limit=200'));
    for (const secret of ['hemligt-tillfalligt-1', 'annat-hemligt-losen-2', 'scrypt', 'password_hash']) assert.ok(!everything.includes(secret), secret);
  });

  test('kunder, projekt, medlemmar och aktiviteter: kund och projekt följer med så att man kan filtrera', async () => {
    const beta = (await admin.post('/api/customers', { name: 'Beta AB' })).json.id;
    assert.equal((await admin.patch(`/api/customers/${beta}`, { name: 'Beta Group AB' })).status, 200);
    const p3 = (await admin.post('/api/projects', { customer_id: beta, code: 'BETA-1', name: 'Webb', billing_type: 'hourly', hourly_rate: 800 })).json.id;
    assert.equal((await admin.patch(`/api/projects/${p3}`, { manager_id: dan.id, hourly_rate: 900 })).status, 200);

    let rows = await rowsOf(`?entity=project&project_id=${p3}`);
    assert.deepEqual(rows.map((r) => r.action), ['update', 'create'], 'nyast först');
    assert.deepEqual(rows[0].changes, [
      { field: 'Projektledare', from: '–', to: 'Dan Projektledare' },
      { field: 'Timpris', from: '800', to: '900' },
    ]);
    assert.deepEqual([rows[0].project_label, rows[0].customer_label, rows[0].customer_id], ['BETA-1 Webb', 'Beta Group AB', beta], 'kunden hämtas från projektet, med det namn den hade då');

    // Namnet sparas som det hette då, och filterlistan visar det senaste.
    rows = await rowsOf(`?entity=customer&customer_id=${beta}`);
    assert.deepEqual(rows.map((r) => [r.action, r.label, r.customer_label]), [['update', 'Beta Group AB', 'Beta Group AB'], ['create', 'Beta AB', 'Beta AB']]);
    assert.deepEqual(rows[0].changes, [{ field: 'Namn', from: 'Beta AB', to: 'Beta Group AB' }]);
    assert.equal((await read(admin, '?facets=1')).facets.customers.find((c) => c.id === beta).name, 'Beta Group AB');

    assert.equal((await admin.put(`/api/projects/${p3}/members/${anna.id}`, { hourly_rate: 1000 })).status, 200);
    assert.equal((await admin.put(`/api/projects/${p3}/members/${anna.id}`, { hourly_rate: 1100 })).status, 200);
    assert.equal((await admin.del(`/api/projects/${p3}/members/${anna.id}`)).status, 200);
    rows = await rowsOf(`?entity=project_member&project_id=${p3}`);
    assert.deepEqual(rows.map((r) => [r.action, r.user_id, r.label]), [['delete', anna.id, 'Anna Konsult'], ['update', anna.id, 'Anna Konsult'], ['create', anna.id, 'Anna Konsult']]);
    assert.deepEqual(rows[1].changes, [{ field: 'Timpris', from: '1000', to: '1100' }]);

    const act = (await admin.post(`/api/projects/${p3}/activities`, { name: 'Test', billable: true })).json.id;
    await admin.patch(`/api/activities/${act}`, { billable: false });
    await admin.del(`/api/activities/${act}`);
    rows = await rowsOf(`?entity=activity&project_id=${p3}`);
    assert.deepEqual(rows.map((r) => r.action), ['delete', 'update', 'create']);
    assert.deepEqual(rows[1].changes, [{ field: 'Debiterbar', from: 'Ja', to: 'Nej' }]);

    // Raderat projekt och kund finns kvar i loggen, med namn.
    assert.equal((await admin.del(`/api/projects/${p3}`)).status, 200);
    assert.equal((await admin.del(`/api/customers/${beta}`)).status, 200);
    rows = await rowsOf(`?project_id=${p3}&entity=project&action=delete`);
    assert.deepEqual([rows.length, rows[0].label, rows[0].project_label], [1, 'BETA-1 Webb', 'BETA-1 Webb']);
    assert.equal((await rowsOf(`?customer_id=${beta}&action=delete&entity=customer`)).length, 1);
  });

  test('provisionsregler loggar också konsultlistan och vad regeln var när den togs bort', async () => {
    const id = (await admin.post('/api/commission-rules', { earner_id: bo.id, kind: 'tb_percent', period: 'month', percent: 10, source_ids: [anna.id] })).json.id;
    assert.equal((await admin.patch(`/api/commission-rules/${id}`, { percent: 12, source_ids: [anna.id, eve.id] })).status, 200);
    assert.equal((await admin.del(`/api/commission-rules/${id}`)).status, 200);

    const rows = await rowsOf(`?entity=commission_rule&user_id=${bo.id}`);
    assert.deepEqual(rows.map((r) => r.action), ['delete', 'update', 'create']);
    assert.ok(rows[2].changes.some((c) => c.field === 'Konsulter (TB-underlag)' && c.from === '–' && c.to === 'Anna Konsult'));
    assert.deepEqual(rows[1].changes, [
      { field: 'Procent', from: '10', to: '12' },
      { field: 'Konsulter (TB-underlag)', from: 'Anna Konsult', to: 'Anna Konsult, Eve Utomstående' },
    ]);
    assert.ok(rows[0].changes.some((c) => c.field === 'Procent' && c.from === '12' && c.to === '–'), 'sista läget finns kvar');
    assert.equal(rows[0].label, 'Bo AM');
  });

  test('avtal: anställningar och uppdrag, med person, kund och projekt', async () => {
    const emp = (await admin.post('/api/employments', { user_id: anna.id, type: 'permanent', start_date: '2024-01-01' })).json.id;
    await admin.patch(`/api/employments/${emp}`, { type: 'fixed_term', end_date: '2026-12-31' });
    const asg = (await admin.post('/api/assignments', { user_id: anna.id, customer_id: w.customer, project_id: w.p1, start_date: '2025-01-01', hourly_rate: 1000, hours_per_week: 40 })).json.id;
    await admin.del(`/api/assignments/${asg}`);
    await admin.del(`/api/employments/${emp}`);

    const emps = await rowsOf(`?entity=employment&user_id=${anna.id}`);
    assert.deepEqual(emps.map((r) => r.action), ['delete', 'update', 'create']);
    assert.deepEqual(emps[1].changes, [
      { field: 'Typ', from: 'Tillsvidare', to: 'Visstid' },
      { field: 'Slutdatum', from: '–', to: '2026-12-31' },
    ]);
    const asgs = await rowsOf(`?entity=assignment&customer_id=${w.customer}`);
    assert.deepEqual(asgs.map((r) => [r.action, r.label, r.user_id, r.project_id]), [['delete', 'Anna Konsult hos Acme AB', anna.id, w.p1], ['create', 'Anna Konsult hos Acme AB', anna.id, w.p1]]);
    assert.ok(asgs[0].changes.some((c) => c.field === 'Timpris' && c.from === '1000' && c.to === '–'), 'det raderade uppdraget går att läsa ut');
  });

  test('inställningar och periodlåsning', async () => {
    assert.equal((await sup.client.patch('/api/settings', { locked_until: '2025-02-28' })).status, 200);
    assert.equal((await sup.client.patch('/api/settings', { locked_until: null })).status, 200);
    assert.equal((await admin.patch('/api/settings', { mileage_rate: 3 })).status, 200);
    const rows = await rowsOf('?entity=setting');
    assert.deepEqual(rows.map((r) => [r.actor_name, r.label]), [['Administratör', 'Inställningar'], ['Sara Superuser', 'Periodlåsning'], ['Sara Superuser', 'Periodlåsning']]);
    assert.deepEqual(rows[2].changes, [{ field: 'Perioden låst till och med', from: '–', to: '2025-02-28' }]);
    assert.deepEqual(rows[1].changes, [{ field: 'Perioden låst till och med', from: '2025-02-28', to: '–' }]);
    assert.deepEqual(rows[0].changes, [{ field: 'Milersättning (kr/km)', from: '2.5', to: '3' }]);
  });

  test('attest, fakturaunderlag, ångra, avskrivning och att öppna igen loggas med person och projekt', async () => {
    await seedApprovedWeek(w);
    let rows = await rowsOf('?entity=approval&action=approve');
    assert.deepEqual([rows[0].actor_name, rows[0].label, rows[0].user_id, rows[0].project_id], ['Administratör', '4 tidposter', anna.id, null], 'flera projekt: projektfältet tomt');

    // BM attesterar: det syns vem som gjorde det.
    const put = (date, minutes) => anna.client.put('/api/time/entries', { date, activity_id: w.p1Activity, minutes });
    await put('2025-03-17', 60);
    await put('2025-03-18', 90);
    await anna.client.post('/api/time/submit', { week_start: '2025-03-17' });
    const pending = (await cia.client.get('/api/approvals')).json.time;
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: [pending[0].id], decision: 'approve' })).status, 200);
    assert.equal((await cia.client.post('/api/approvals/decide', { kind: 'time', ids: [pending[1].id], decision: 'reject', note: 'Fel projekt' })).status, 200);
    rows = await rowsOf(`?entity=approval&actor_id=${cia.id}`);
    assert.deepEqual(rows.map((r) => [r.action, r.label, r.user_id, r.project_id, r.note]), [
      ['reject', '1 tidpost', anna.id, w.p1, 'Anledning: Fel projekt'],
      ['approve', '1 tidpost', anna.id, w.p1, ''],
    ]);

    const items = (await sup.client.get(`/api/billing/items?project_id=${w.p1}`)).json.items;
    const workId = items.find((i) => i.kind === 'time' && i.what === 'Arbete' && i.selectable).id;
    const inv = await basic.client.post('/api/invoices', { customer_id: w.customer, invoice_date: '2025-04-02', time_ids: [workId] });
    assert.equal(inv.status, 200, inv.text);
    assert.equal((await sup.client.del(`/api/invoices/${inv.json.id}`)).status, 200);
    assert.equal((await sup.client.post('/api/billing/waive', { time_ids: [workId], note: 'Kulans' })).status, 200);
    assert.equal((await sup.client.post('/api/billing/restore', { time_ids: [workId] })).status, 200);

    rows = await rowsOf(`?project_id=${w.p1}&sort=at&dir=asc`);
    const kinds = rows.filter((r) => ['invoice', 'billing'].includes(r.entity)).map((r) => [r.entity, r.action, r.actor_name]);
    assert.deepEqual(kinds, [['invoice', 'create', 'Ella Ekonomi'], ['invoice', 'undo', 'Sara Superuser'], ['billing', 'waive', 'Sara Superuser'], ['billing', 'restore', 'Sara Superuser']]);
    const waive = rows.find((r) => r.action === 'waive');
    assert.deepEqual([waive.label, waive.user_id, waive.customer_id, waive.note], ['1 tidpost', anna.id, w.customer, 'Anledning: Kulans']);
    const invoice = rows.find((r) => r.entity === 'invoice' && r.action === 'create');
    assert.ok(invoice.label.length > 0 && /1 tidpost, 9600 kr/.test(invoice.note), invoice.note);

    // Att öppna godkänd tid igen är administratörens, och syns.
    const meetingId = w.app.db.prepare("SELECT id FROM time_entries WHERE activity_id = ? AND status = 'approved'").get(w.meeting).id;
    assert.equal((await admin.post('/api/approvals/reopen', { kind: 'time', ids: [meetingId] })).status, 200);
    rows = await rowsOf('?entity=approval&action=reopen');
    assert.deepEqual([rows[0].label, rows[0].user_id, rows[0].project_id], ['1 tidpost', anna.id, w.p1]);
  });

  test('tid som ändras åt någon annan eller i en låst period loggas, egen tid gör det inte', async () => {
    const timeRows = () => rowsOf('?entity=time&sort=at&dir=asc');
    const start = (await timeRows()).length;

    // Egen tid.
    assert.equal((await anna.client.put('/api/time/entries', { date: '2025-03-10', activity_id: w.p1Activity, minutes: 30 })).status, 200);
    assert.equal((await timeRows()).length, start);

    // Administratören rapporterar åt Anna.
    const put = (minutes) => admin.put('/api/time/entries', { date: '2025-03-11', activity_id: w.p1Activity, minutes, user_id: anna.id });
    assert.equal((await put(120)).status, 200);
    assert.equal((await put(180)).status, 200);
    assert.equal((await put(0)).status, 200);
    const rows = (await timeRows()).slice(start);
    assert.deepEqual(rows.map((r) => [r.action, r.changes[0].from, r.changes[0].to]), [['create', '–', '2 tim'], ['update', '2 tim', '3 tim'], ['delete', '3 tim', '–']]);
    assert.deepEqual([rows[0].user_id, rows[0].project_id, rows[0].customer_id, rows[0].note], [anna.id, w.p1, w.customer, 'Ändrat åt en annan person.']);

    // Administratören rättar sin egen tid i en låst period.
    await sup.client.patch('/api/settings', { locked_until: '2025-12-31' });
    assert.equal((await admin.put('/api/time/entries', { date: '2025-03-12', absence_type_id: w.vacation, minutes: 480 })).status, 200);
    await sup.client.patch('/api/settings', { locked_until: null });
    const locked = (await timeRows()).at(-1);
    assert.deepEqual([locked.note, locked.actor_name, locked.label], ['Ändrat i en låst period.', 'Administratör', '2025-03-12']);

    // Utlägg: egna loggas inte, men administratörens ändring av Annas gör det.
    const exp = (await anna.client.post('/api/expenses', { date: '2025-03-04', description: 'Tåg', amount: 500, project_id: w.p1 })).json.id;
    const before = count();
    await anna.client.patch(`/api/expenses/${exp}`, { description: 'Tåg, 2:a klass' });
    assert.equal(count(), before, 'egen ändring loggas inte');
    assert.equal((await admin.patch(`/api/expenses/${exp}`, { description: 'Tåg 1:a klass', amount: 650 })).status, 200);
    assert.equal((await admin.del(`/api/expenses/${exp}`)).status, 200);
    const log = await rowsOf(`?entity=expense&user_id=${anna.id}`);
    assert.deepEqual(log.map((r) => r.action), ['delete', 'update']);
    assert.deepEqual(log[1].changes, [
      { field: 'Beskrivning', from: 'Tåg, 2:a klass', to: 'Tåg 1:a klass' },
      { field: 'Belopp', from: '500', to: '650' },
    ]);
  });

  test('filter: utförd av, berörd användare, kund, projekt, typ, ändring, datum och fritext', async () => {
    const all = await read(admin, '?limit=200');
    assert.ok(all.total > 30, `loggen har ${all.total} rader`);

    const by = await rowsOf(`?actor_id=${sup.id}&limit=200`);
    assert.ok(by.length > 3 && by.every((r) => r.actor_id === sup.id));
    const forAnna = await rowsOf(`?user_id=${anna.id}&limit=200`);
    assert.ok(forAnna.length > 8 && forAnna.every((r) => r.user_id === anna.id));
    const forCustomer = await rowsOf(`?customer_id=${w.customer}&limit=200`);
    assert.ok(forCustomer.length > 5 && forCustomer.every((r) => r.customer_id === w.customer));
    const forProject = await rowsOf(`?project_id=${w.p1}&limit=200`);
    assert.ok(forProject.length > 5 && forProject.every((r) => r.project_id === w.p1 && r.project_label === 'ACME-1 Plattform' && r.customer_label === 'Acme AB'));
    const creates = await rowsOf('?entity=project&action=create&limit=200');
    assert.ok(creates.length >= 3 && creates.every((r) => r.entity === 'project' && r.action === 'create'));

    // Kombinerade filter.
    const combined = await rowsOf(`?actor_id=${sup.id}&entity=user&user_id=${anna.id}`);
    assert.ok(combined.length >= 1 && combined.every((r) => r.actor_id === sup.id && r.entity === 'user' && r.user_id === anna.id));

    // Fritext söker i namn, anteckning och ändringar, utan skiftlägeskänslighet. Specialtecken är bokstäver.
    const text = await rowsOf('?q=plattform&limit=200');
    assert.ok(text.length > 0 && text.every((r) => JSON.stringify(r).toLowerCase().includes('plattform')));
    assert.equal((await read(admin, `?q=${encodeURIComponent('%')}`)).total, 0, '% är ingen jokertecken');
    assert.equal((await read(admin, `?q=${encodeURIComponent('_')}`)).total, 0);
    assert.ok((await read(admin, `?q=${encodeURIComponent('Fel projekt')}`)).total >= 1, 'söker i anteckningen');
    assert.ok((await read(admin, `?q=${encodeURIComponent('Anna Konsult, Eve')}`)).total >= 1, 'söker i ändringarna');

    // Datum, på lokal dag.
    const t = today();
    assert.equal((await read(admin, `?from=${t}&to=${t}&limit=1`)).total, all.total);
    assert.equal((await read(admin, '?from=2099-01-01')).total, 0);
    assert.equal((await read(admin, '?to=2000-01-01')).total, 0);

    // Ogiltigt.
    for (const bad of ['?actor_id=abc', '?from=igår', '?limit=0', '?offset=-1', '?limit=x']) assert.equal((await admin.get(`/api/audit${bad}`)).status, 400, bad);
    assert.equal((await read(admin, '?entity=finns-inte')).total, all.total, 'okänd typ ignoreras');
  });

  test('sortering: på varje kolumn, åt båda hållen, tomma värden sist, och bara på tillåtna kolumner', async () => {
    const ids = (rows) => rows.map((r) => r.id);
    const desc = ids(await rowsOf('?limit=200'));
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a), 'nyast först som standard');
    assert.deepEqual(ids(await rowsOf('?sort=at&dir=asc&limit=200')), [...desc].reverse());

    const labels = (await read(admin)).labels;
    const lower = (s) => (s ?? '').toLowerCase();
    const sorted = (values, dir) => values.every((v, i) => i === 0 || (dir === 'asc' ? values[i - 1] <= v : values[i - 1] >= v));
    for (const dir of ['asc', 'desc']) {
      assert.ok(sorted((await rowsOf(`?sort=actor&dir=${dir}&limit=200`)).map((r) => lower(r.actor_name)), dir), `utförd av ${dir}`);
      assert.ok(sorted((await rowsOf(`?sort=action&dir=${dir}&limit=200`)).map((r) => lower(labels.action[r.action])), dir), `typ av ändring ${dir}`);
      assert.ok(sorted((await rowsOf(`?sort=entity&dir=${dir}&limit=200`)).map((r) => lower(labels.entity[r.entity])), dir), `avser ${dir}`);
      assert.ok(sorted((await rowsOf(`?sort=label&dir=${dir}&limit=200`)).map((r) => lower(r.label)), dir), `beskrivning ${dir}`);

      // Rader utan kund, projekt eller användare hamnar sist, oavsett håll.
      for (const [key, col] of [['customer', 'customer_label'], ['project', 'project_label'], ['user', 'user_label']]) {
        const values = (await rowsOf(`?sort=${key}&dir=${dir}&limit=200`)).map((r) => r[col]);
        const firstEmpty = values.findIndex((v) => v == null);
        assert.ok(firstEmpty > 0, `${key}: det finns både tomma och ifyllda`);
        assert.ok(values.slice(firstEmpty).every((v) => v == null), `${key} ${dir}: tomma sist`);
        assert.ok(sorted(values.slice(0, firstEmpty).map(lower), dir), `${key} ${dir}`);
      }
    }
    assert.equal(lower(labels.action.create) < lower(labels.action.update), true, 'sorteras på svenska namn: Skapad före Ändrad');

    // Okända kolumner och riktningar ändrar ingenting, och går aldrig till SQL.
    const normal = ids(await rowsOf('?limit=200'));
    for (const bad of ['?sort=bogus&dir=sideways', '?sort=id;DROP%20TABLE%20users--', `?sort=${encodeURIComponent('a.id; DELETE FROM users')}`, '?sort=constructor']) {
      assert.deepEqual(ids(await rowsOf(`${bad}${bad.includes('?') ? '&' : '?'}limit=200`)), normal, bad);
    }
    assert.ok(w.app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 5);
  });

  test('sidindelning', async () => {
    const full = await read(admin, '?limit=200');
    const page = await read(admin, '?limit=3&offset=2');
    assert.deepEqual([page.rows.length, page.total, page.limit, page.offset], [3, full.total, 3, 2]);
    assert.deepEqual(page.rows.map((r) => r.id), full.rows.slice(2, 5).map((r) => r.id));
    assert.equal((await read(admin, '?limit=100000')).limit, 200, 'taket är 200 per sida');
    assert.equal((await read(admin, '?limit=5&offset=100000')).rows.length, 0);
    assert.equal((await read(admin)).limit, 50);
    assert.equal('facets' in (await read(admin)), false, 'filterlistorna hämtas bara på begäran');
  });

  test('filterlistorna visar det som finns i loggen, med svenska namn', async () => {
    const { facets, labels } = await read(admin, '?facets=1');
    assert.ok(facets.actors.some((a) => a.id === sup.id && a.name === 'Sara Superuser'));
    assert.ok(facets.users.some((u) => u.id === anna.id && u.name === 'Anna Konsult'));
    assert.ok(facets.projects.some((p) => p.id === w.p1 && p.name === 'ACME-1 Plattform'));
    assert.ok(facets.customers.some((c) => c.id === w.customer && c.name === 'Acme AB'));
    assert.ok(facets.entities.some((e) => e.value === 'commission_rule' && e.label === 'Provisionsregel'));
    assert.ok(facets.actions.some((a) => a.value === 'password' && a.label === 'Lösenord satt'));
    assert.equal(labels.entity.project_member, 'Projektmedlem');
    const names = facets.actions.map((a) => a.label);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'sv')), 'sorterade');
  });

  test('namn sparas som de hette då: ett namnbyte skriver inte om historiken', async () => {
    const tore = await createUser(w.app, admin, { email: 'tore@t.se', name: 'Tore Test', finance: 2 });
    await tore.client.patch(`/api/users/${eve.id}`, { weekly_hours: 32 });
    assert.equal((await admin.patch(`/api/users/${tore.id}`, { name: 'Tore Svensson' })).status, 200);
    await tore.client.patch(`/api/users/${eve.id}`, { weekly_hours: 36 });

    const rows = await rowsOf(`?actor_id=${tore.id}&entity=user&user_id=${eve.id}`);
    assert.deepEqual(rows.map((r) => r.actor_name), ['Tore Svensson', 'Tore Test']);
    assert.equal((await read(admin, '?facets=1')).facets.actors.find((a) => a.id === tore.id).name, 'Tore Svensson');
    const renamed = (await rowsOf(`?entity=user&user_id=${tore.id}&action=update`))[0];
    assert.deepEqual([renamed.actor_name, renamed.label, renamed.changes[0]], ['Administratör', 'Tore Svensson', { field: 'Namn', from: 'Tore Test', to: 'Tore Svensson' }]);
  });

  test('en misslyckad ändring lämnar ingen loggrad', async () => {
    const before = count();
    assert.equal((await admin.post('/api/customers', { name: 'Acme AB' })).status, 409);
    assert.equal((await admin.post('/api/customers', {})).status, 400);
    assert.equal((await sup.client.patch(`/api/users/${anna.id}`, { role: 'admin' })).status, 403);
    assert.equal((await sup.client.post('/api/users', { email: 'nej@t.se', name: 'Nej', role: 'admin', password: PASSWORD })).status, 403);
    assert.equal((await admin.patch('/api/settings', { locked_until: 'inte-ett-datum' })).status, 400);
    assert.equal(count(), before);
  });

  test('bara ekonomi-superuser och administratörer läser, ingen kan ändra, och databasen stoppar det också', async () => {
    for (const [who, expected] of [[admin, 200], [sup.client, 200], [basic.client, 403], [anna.client, 403], [bo.client, 403]]) {
      assert.equal((await who.get('/api/audit')).status, expected);
    }
    assert.equal((await w.app.client().get('/api/audit')).status, 401);
    for (const method of ['post', 'put', 'patch', 'del']) assert.equal((await admin[method]('/api/audit', {})).status, 405, method);
    assert.equal((await admin.del('/api/audit/1')).status, 404);

    assert.throws(() => w.app.db.exec("UPDATE audit_log SET label = 'ändrad'"), /kan inte ändras/);
    assert.throws(() => w.app.db.exec('DELETE FROM audit_log'), /kan inte raderas/);
    assert.throws(() => w.app.db.exec('DELETE FROM audit_log WHERE id = 1'), /kan inte raderas/);
  });

  test('export till CSV följer samma filter och skyddar mot formler', async () => {
    const res = await sup.client.get(`/api/audit?format=csv&actor_id=${sup.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.ok(res.text.startsWith('﻿När;Utförd av;Typ av ändring;Avser;Beskrivning;Kund;Projekt;Användare;Ändrat;Anteckning'));
    const lines = res.text.trim().split('\r\n');
    const total = (await read(sup.client, `?actor_id=${sup.id}`)).total;
    assert.equal(lines.length - 1, total);
    assert.ok(lines.slice(1).every((l) => l.includes('Sara Superuser')));
    assert.ok(lines.some((l) => l.includes('Timkostnad: 500 → 650')));

    await admin.patch(`/api/users/${eve.id}`, { name: '=HYPERLINK("http://x")' });
    const all = await admin.get('/api/audit?format=csv');
    assert.ok(all.text.includes("'=HYPERLINK"), 'formelstart neutraliseras');
    assert.equal((await basic.client.get('/api/audit?format=csv')).status, 403);
  });
});
