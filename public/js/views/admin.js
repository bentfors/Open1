import { get, post, put, patch, del } from '../api.js';
import { h, add, setKids, fmtMoney, fmtNum, fmtHours, fmtDate, fmtSpan, fmtDaysLeft, toast, editDialog, confirmDialog, openDialog, dataTable, optionList, buildForm, localToday } from '../dom.js';
import { state, isAdmin } from '../state.js';
import { logTab } from './auditlog.js';

const TABS = [
  ['anvandare', 'Användare'],
  ['kunder', 'Kunder'],
  ['projekt', 'Projekt'],
  ['avtal', 'Avtal'],
  ['kategorier', 'Kategorier'],
  ['provision', 'Provision'],
  ['franvaro', 'Frånvaro'],
  ['installningar', 'Inställningar'],
  ['logg', 'Ändringslogg'],
];

// Ekonomi-superuser ser hela administrationen men ändrar bara användare. Övriga skrivknappar finns inte för hen,
// och servern nekar skrivningarna oavsett.
const canWrite = () => isAdmin();
// Superusern får inte röra administratörers konton. Roll och ekonomibehörighet är också bara administratörens.
const canEditUser = (u) => isAdmin() || u.role !== 'admin';

const personLabel = (u) => (u.category_name ? `${u.name} (${u.category_name})` : u.name);

// Gemensam ram för en listvy: rubrik, "Ny"-knapp och en tabell som kan laddas om.
function listSection(root, { title, intro, newLabel, onNew, canNew = canWrite() }) {
  const box = h('div', { class: 'card flush' });
  add(root, 
    h('div', { class: 'row between' }, h('div', {}, h('h2', {}, title), intro ? h('p', { class: 'muted' }, intro) : null), newLabel && canNew ? h('button', { class: 'btn primary', type: 'button', onclick: onNew }, newLabel) : null),
    box,
  );
  return box;
}

const actionBtn = (label, onclick, cls = '', allowed = canWrite()) => (allowed ? h('button', { class: `btn sm ${cls}`, type: 'button', onclick }, label) : null);

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
    const [{ users }, employments, assignments] = await Promise.all([refs(), get('/api/employments'), get('/api/assignments')]);
    const now = localToday();
    // Aktuell anställning: den som gäller idag, annars den senaste.
    const employmentOf = (id) => {
      const list = employments.filter((e) => e.user_id === id);
      return list.find((e) => e.start_date <= now && (!e.end_date || e.end_date >= now)) ?? list[0];
    };
    const assignmentsOf = (id) => assignments.filter((a) => a.user_id === id && (!a.end_date || a.end_date >= now)).sort((a, b) => a.start_date.localeCompare(b.start_date));
    setKids(box, 
      dataTable({
        rows: users,
        rowClass: (u) => (u.active ? '' : 'inactive'),
        columns: [
          { label: 'Namn', render: (u) => [u.name, u.active ? null : h('span', { class: 'chip', title: 'Inaktiv' }, ' inaktiv'), u.role === 'admin' ? h('span', { class: 'chip accent' }, ' admin') : null, u.finance && u.role !== 'admin' ? h('span', { class: 'chip accent', title: u.finance === 2 ? 'Ekonomi-superuser' : 'Ekonomiadministratör' }, u.finance === 2 ? ' ekonomi+' : ' ekonomi') : null] },
          { label: 'E-post', render: (u) => u.email },
          { label: 'Kategori', render: (u) => u.category_name || '' },
          { label: 'BM', render: (u) => u.bm_name || '' },
          { label: 'Chef', render: (u) => u.manager_name || '' },
          {
            label: 'Anställd',
            render: (u) => {
              const e = employmentOf(u.id);
              if (!e) return h('span', { class: 'muted' }, '–');
              return [`sedan ${e.start_date}`, h('div', { class: 'small muted' }, `${fmtSpan(e.start_date, e.end_date && e.end_date < now ? e.end_date : now)}${e.end_date ? ` · till ${e.end_date}` : ''}`)];
            },
          },
          {
            label: 'Uppdrag',
            render: (u) => {
              const list = assignmentsOf(u.id);
              if (!list.length) return h('span', { class: 'muted' }, '–');
              const a = list[0];
              const left = a.end_date ? fmtDaysLeft(Math.round((new Date(`${a.end_date}T00:00:00Z`) - new Date(`${now}T00:00:00Z`)) / 86400000)) : 'löpande';
              return [a.customer_name, h('div', { class: 'small muted' }, `${a.start_date > now ? `från ${a.start_date}` : left}${list.length > 1 ? ` · +${list.length - 1}` : ''}`)];
            },
          },
          { label: 'Timkostnad', num: true, render: (u) => fmtMoney(u.cost_rate) },
          { label: 'Std-pris', num: true, render: (u) => (u.default_bill_rate ? fmtMoney(u.default_bill_rate) : '') },
          { label: 'Tim/vecka', num: true, render: (u) => fmtNum(u.weekly_hours) },
          { label: '', class: 'actions', render: (u) => (canEditUser(u) ? [actionBtn('Ändra', () => edit(u), '', true), ' ', actionBtn('Lösenord', () => resetPassword(u), '', true)] : null) },
        ],
      }),
    );
  }

  async function edit(existing) {
    const { categories, users } = await refs();
    const fields = [
      { name: 'name', label: 'Namn', required: true, maxlength: 100 },
      { name: 'email', label: 'E-post', type: 'email', required: true },
      ...(isAdmin() ? [{ name: 'role', label: 'Roll', type: 'select', options: [{ value: 'user', label: 'Användare' }, { value: 'admin', label: 'Administratör' }] }] : []),
      { name: 'category_id', label: 'Kategori', type: 'select', options: optionList(categories, { blank: '(ingen)' }) },
      { name: 'bm_id', label: 'BM / konsultchef (attesterar allt som rapporteras)', type: 'select', options: optionList(users.filter((u) => (u.active || u.id === existing?.bm_id) && u.id !== existing?.id), { blank: '(ingen)', label: personLabel }), hint: 'Har användaren en BM är det bara BM som attesterar tid, utlägg och körningar. Utan BM attesterar projektledaren.' },
      { name: 'manager_id', label: 'Chef (attesterar när BM och projektledare saknas)', type: 'select', options: optionList(users.filter((u) => u.active && u.id !== existing?.id), { blank: '(ingen)', label: personLabel }) },
      { name: 'weekly_hours', label: 'Arbetstid per vecka (tim)', type: 'number', step: '0.5', min: '0', max: '80' },
      { name: 'cost_rate', label: 'Intern timkostnad (kr/tim)', type: 'number', step: '1', min: '0', hint: 'Används för TB. Syns bara för administratörer och ekonomi-superuser.' },
      { name: 'default_bill_rate', label: 'Standard timpris (kr/tim)', type: 'number', step: '1', min: '0', hint: 'Används när varken projekt, aktivitet eller medlem har eget pris.' },
      ...(isAdmin()
        ? [
            {
              name: 'finance',
              label: 'Ekonomibehörighet',
              type: 'select',
              options: [
                { value: 0, label: 'Ingen' },
                { value: 1, label: 'Ekonomi: skapar fakturaunderlag, ser upplupet och ekonomirapporter' },
                { value: 2, label: 'Ekonomi-superuser: dessutom avskriver, ångrar underlag och låser perioder' },
              ],
              full: true,
            },
          ]
        : []),
      ...(existing ? [{ name: 'active', label: 'Aktiv', type: 'checkbox' }] : [{ name: 'password', label: 'Tillfälligt lösenord', type: 'password', required: true, hint: 'Minst 10 tecken. Användaren måste byta vid första inloggning.', full: true }]),
    ];
    editDialog({
      title: existing ? `Ändra ${existing.name}` : 'Ny användare',
      fields,
      values: existing ? { ...existing, active: !!existing.active } : { role: 'user', weekly_hours: 40, cost_rate: 0, default_bill_rate: 0, finance: 0 },
      onSave: async (v) => {
        const body = { ...v, cost_rate: v.cost_rate ?? 0, default_bill_rate: v.default_bill_rate ?? 0, weekly_hours: v.weekly_hours ?? 40 };
        if (isAdmin()) body.finance = v.finance ?? 0;
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

  box = listSection(root, { title: 'Användare', intro: 'Konton, roller, kategorier och interna kostnader.', newLabel: '+ Ny användare', onNew: () => guarded(() => edit(null)), canNew: true });
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
          canWrite() ? h('div', { class: 'sticky-actions' }, candidate, rate, h('button', { class: 'btn primary', type: 'button', onclick: () => guarded(async () => {
            if (!candidate.value) return;
            await put(`/api/projects/${id}/members/${candidate.value}`, { hourly_rate: rate.value === '' ? null : Number(rate.value) });
            await redraw();
          }) }, 'Lägg till')) : null,
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
const RULE_KINDS = [
  { value: 'tb_percent', label: 'Procent av TB' },
  { value: 'per_consultant', label: 'Belopp per konsult i uppdrag' },
  { value: 'tb_tiered', label: 'Procent av TB, trappa på antal konsulter' },
];

function ruleSummary(r) {
  const who = r.sources.map((x) => x.name).join(', ');
  const cats = r.categories.length ? ` (${r.categories.map((c) => c.name).join(', ')})` : '';
  const hrs = r.min_hours ? `, minst ${fmtNum(r.min_hours)} h` : '';
  if (r.kind === 'tb_percent') return `${fmtNum(r.percent)} % av TB för ${who}`;
  if (r.kind === 'per_consultant') return `${fmtMoney(r.amount)} per konsult i uppdrag${cats}${hrs}`;
  return `${r.tiers.map((t) => `från ${t.min}: ${fmtNum(t.percent)} %`).join(' · ')} av TB för ${who}. Konsulter${cats}${hrs}`;
}

function checkList(items, selected, title, hint) {
  const boxes = items.map((i) => ({ id: i.id, input: h('input', { type: 'checkbox', checked: selected.has(i.id) }) }));
  const el = h(
    'div',
    { class: 'field' },
    h('label', {}, title),
    h('div', { class: 'checklist' }, boxes.map((b, idx) => h('label', {}, b.input, items[idx].label))),
    hint ? h('div', { class: 'hint' }, hint) : null,
  );
  return { el, read: () => boxes.filter((b) => b.input.checked).map((b) => b.id) };
}

function tierEditor(initial) {
  const rows = h('div');
  const list = [];
  function addRow(t) {
    const min = h('input', { type: 'number', min: '0', step: '1', value: t.min, 'aria-label': 'Från antal konsulter' });
    const pct = h('input', { type: 'number', min: '0', max: '100', step: '0.1', value: t.percent, 'aria-label': 'Procent' });
    const item = { min, pct };
    const row = h('div', { class: 'tier-row' }, min, pct, h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Ta bort steg', onclick: () => { row.remove(); list.splice(list.indexOf(item), 1); } }, '✕'));
    list.push(item);
    add(rows, row);
  }
  for (const t of initial?.length ? initial : [{ min: 0, percent: '' }]) addRow(t);
  const el = h(
    'div',
    { class: 'field' },
    h('label', {}, 'Trappa'),
    h('div', { class: 'tier-row small muted' }, h('span', {}, 'Från antal konsulter'), h('span', {}, 'Procent av TB')),
    rows,
    h('button', { class: 'btn sm', type: 'button', onclick: () => addRow({ min: '', percent: '' }) }, '+ Lägg till steg'),
    h('div', { class: 'hint' }, 'Det steg som motsvarar antalet konsulter gäller för hela TB:n. Första steget ska börja på 0.'),
  );
  return { el, read: () => list.map((x) => ({ min: Number(x.min.value), percent: Number(x.pct.value) })) };
}

async function commissionTab(root) {
  let box;
  async function reload() {
    const rows = await get('/api/commission-rules');
    setKids(
      box,
      dataTable({
        rows,
        empty: 'Inga regler. Lägg till vem som ska få provision och hur den räknas.',
        columns: [
          { label: 'Mottagare', render: (r) => [r.earner_name, ' ', h('span', { class: 'chip' }, r.earner_category || '–')] },
          { label: 'Regel', render: (r) => [r.name || RULE_KINDS.find((k) => k.value === r.kind).label, h('div', { class: 'small muted' }, ruleSummary(r))] },
          { label: 'Period', render: (r) => (r.period === 'quarter' ? 'Kvartal' : 'Månad') },
          { label: 'Gäller', render: (r) => (r.valid_from || r.valid_to ? `${r.valid_from || '…'} – ${r.valid_to || '…'}` : 'Alltid'), class: 'nowrap' },
          {
            label: '',
            class: 'actions',
            render: (r) => [
              actionBtn('Ändra', () => guarded(() => edit(r))),
              ' ',
              actionBtn('Ta bort', () => guarded(async () => {
                if (!(await confirmDialog('Ta bort regeln?', { confirmLabel: 'Ta bort', danger: true }))) return;
                await del(`/api/commission-rules/${r.id}`);
                await reload();
              }), 'danger'),
            ],
          },
        ],
      }),
    );
  }

  async function edit(existing) {
    const [users, categories] = await Promise.all([get('/api/users'), get('/api/categories')]);
    const people = users.filter((u) => u.active || existing?.sources.some((s) => s.id === u.id) || existing?.earner_id === u.id);
    const v = existing ? { ...existing } : { kind: 'tb_percent', period: 'month', min_hours: 0 };

    const main = buildForm(
      [
        { name: 'earner_id', label: 'Mottagare (får provisionen)', type: 'select', options: optionList(people, { label: personLabel }), required: true, full: true },
        { name: 'name', label: 'Namn (valfritt)', maxlength: 100, full: true },
        { name: 'kind', label: 'Typ', type: 'select', options: RULE_KINDS, full: true },
        { name: 'period', label: 'Räknas per', type: 'select', options: [{ value: 'month', label: 'Månad' }, { value: 'quarter', label: 'Kvartal' }] },
      ],
      v,
    );
    const pct = buildForm([{ name: 'percent', label: 'Andel av TB (%)', type: 'number', step: '0.1', min: '0', max: '100', required: true }], v);
    const amt = buildForm([{ name: 'amount', label: 'Belopp per konsult och månad (kr)', type: 'number', step: '1', min: '0', required: true }], v);
    const minh = buildForm([{ name: 'min_hours', label: 'Minsta antal debiterbara timmar per månad', type: 'number', step: '1', min: '0', hint: 'En konsult räknas som i uppdrag en månad med mer än så här många godkända debiterbara timmar. 0 betyder minst en minut.' }], v);
    const dates = buildForm([{ name: 'valid_from', label: 'Gäller från', type: 'date', nullable: true }, { name: 'valid_to', label: 'Gäller till', type: 'date', nullable: true }], v);
    const sources = checkList(people.map((u) => ({ id: u.id, label: personLabel(u) })), new Set((existing?.sources || []).map((x) => x.id)), 'Konsulter vars TB provisionen räknas på');
    const cats = checkList(categories.map((c) => ({ id: c.id, label: c.name })), new Set((existing?.categories || []).map((x) => x.id)), 'Vilka kategorier räknas som konsulter?', 'Lämna alla omarkerade för att räkna alla.');
    const tiers = tierEditor(existing?.tiers);

    const sections = {
      pct: pct.el,
      amt: amt.el,
      tiers: tiers.el,
      sources: sources.el,
      minh: minh.el,
      cats: cats.el,
      dates: dates.el,
    };
    const visible = {
      tb_percent: ['pct', 'sources', 'dates'],
      per_consultant: ['amt', 'minh', 'cats', 'dates'],
      tb_tiered: ['tiers', 'sources', 'minh', 'cats', 'dates'],
    };
    const kindSelect = main.inputs.get('kind').input;
    const apply = () => {
      for (const [name, el] of Object.entries(sections)) el.classList.toggle('hidden', !visible[kindSelect.value].includes(name));
    };
    kindSelect.addEventListener('change', apply);

    const error = h('div', { class: 'alert error hidden' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Spara');
    const { close } = openDialog({
      title: existing ? 'Ändra provisionsregel' : 'Ny provisionsregel',
      wide: true,
      content: [error, main.el, ...Object.values(sections)],
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Avbryt'), save],
    });
    apply();

    save.addEventListener('click', async () => {
      error.classList.add('hidden');
      const body = { ...main.read(), ...dates.read(), min_hours: minh.read().min_hours ?? 0 };
      if (body.kind === 'tb_percent') Object.assign(body, pct.read());
      if (body.kind === 'per_consultant') Object.assign(body, amt.read());
      if (body.kind === 'tb_tiered') body.tiers = tiers.read();
      body.source_ids = body.kind === 'per_consultant' ? [] : sources.read();
      body.category_ids = body.kind === 'tb_percent' ? [] : cats.read();
      save.disabled = true;
      try {
        if (existing) await patch(`/api/commission-rules/${existing.id}`, body);
        else await post('/api/commission-rules', body);
        close();
        toast('Regeln är sparad.', 'ok');
        await reload();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      } finally {
        save.disabled = false;
      }
    });
  }

  box = listSection(root, {
    title: 'Provisionsregler',
    intro: 'Varje regel gäller en mottagare och räknas per månad eller kvartal, bara på attesterad tid. En konsult kan bidra med negativ TB, men provisionen per regel och period blir aldrig lägre än 0. Utfallet syns under Rapporter → TB och provision.',
    newLabel: '+ Ny regel',
    onNew: () => guarded(() => edit(null)),
  });
  await reload();
}

// ── Avtal ───────────────────────────────────────────────────────────────
const EMPLOYMENT_TYPES = [
  { value: 'permanent', label: 'Tillsvidare' },
  { value: 'fixed_term', label: 'Visstid' },
  { value: 'probation', label: 'Provanställning' },
];
const typeLabel = Object.fromEntries(EMPLOYMENT_TYPES.map((t) => [t.value, t.label]));
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function contractsTab(root) {
  const now = localToday();
  let showEnded = false;
  const warnBox = h('div');
  const assignBox = h('div', { class: 'card flush' });
  const empBox = h('div', { class: 'card flush' });

  const period = (x) => `${x.start_date} – ${x.end_date ?? 'löpande'}`;
  const length = (x) => (x.start_date > now ? `startar om ${fmtSpan(now, x.start_date)}` : fmtSpan(x.start_date, x.end_date && x.end_date < now ? x.end_date : now));
  const left = (x) => (x.end_date ? fmtDaysLeft(dayDiff(now, x.end_date)) : 'löpande');
  const isOver = (x) => x.end_date && x.end_date < now;

  async function reload() {
    const [assignments, employments, warnings] = await Promise.all([get('/api/assignments'), get('/api/employments'), get('/api/contracts/warnings')]);
    setKids(warnBox, warnings.length ? h('div', { class: 'alert warn' }, 'Att se över:', h('ul', { class: 'warn-list' }, warnings.map((w) => h('li', {}, w.text)))) : null);

    setKids(
      assignBox,
      h('div', { class: 'group-head' }, 'Uppdrag', h('span', { class: 'spacer' }), actionBtn('+ Nytt uppdrag', () => guarded(() => editAssignment(null)))),
      dataTable({
        rows: assignments.filter((a) => showEnded || !isOver(a)),
        empty: 'Inga uppdrag registrerade. Lägg till dem så kan prognoserna räkna.',
        rowClass: (a) => (isOver(a) ? 'inactive' : ''),
        columns: [
          { label: 'Konsult', render: (a) => a.user_name },
          { label: 'Kund', render: (a) => [a.customer_name, a.project_code || a.title ? h('div', { class: 'small muted' }, [a.project_code, a.title].filter(Boolean).join(' · ')) : null] },
          { label: 'Period', render: (a) => period(a), class: 'nowrap' },
          { label: 'Längd', render: (a) => length(a), class: 'nowrap' },
          { label: 'Kvar', render: (a) => left(a), class: 'nowrap' },
          { label: 'Timpris', num: true, render: (a) => fmtMoney(a.hourly_rate) },
          { label: 'Tim/vecka', num: true, render: (a) => fmtNum(a.hours_per_week) },
          { label: '', class: 'actions', render: (a) => [actionBtn('Ändra', () => guarded(() => editAssignment(a))), ' ', actionBtn('Ta bort', () => remove('assignments', a.id, `uppdraget för ${a.user_name}`), 'danger')] },
        ],
      }),
    );

    setKids(
      empBox,
      h('div', { class: 'group-head' }, 'Anställningar', h('span', { class: 'spacer' }), actionBtn('+ Ny anställning', () => guarded(() => editEmployment(null)))),
      dataTable({
        rows: employments.filter((e) => showEnded || !isOver(e)),
        empty: 'Inga anställningar registrerade. Personer utan anställningsavtal antas vara anställda tillsvidare i prognoserna.',
        rowClass: (e) => (isOver(e) ? 'inactive' : ''),
        columns: [
          { label: 'Person', render: (e) => e.user_name },
          { label: 'Typ', render: (e) => typeLabel[e.type] },
          { label: 'Period', render: (e) => period(e), class: 'nowrap' },
          { label: 'Anställd i', render: (e) => length(e), class: 'nowrap' },
          { label: 'Kvar', render: (e) => left(e), class: 'nowrap' },
          { label: 'Uppsägning', num: true, render: (e) => (e.notice_months ? `${e.notice_months} mån` : '') },
          { label: '', class: 'actions', render: (e) => [actionBtn('Ändra', () => guarded(() => editEmployment(e))), ' ', actionBtn('Ta bort', () => remove('employments', e.id, `anställningen för ${e.user_name}`), 'danger')] },
        ],
      }),
    );
  }

  async function remove(kind, id, what) {
    await guarded(async () => {
      if (!(await confirmDialog(`Ta bort ${what}?`, { confirmLabel: 'Ta bort', danger: true }))) return;
      await del(`/api/${kind}/${id}`);
      await reload();
    });
  }

  async function editAssignment(existing) {
    const [users, customers, projects] = await Promise.all([get('/api/users'), get('/api/customers'), get('/api/projects')]);
    editDialog({
      title: existing ? 'Ändra uppdrag' : 'Nytt uppdrag',
      wide: true,
      values: existing ?? { hours_per_week: 40 },
      fields: [
        { name: 'user_id', label: 'Konsult', type: 'select', options: optionList(users.filter((u) => u.active || u.id === existing?.user_id), { label: personLabel }), required: true },
        { name: 'customer_id', label: 'Kund', type: 'select', options: optionList(customers.filter((c) => c.active || c.id === existing?.customer_id)), required: true },
        { name: 'project_id', label: 'Projekt (valfritt)', type: 'select', options: optionList(projects.filter((p) => p.status === 'active' || p.id === existing?.project_id), { label: (p) => `${p.customer_name} › ${p.code} ${p.name}`, blank: '(inget)' }), full: true },
        { name: 'title', label: 'Roll eller benämning', maxlength: 150, full: true },
        { name: 'start_date', label: 'Startdatum', type: 'date', required: true },
        { name: 'end_date', label: 'Slutdatum (tomt = löpande)', type: 'date', nullable: true },
        { name: 'hourly_rate', label: 'Timpris (kr/tim)', type: 'number', step: '1', min: '0', required: true },
        { name: 'hours_per_week', label: 'Timmar per vecka', type: 'number', step: '0.5', min: '0.5', max: '80', required: true, hint: 'Samtidiga uppdrag får tillsammans inte överstiga personens arbetstid.' },
        { name: 'notes', label: 'Anteckningar', type: 'textarea', maxlength: 1000, full: true },
      ],
      onSave: async (v) => {
        if (existing) await patch(`/api/assignments/${existing.id}`, v);
        else await post('/api/assignments', v);
        toast('Uppdraget är sparat.', 'ok');
        await reload();
      },
    });
  }

  async function editEmployment(existing) {
    const users = await get('/api/users');
    editDialog({
      title: existing ? 'Ändra anställning' : 'Ny anställning',
      values: existing ?? { type: 'permanent', notice_months: 3 },
      fields: [
        { name: 'user_id', label: 'Person', type: 'select', options: optionList(users.filter((u) => u.active || u.id === existing?.user_id), { label: personLabel }), required: true, full: true },
        { name: 'type', label: 'Typ', type: 'select', options: EMPLOYMENT_TYPES },
        { name: 'notice_months', label: 'Uppsägningstid (månader)', type: 'number', step: '1', min: '0', max: '24' },
        { name: 'start_date', label: 'Startdatum', type: 'date', required: true },
        { name: 'end_date', label: 'Slutdatum (tomt = tillsvidare)', type: 'date', nullable: true, hint: 'Visstidsanställningar måste ha slutdatum.' },
        { name: 'notes', label: 'Anteckningar', type: 'textarea', maxlength: 1000, full: true },
      ],
      onSave: async (v) => {
        const body = { ...v, notice_months: v.notice_months ?? 0 };
        if (existing) await patch(`/api/employments/${existing.id}`, body);
        else await post('/api/employments', body);
        toast('Anställningen är sparad.', 'ok');
        await reload();
      },
    });
  }

  add(
    root,
    h('div', { class: 'row between' }, h('div', {}, h('h2', {}, 'Avtal'), h('p', { class: 'muted' }, 'Anställningar och uppdrag. Underlag för prognoserna under Statistik.')), h('label', { class: 'small row' }, h('input', { type: 'checkbox', onchange: (e) => { showEnded = e.target.checked; reload(); } }), 'Visa avslutade')),
    warnBox,
    assignBox,
    empBox,
  );
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
    {
      name: 'bench_cap_hours',
      label: 'Odebiterbar tid räknas som negativ i högst (timmar)',
      type: 'number',
      step: '1',
      min: '0',
      nullable: true,
      hint: 'En konsult utan debiterbar tid belastar provisionsunderlaget bara de första så här många timmarna i sträck. Därefter räknas 0 tills hen har debiterbar tid igen. Lämna tomt för ingen gräns.',
      full: true,
    },
    {
      name: 'forecast_utilization',
      label: 'Beläggning i prognoser (%)',
      type: 'number',
      step: '1',
      min: '1',
      max: '100',
      required: true,
      hint: 'Andel av arbetsdagarna som räknas som arbetade, efter semester, sjukdom och helgdagar. Röda dagar räknas inte av var för sig.',
    },
  ];
  const form = buildForm(fields, s);
  if (!canWrite()) for (const el of form.el.querySelectorAll('input, select, textarea')) el.disabled = true;
  add(root, 
    h('h2', {}, 'Inställningar'),
    h(
      'div',
      { class: 'card' },
      error,
      form.el,
      canWrite() ? h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () =>
          guarded(async () => {
            const v = form.read();
            state.settings = await patch('/api/settings', { ...v, mileage_rate: v.mileage_rate ?? 0 });
            toast('Inställningarna är sparade.', 'ok');
          }),
      }, 'Spara') : null,
    ),
  );
}

export async function renderAdmin(root, params) {
  const active = TABS.some((t) => t[0] === params[0]) ? params[0] : 'anvandare';
  add(root, 
    h('h1', {}, 'Administration'),
    canWrite() ? null : h('p', { class: 'muted' }, 'Som ekonomi-superuser hanterar du användare, men inte administratörer, roller eller ekonomibehörighet. Resten av administrationen har du läsrätt till.'),
    h('div', { class: 'subnav' }, TABS.map(([id, label]) => h('a', { href: `#/admin/${id}`, 'aria-current': id === active ? 'page' : null }, label))),
  );
  const body = h('div', { class: 'stack' });
  add(root, body);
  await { anvandare: usersTab, kunder: customersTab, projekt: projectsTab, avtal: contractsTab, kategorier: categoriesTab, provision: commissionTab, franvaro: absenceTab, installningar: settingsTab, logg: logTab }[active](body);
}
