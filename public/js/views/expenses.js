import { get, post, patch, del } from '../api.js';
import { h, fmtDate, fmtMoney, toast, editDialog, confirmDialog, dataTable, statusChip, optionList, monthRange, localToday, add, setKids } from '../dom.js';

const MAX_BYTES = 5 * 1024 * 1024;

function readFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_BYTES) return reject(new Error('Kvittot är för stort (högst 5 MB).'));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('Kunde inte läsa filen.'));
    reader.readAsDataURL(file);
  });
}

export async function renderExpenses(root) {
  const range = monthRange(0);
  const filter = { ...range };
  const targets = await get('/api/my/targets');
  const projects = [...new Map(targets.activities.map((t) => [t.project_id, t])).values()];
  const projectOptions = optionList(projects, { value: (p) => p.project_id, label: (p) => `${p.customer_name} › ${p.code} ${p.project_name}`, blank: '(inget projekt)' });
  const box = h('div', { class: 'card flush' });

  async function load() {
    const q = new URLSearchParams(filter);
    const rows = await get(`/api/expenses?${q}`);
    setKids(box, 
      dataTable({
        rows,
        empty: 'Inga utlägg för perioden.',
        columns: [
          { label: 'Datum', render: (r) => fmtDate(r.date), class: 'nowrap' },
          { label: 'Beskrivning', render: (r) => [r.description, ' ', r.billable ? h('span', { class: 'chip accent' }, 'Vidarefaktureras') : null] },
          { label: 'Projekt', render: (r) => (r.project_code ? `${r.project_code} ${r.project_name}` : '–') },
          { label: 'Belopp', num: true, render: (r) => fmtMoney(r.amount) },
          { label: 'Moms', num: true, render: (r) => (r.vat ? fmtMoney(r.vat) : '') },
          { label: 'Kvitto', render: (r) => (r.has_receipt ? h('a', { href: `/api/expenses/${r.id}/receipt`, target: '_blank', rel: 'noopener' }, 'Visa') : '') },
          { label: 'Status', render: (r) => [statusChip(r.status, r.reject_note), r.invoice_id ? h('span', { class: 'chip', title: 'Fakturerad' }, ' Fakturerad') : null, r.reject_note ? h('div', { class: 'small neg' }, r.reject_note) : null] },
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
                          if (!(await confirmDialog('Ta bort utlägget?', { confirmLabel: 'Ta bort', danger: true }))) return;
                          try {
                            await del(`/api/expenses/${r.id}`);
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
        footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Belopp' ? fmtMoney(rows.reduce((s, r) => s + r.amount, 0)) : ''),
      }),
    );
  }

  function edit(existing) {
    const fileInput = h('input', { id: 'f-receipt', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf' });
    editDialog({
      title: existing ? 'Ändra utlägg' : 'Nytt utlägg',
      saveLabel: existing ? 'Spara' : 'Skicka in',
      values: existing ? { ...existing, project_id: existing.project_id } : { date: localToday(), vat: 0 },
      fields: [
        { name: 'date', label: 'Datum', type: 'date', required: true },
        { name: 'project_id', label: 'Projekt', type: 'select', options: projectOptions },
        { name: 'description', label: 'Beskrivning', required: true, maxlength: 200, full: true },
        { name: 'amount', label: 'Belopp inkl. moms (kr)', type: 'number', step: '0.01', min: '0.01', required: true },
        { name: 'vat', label: 'varav moms (kr)', type: 'number', step: '0.01', min: '0' },
        { name: 'billable', label: 'Vidarefakturera till kunden', type: 'checkbox', full: true, hint: 'Kräver att du väljer ett projekt.' },
      ],
      extra: h('div', { class: 'field' }, h('label', { for: 'f-receipt' }, 'Kvitto (bild eller PDF, högst 5 MB)'), fileInput, existing?.has_receipt ? h('div', { class: 'hint' }, 'Ett kvitto finns redan. Välj en fil för att ersätta det.') : null),
      onSave: async (v) => {
        const body = { ...v, vat: v.vat ?? 0 };
        if (fileInput.files[0]) body.receipt = await readFile(fileInput.files[0]);
        if (existing) await patch(`/api/expenses/${existing.id}`, body);
        else await post('/api/expenses', body);
        toast('Utlägget är sparat.', 'ok');
        await load();
      },
    });
  }

  const from = h('input', { id: 'f-from', type: 'date', value: filter.from, onchange: (e) => (filter.from = e.target.value) });
  const to = h('input', { id: 'f-to', type: 'date', value: filter.to, onchange: (e) => (filter.to = e.target.value) });
  add(root, 
    h('div', { class: 'row between' }, h('h1', {}, 'Utlägg'), h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, '+ Nytt utlägg')),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'f-from' }, 'Från'), from), h('div', { class: 'field' }, h('label', { for: 'f-to' }, 'Till'), to), h('button', { class: 'btn', type: 'button', onclick: () => load().catch((e) => toast(e.message, 'error')) }, 'Visa')),
    ),
    box,
  );
  await load();
}
