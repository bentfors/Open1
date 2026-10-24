import { get, post, put, patch, del } from '../api.js';
import { h, fmtMoney, fmtNum, fmtHours, toast, editDialog, confirmDialog, openDialog, dataTable, optionList, buildForm, add, setKids } from '../dom.js';
import { state } from '../state.js';

const TABS = [
  ['anvandare', 'Användare'],
  ['kunder', 'Kunder'],
  ['projekt', 'Projekt'],
  ['kategorier', 'Kategorier'],
  ['provision', 'Provision'],
  ['franvaro', 'Frånvaro'],
  ['installningar', 'Inställningar'],
];

const personLabel = (u) => (u.category_name ? `${u.name} (${u.category_name})` : u.name);

// Gemensam ram för en listvy: rubrik, "Ny"-knapp och en tabell som kan laddas om.
function listSection(root, { title, intro, newLabel, onNew }) {
  const box = h('div', { class: 'card flush' });
  add(root, 
    h('div', { class: 'row between' }, h('div', {}, h('h2', {}, title), intro ? h('p', { class: 'muted' }, intro) : null), newLabel ? h('button', { class: 'btn primary', type: 'button', onclick: onNew }, newLabel) : null),
    box,
  );
  return box;
}

const actionBtn = (label, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick }, label);

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Användare ───────────────────────────────────────────────────────────
async function usersTab(root) {
  let box;
  const refs = async () => {
    const [categories, users] = await Promise.all([get('/api/categories'), get('/api/users')]);
    return { categories, users };
  };

  async function reload() {
    const { users } = await refs();
    setKids(box, 
      dataTable({
        rows: users,
        rowClass: (u) => (u.active ? '' : 'inactive'),
        columns: [
          { label: 'Namn', render: (u) => [u.name, u.active ? null : h('span', { class: 'chip', title: 'Inaktiv' }, ' inaktiv'), u.role === 'admin' ? h('span', { class: 'chip accent' }, ' admin') : null] },
          { label: 'E-post', render: (u) => u.email },
          { label: 'Kategori', render: (u) => u.category_name || '' },
          { label: 'Chef', render: (u) => u.manager_name || '' },
          { label: 'Timkostnad', num: true, render: (u) => fmtMoney(u.cost_rate) },
          { label: 'Std-pris', num: true, render: (u) => (u.default_bill_rate ? fmtMoney(u.default_bill_rate) : '') },
          { label: 'Tim/vecka', num: true, render: (u) => fmtNum(u.weekly_hours) },
          { label: '', class: 'actions', render: (u) => [actionBtn('Ändra', () => edit(u)), ' ', actionBtn('Lösenord', () => resetPassword(u))] },
        ],
      }),
    );
  }

  async function edit(existing) {
    const { categories, users } = await refs();
    const fields = [
      { name: 'name', label: 'Namn', required: true, maxlength: 100 },
      { name: 'email', label: 'E-post', type: 'email', required: true },
      { name: 'role', label: 'Roll', type: 'select', options: [{ value: 'user', label: 'Användare' }, { value: 'admin', label: 'Administratör' }] },
      { name: 'category_id', label: 'Kategori', type: 'select', options: optionList(categories, { blank: '(ingen)' }) },
      { name: 'manager_id', label: 'Chef (attesterar frånvaro)', type: 'select', options: optionList(users.filter((u) => u.active && u.id !== existing?.id), { blank: '(ingen)' }) },
      { name: 'weekly_hours', label: 'Arbetstid per vecka (tim)', type: 'number', step: '0.5', min: '0', max: '80' },
      { name: 'cost_rate', label: 'Intern timkostnad (kr/tim)', type: 'number', step: '1', min: '0', hint: 'Används för TB. Syns bara för administratörer.' },
      { name: 'default_bill_rate', label: 'Standard timpris (kr/tim)', type: 'number', step: '1', min: '0', hint: 'Används när varken projekt, aktivitet eller medlem har eget pris.' },
      ...(existing ? [{ name: 'active', label: 'Aktiv', type: 'checkbox' }] : [{ name: 'password', label: 'Tillfälligt lösenord', type: 'password', required: true, hint: 'Minst 10 tecken. Användaren måste byta vid första inloggning.', full: true }]),
    ];
    editDialog({
      title: existing ? `Ändra ${existing.name}` : 'Ny användare',
      fields,
      values: existing ? { ...existing, active: !!existing.active } : { role: 'user', weekly_hours: 40, cost_rate: 0, default_bill_rate: 0 },
      onSave: async (v) => {
        const body = { ...v, cost_rate: v.cost_rate ?? 0, default_bill_rate: v.default_bill_rate ?? 0, weekly_hours: v.weekly_hours ?? 40 };
        if (existing) await patch(`/api/users/${existing.id}`, body);
        else await post('/api/users', body);
        toast('Användaren är sparad.', 'ok');
        await reload();
      },
    });
  }

  function resetPassword(u) {
    editDialog({
      title: `Nytt lösenord för ${u.name}`,
      saveLabel: 'Sätt lösenord',
      fields: [{ name: 'password', label: 'Tillfälligt lösenord', type: 'password', required: true, hint: 'Användaren loggas ut överallt och måste byta lösenord vid nästa inloggning.', full: true }],
      values: {},
      onSave: async (v) => {
        await post(`/api/users/${u.id}/password`, v);
        toast('Lösenordet är satt.', 'ok');
      },
    });
  }

  box = listSection(root, { title: 'Användare', intro: 'Konton, roller, kategorier och interna kostnader.', newLabel: '+ Ny användare', onNew: () => guarded(() => edit(null)) });
  await reload();
}

// ── Kunder ──────────────────────────────────────────────────────────────
async function customersTab(root) {
  let box;
  async function reload() {
    const rows = await get('/api/customers');
    setKids(box, 
      dataTable({
        rows,
        rowClass: (c) => (c.active ? '' : 'inactive'),
        columns: [
          { label: 'Kund', render: (c) => [c.name, c.active ? null : h('span', { class: 'chip' }, ' inaktiv')] },
          { label: 'Org.nr', render: (c) => c.org_no },
          { label: 'Kontakt', render: (c) => [c.contact_name, c.email ? h('div', { class: 'small muted' }, c.email) : null] },
          { label: 'Projekt', num: true, render: (c) => c.projects },
          {
            label: '',
            class: 'actions',
            render: (c) => [
              actionBtn('Ändra', () => edit(c)),
              ' ',
              c.projects
                ? null
                : actionBtn(
                    'Ta bort',
                    () =>
                      guarded(async () => {
                        if (!(await confirmDialog(`Ta bort ${c.name}?`, { confirmLabel: 'Ta bort', danger: true }))) return;
                        await del(`/api/customers/${c.id}`);
                        await reload();
                      }),
                    'danger',
                  ),
            ],
          },
        ],
      }),
    );
  }
  function edit(existing) {
    editDialog({
      title: existing ? `Ändra ${existing.name}` : 'Ny kund',
      values: existing ? { ...existing, active: !!existing.active } : {},
      fields: [
        { name: 'name', label: 'Kundnamn', required: true, maxlength: 120, full: true },
        { name: 'org_no', label: 'Organisationsnummer', maxlength: 30 },
        { name: 'contact_name', label: 'Kontaktperson', maxlength: 100 },
        { name: 'email', label: 'E-post', maxlength: 200 },
        { name: 'phone', label: 'Telefon', maxlength: 50 },
        { name: 'address', label: 'Adress', maxlength: 300, full: true },
        { name: 'invoice_ref', label: 'Fakturareferens', maxlength: 200, full: true },
        { name: 'notes', label: 'Anteckningar', type: 'textarea', maxlength: 2000, full: true },
        ...(existing ? [{ name: 'active', label: 'Aktiv', type: 'checkbox' }] : []),
      ],
      onSave: async (v) => {
        if (existing) await patch(`/api/customers/${existing.id}`, v);
        else await post('/api/customers', v);
        toast('Kunden är sparad.', 'ok');
        await reload();
      },
    });
  }
  box = listSection(root, { title: 'Kunder', newLabel: '+ Ny kund', onNew: () => edit(null) });
  await reload();
}

// ── Projekt ─────────────────────────────────────────────────────────────
const BILLING = [
  { value: 'hourly', label: 'Löpande räkning' },
  { value: 'fixed', label: 'Fast pris' },
  { value: 'internal', label: 'Internt (ej debiterbart)' },
];
const billingLabel = Object.fromEntries(BILLING.map((b) => [b.value, b.label]));

async function projectsTab(root) {
  let box;
  let showClosed = false;

  async function reload() {
    const rows = (await get('/api/projects')).filter((p) => showClosed || p.status === 'active');
    setKids(box, 
      dataTable({
        rows,
        empty: 'Inga projekt. Skapa en kund först och sedan ett projekt.',
        rowClass: (p) => (p.status === 'active' ? '' : 'inactive'),
        columns: [
          { label: 'Nr', render: (p) => p.code, class: 'nowrap' },
          { label: 'Projekt', render: (p) => [p.name, p.status === 'closed' ? h('span', { class: 'chip' }, ' avslutat') : null] },
          { label: 'Kund', render: (p) => p.customer_name },
          { label: 'Projektledare', render: (p) => p.manager_name || '' },
          { label: 'Debitering', render: (p) => [billingLabel[p.billing_type], p.billing_type !== 'internal' && p.hourly_rate ? h('div', { class: 'small muted' }, `${fmtMoney(p.hourly_rate)}/tim`) : null] },
          { label: 'Team', num: true, render: (p) => (p.open_for_all ? 'Alla' : p.members) },
          { label: 'Timmar', num: true, render: (p) => fmtHours(p.minutes) || '0' },
          { label: '', class: 'actions', render: (p) => [actionBtn('Ändra', () => guarded(() => edit(p))), ' ', actionBtn('Team & aktiviteter', () => guarded(() => manage(p.id)))] },
        ],
      }),
    );
  }

  async function edit(existing) {
    const [customers, users] = await Promise.all([get('/api/customers'), get('/api/users')]);
    editDialog({
      title: existing ? `Ändra ${existing.code}` : 'Nytt projekt',
      wide: true,
      values: existing ? { ...existing, open_for_all: !!existing.open_for_all } : { status: 'active', billing_type: 'hourly', hourly_rate: 0 },
      fields: [
        { name: 'customer_id', label: 'Kund', type: 'select', options: optionList(customers.filter((c) => c.active || c.id === existing?.customer_id)), required: true },
        { name: 'code', label: 'Projektnummer', required: true, maxlength: 30 },
        { name: 'name', label: 'Projektnamn', required: true, maxlength: 150, full: true },
        { name: 'manager_id', label: 'Projektledare (attesterar tid)', type: 'select', options: optionList(users.filter((u) => u.active), { blank: '(ingen, chefen attesterar)' }) },
        { name: 'billing_type', label: 'Debitering', type: 'select', options: BILLING, hint: 'Fast pris fakturerar du separat. Timmarna räknas ändå in i TB med timpriset som värde.' },
        { name: 'hourly_rate', label: 'Timpris (kr/tim)', type: 'number', step: '1', min: '0' },
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Aktivt' }, { value: 'closed', label: 'Avslutat' }] },
        { name: 'start_date', label: 'Startdatum', type: 'date' },
        { name: 'end_date', label: 'Slutdatum', type: 'date' },
        { name: 'budget_hours', label: 'Budget (timmar)', type: 'number', step: '1', min: '0' },
        { name: 'budget_amount', label: 'Budget (kr)', type: 'number', step: '1', min: '0' },
        { name: 'open_for_all', label: 'Öppet för alla (kräver inget medlemskap)', type: 'checkbox', full: true },
        { name: 'notes', label: 'Anteckningar', type: 'textarea', maxlength: 2000, full: true },
      ],
      onSave: async (v) => {
        const body = { ...v, hourly_rate: v.hourly_rate ?? 0 };
        if (existing) await patch(`/api/projects/${existing.id}`, body);
        else await post('/api/projects', body);
        toast('Projektet är sparat.', 'ok');
        await reload();
      },
    });
  }

  async function manage(id) {
    const content = h('div', { class: 'stack' });
    const { dialog } = openDialog({ title: 'Team & aktiviteter', wide: true, content });
    dialog.addEventListener('close', () => reload(), { once: true });

    async function redraw() {
      const [project, users] = await Promise.all([get(`/api/projects/${id}`), get('/api/users')]);
      const memberIds = new Set(project.members.map((m) => m.user_id));
      const candidate = h('select', { id: 'new-member', 'aria-label': 'Ny medlem' }, h('option', { value: '' }, 'Välj person …'), users.filter((u) => u.active && !memberIds.has(u.id)).map((u) => h('option', { value: u.id }, personLabel(u))));
      const rate = h('input', { type: 'number', step: '1', min: '0', placeholder: 'Eget timpris (valfritt)', 'aria-label': 'Eget timpris' });

      setKids(content, 
        h('p', { class: 'muted' }, `${project.code} ${project.name} · ${project.customer_name}`),
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, 'Projektmedlemmar', project.open_for_all ? h('span', { class: 'chip accent' }, 'Projektet är öppet för alla') : null),
          dataTable({
            rows: project.members,
            empty: 'Inga medlemmar ännu.',
            columns: [
              { label: 'Person', render: (m) => [m.name, m.active ? null : h('span', { class: 'chip' }, ' inaktiv')] },
              { label: 'Eget timpris', num: true, render: (m) => (m.hourly_rate != null ? fmtMoney(m.hourly_rate) : h('span', { class: 'muted' }, 'projektets')) },
              {
                label: '',
                class: 'actions',
                render: (m) => [
                  actionBtn('Pris', () =>
                    editDialog({
                      title: `Timpris för ${m.name}`,
                      fields: [{ name: 'hourly_rate', label: 'Eget timpris (kr/tim)', type: 'number', step: '1', min: '0', hint: 'Lämna tomt för att använda aktivitetens eller projektets pris.', full: true }],
                      values: m,
                      onSave: async (v) => {
                        await put(`/api/projects/${id}/members/${m.user_id}`, { hourly_rate: v.hourly_rate });
                        await redraw();
                      },
                    }),
                  ),
                  ' ',
                  actionBtn('Ta bort', () => guarded(async () => { await del(`/api/projects/${id}/members/${m.user_id}`); await redraw(); }), 'danger'),
                ],
              },
            ],
          }),
          h('div', { class: 'sticky-actions' }, candidate, rate, h('button', { class: 'btn primary', type: 'button', onclick: () => guarded(async () => {
            if (!candidate.value) return;
            await put(`/api/projects/${id}/members/${candidate.value}`, { hourly_rate: rate.value === '' ? null : Number(rate.value) });
            await redraw();
          }) }, 'Lägg till')),
        ),
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, 'Aktiviteter', h('span', { class: 'spacer' }), actionBtn('+ Ny aktivitet', () => activity(null))),
          dataTable({
            rows: project.activities,
            columns: [
              { label: 'Aktivitet', render: (a) => [a.name, a.active ? null : h('span', { class: 'chip' }, ' inaktiv')] },
              { label: 'Debiterbar', render: (a) => (a.billable ? 'Ja' : 'Nej') },
              { label: 'Eget timpris', num: true, render: (a) => (a.hourly_rate != null ? fmtMoney(a.hourly_rate) : '') },
              { label: '', class: 'actions', render: (a) => actionBtn('Ändra', () => activity(a)) },
            ],
          }),
        ),
        h('p', { class: 'muted small' }, 'Prioritet för timpris: medlemmens eget pris, aktivitetens pris, projektets pris, personens standardpris.'),
      );

      function activity(existing) {
        editDialog({
          title: existing ? `Ändra ${existing.name}` : 'Ny aktivitet',
          values: existing ? { ...existing, billable: !!existing.billable, active: !!existing.active } : { billable: project.billing_type !== 'internal' },
          fields: [
            { name: 'name', label: 'Aktivitet', required: true, maxlength: 80, full: true },
            { name: 'billable', label: 'Debiterbar', type: 'checkbox' },
            ...(existing ? [{ name: 'active', label: 'Aktiv', type: 'checkbox' }] : []),
            { name: 'hourly_rate', label: 'Eget timpris (kr/tim)', type: 'number', step: '1', min: '0', full: true },
          ],
          onSave: async (v) => {
            if (existing) await patch(`/api/activities/${existing.id}`, v);
            else await post(`/api/projects/${id}/activities`, v);
            await redraw();
          },
        });
      }
    }
    await redraw();
  }

  const toggle = h('label', { class: 'small row' }, h('input', { type: 'checkbox', onchange: (e) => { showClosed = e.target.checked; reload(); } }), 'Visa avslutade');
  box = listSection(root, { title: 'Projekt', newLabel: '+ Nytt projekt', onNew: () => guarded(() => edit(null)) });
  box.before(toggle);
  await reload();
}

// ── Kategorier ──────────────────────────────────────────────────────────
async function categoriesTab(root) {
  let box;
  async function reload() {
    const rows = await get('/api/categories');
    setKids(box, 
      dataTable({
        rows,
        columns: [
          { label: 'Kategori', render: (c) => c.name },
          { label: 'Sortering', num: true, render: (c) => c.sort },
          { label: 'Användare', num: true, render: (c) => c.users },
          {
            label: '',
            class: 'actions',
            render: (c) => [
              actionBtn('Ändra', () => edit(c)),
              ' ',
              actionBtn('Ta bort', () => guarded(async () => {
                if (!(await confirmDialog(`Ta bort kategorin ${c.name}?`, { confirmLabel: 'Ta bort', danger: true }))) return;
                await del(`/api/categories/${c.id}`);
                await reload();
              }), 'danger'),
            ],
          },
        ],
      }),
    );
  }
  function edit(existing) {
    editDialog({
      title: existing ? `Ändra ${existing.name}` : 'Ny kategori',
      values: existing || { sort: 100 },
      fields: [
        { name: 'name', label: 'Namn', required: true, maxlength: 60 },
        { name: 'sort', label: 'Sortering', type: 'number', step: '1', min: '0' },
      ],
      onSave: async (v) => {
        const body = { name: v.name, sort: v.sort ?? 0 };
        if (existing) await patch(`/api/categories/${existing.id}`, body);
        else await post('/api/categories', body);
        await reload();
      },
    });
  }
  box = listSection(root, { title: 'Kategorier', intro: 'Grupperar användare i rapporter, till exempel AM, BM, konsult och OH.', newLabel: '+ Ny kategori', onNew: () => edit(null) });
  await reload();
}

// ── Provision ───────────────────────────────────────────────────────────
async function commissionTab(root) {
  let box;
  async function reload() {
    const rows = await get('/api/commission-links');
    setKids(box, 
      dataTable({
        rows,
        empty: 'Inga kopplingar. Lägg till vem som ska få provision på vems TB.',
        columns: [
          { label: 'Konsult (vars TB)', render: (r) => [r.source_name, ' ', h('span', { class: 'chip' }, r.source_category || '–')] },
          { label: 'Mottagare (får provision)', render: (r) => [r.earner_name, ' ', h('span', { class: 'chip' }, r.earner_category || '–')] },
          { label: 'Andel', num: true, render: (r) => `${fmtNum(r.percent)} %` },
          { label: 'Gäller', render: (r) => (r.valid_from || r.valid_to ? `${r.valid_from || '…'} – ${r.valid_to || '…'}` : 'Alltid') },
          { label: '', class: 'actions', render: (r) => [actionBtn('Ändra', () => guarded(() => edit(r))), ' ', actionBtn('Ta bort', () => guarded(async () => {
            if (!(await confirmDialog('Ta bort kopplingen?', { confirmLabel: 'Ta bort', danger: true }))) return;
            await del(`/api/commission-links/${r.id}`);
            await reload();
          }), 'danger')] },
        ],
      }),
    );
  }
  async function edit(existing) {
    const users = (await get('/api/users')).filter((u) => u.active || existing);
    const options = optionList(users, { label: personLabel });
    editDialog({
      title: existing ? 'Ändra koppling' : 'Ny koppling',
      values: existing || {},
      fields: [
        { name: 'source_id', label: 'Konsult (vars TB det gäller)', type: 'select', options, required: true, full: true },
        { name: 'earner_id', label: 'Mottagare (får provision)', type: 'select', options, required: true, full: true },
        { name: 'percent', label: 'Andel av TB (%)', type: 'number', step: '0.1', min: '0', max: '100', required: true },
        { name: 'valid_from', label: 'Gäller från', type: 'date', nullable: true },
        { name: 'valid_to', label: 'Gäller till', type: 'date', nullable: true },
      ],
      onSave: async (v) => {
        if (existing) await patch(`/api/commission-links/${existing.id}`, v);
        else await post('/api/commission-links', v);
        await reload();
      },
    });
  }
  box = listSection(root, {
    title: 'Provision på TB',
    intro: 'En konsult kan ha flera mottagare. Varje mottagare får en andel av konsultens TB under den period kopplingen gäller. Beräkningen syns under Rapporter.',
    newLabel: '+ Ny koppling',
    onNew: () => guarded(() => edit(null)),
  });
  await reload();
}

// ── Frånvaro ────────────────────────────────────────────────────────────
async function absenceTab(root) {
  let box;
  async function reload() {
    const rows = await get('/api/absence-types');
    setKids(box, 
      dataTable({
        rows,
        rowClass: (r) => (r.active ? '' : 'inactive'),
        columns: [
          { label: 'Frånvarotyp', render: (r) => [r.name, r.active ? null : h('span', { class: 'chip' }, ' inaktiv')] },
          { label: '', class: 'actions', render: (r) => actionBtn('Ändra', () => edit(r)) },
        ],
      }),
    );
  }
  function edit(existing) {
    editDialog({
      title: existing ? `Ändra ${existing.name}` : 'Ny frånvarotyp',
      values: existing ? { ...existing, active: !!existing.active } : {},
      fields: [{ name: 'name', label: 'Namn', required: true, maxlength: 60, full: true }, ...(existing ? [{ name: 'active', label: 'Aktiv', type: 'checkbox' }] : [])],
      onSave: async (v) => {
        if (existing) await patch(`/api/absence-types/${existing.id}`, v);
        else await post('/api/absence-types', v);
        await reload();
      },
    });
  }
  box = listSection(root, { title: 'Frånvarotyper', intro: 'Frånvaro rapporteras i veckovyn bredvid projekttid och räknas inte i TB.', newLabel: '+ Ny frånvarotyp', onNew: () => edit(null) });
  await reload();
}

// ── Inställningar ───────────────────────────────────────────────────────
async function settingsTab(root) {
  const s = await get('/api/settings');
  const error = h('div', { class: 'alert error hidden' });
  const fields = [
    { name: 'company_name', label: 'Företagsnamn', required: true, maxlength: 80, full: true },
    { name: 'locked_until', label: 'Perioden är låst till och med', type: 'date', nullable: true, hint: 'Användare kan inte ändra eller attestera tid, utlägg och resor till och med detta datum. Administratörer kan.', full: true },
    { name: 'mileage_rate', label: 'Milersättning (kr/km)', type: 'number', step: '0.01', min: '0', hint: 'Gäller nya resor. 2,50 kr/km motsvarar 25 kr/mil.' },
    {
      name: 'tb_cost_basis',
      label: 'Kostnad i TB',
      type: 'select',
      options: [
        { value: 'worked', label: 'All projekttid' },
        { value: 'billable', label: 'Bara debiterbara timmar' },
      ],
      hint: 'Avgör om ej debiterbar projekttid (utbildning, internt) belastar konsultens TB och därmed provisionen.',
    },
  ];
  const form = buildForm(fields, s);
  add(root, 
    h('h2', {}, 'Inställningar'),
    h(
      'div',
      { class: 'card' },
      error,
      form.el,
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () =>
          guarded(async () => {
            const v = form.read();
            state.settings = await patch('/api/settings', { ...v, mileage_rate: v.mileage_rate ?? 0 });
            toast('Inställningarna är sparade.', 'ok');
          }),
      }, 'Spara'),
    ),
  );
}

export async function renderAdmin(root, params) {
  const active = TABS.some((t) => t[0] === params[0]) ? params[0] : 'anvandare';
  add(root, 
    h('h1', {}, 'Administration'),
    h('div', { class: 'subnav' }, TABS.map(([id, label]) => h('a', { href: `#/admin/${id}`, 'aria-current': id === active ? 'page' : null }, label))),
  );
  const body = h('div', { class: 'stack' });
  add(root, body);
  await { anvandare: usersTab, kunder: customersTab, projekt: projectsTab, kategorier: categoriesTab, provision: commissionTab, franvaro: absenceTab, installningar: settingsTab }[active](body);
}
