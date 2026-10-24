import { get, post, patch, del } from '../api.js';
import { h, fmtDate, fmtMoney, fmtNum, toast, editDialog, confirmDialog, dataTable, statusChip, optionList, monthRange, localToday, add, setKids } from '../dom.js';
import { state } from '../state.js';

export async function renderMileage(root) {
  const filter = { ...monthRange(0) };
  const targets = await get('/api/my/targets');
  const projects = [...new Map(targets.activities.map((t) => [t.project_id, t])).values()];
  const projectOptions = optionList(projects, { value: (p) => p.project_id, label: (p) => `${p.customer_name} › ${p.code} ${p.project_name}`, blank: '(inget projekt)' });
  const box = h('div', { class: 'card flush' });

  async function load() {
    const rows = await get(`/api/mileage?${new URLSearchParams(filter)}`);
    setKids(box, 
      dataTable({
        rows,
        empty: 'Inga resor för perioden.',
        columns: [
          { label: 'Datum', render: (r) => fmtDate(r.date), class: 'nowrap' },
          { label: 'Resa', render: (r) => [r.purpose, ' ', r.billable ? h('span', { class: 'chip accent' }, 'Vidarefaktureras') : null, r.from_place || r.to_place ? h('div', { class: 'small muted' }, `${r.from_place} → ${r.to_place}`) : null] },
          { label: 'Projekt', render: (r) => (r.project_code ? `${r.project_code} ${r.project_name}` : '–') },
          { label: 'Km', num: true, render: (r) => fmtNum(r.km, 1) },
          { label: 'Ersättning', num: true, render: (r) => fmtMoney(r.amount) },
          { label: 'Status', render: (r) => [statusChip(r.status, r.reject_note), r.invoice_id ? h('span', { class: 'chip' }, ' Fakturerad') : null, r.reject_note ? h('div', { class: 'small neg' }, r.reject_note) : null] },
          {
            label: '',
            class: 'actions',
            render: (r) =>
              r.status === 'approved' || r.invoice_id
                ? ''
                : [
                    h('button', { class: 'btn sm', type: 'button', onclick: () => edit(r) }, 'Ändra'),
                    ' ',
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        type: 'button',
                        onclick: async () => {
                          if (!(await confirmDialog('Ta bort resan?', { confirmLabel: 'Ta bort', danger: true }))) return;
                          try {
                            await del(`/api/mileage/${r.id}`);
                            await load();
                          } catch (err) {
                            toast(err.message, 'error');
                          }
                        },
                      },
                      'Ta bort',
                    ),
                  ],
          },
        ],
        footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Km' ? fmtNum(rows.reduce((s, r) => s + r.km, 0), 1) : c.label === 'Ersättning' ? fmtMoney(rows.reduce((s, r) => s + r.amount, 0)) : ''),
      }),
    );
  }

  function edit(existing) {
    editDialog({
      title: existing ? 'Ändra resa' : 'Ny resa',
      saveLabel: existing ? 'Spara' : 'Skicka in',
      values: existing || { date: localToday() },
      fields: [
        { name: 'date', label: 'Datum', type: 'date', required: true },
        { name: 'project_id', label: 'Projekt', type: 'select', options: projectOptions },
        { name: 'from_place', label: 'Från', maxlength: 100 },
        { name: 'to_place', label: 'Till', maxlength: 100 },
        { name: 'purpose', label: 'Syfte', required: true, maxlength: 200, full: true },
        { name: 'km', label: 'Kilometer', type: 'number', step: '0.1', min: '0.1', required: true, hint: `Ersättning ${fmtNum(state.settings.mileage_rate)} kr/km` },
        { name: 'billable', label: 'Vidarefakturera till kunden', type: 'checkbox', full: true, hint: 'Kräver att du väljer ett projekt.' },
      ],
      onSave: async (v) => {
        if (existing) await patch(`/api/mileage/${existing.id}`, v);
        else await post('/api/mileage', v);
        toast('Resan är sparad.', 'ok');
        await load();
      },
    });
  }

  const from = h('input', { id: 'f-from', type: 'date', value: filter.from, onchange: (e) => (filter.from = e.target.value) });
  const to = h('input', { id: 'f-to', type: 'date', value: filter.to, onchange: (e) => (filter.to = e.target.value) });
  add(root, 
    h('div', { class: 'row between' }, h('h1', {}, 'Körjournal'), h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, '+ Ny resa')),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'f-from' }, 'Från'), from), h('div', { class: 'field' }, h('label', { for: 'f-to' }, 'Till'), to), h('button', { class: 'btn', type: 'button', onclick: () => load().catch((e) => toast(e.message, 'error')) }, 'Visa')),
    ),
    box,
  );
  await load();
}
