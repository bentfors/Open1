import { get, post, patch, del, qs } from '../api.js';
import { h, add, setKids, toast, dataTable, openDialog, confirmDialog, fmtSekExact, fmtDate } from '../dom.js';

const PAGE = 100;

// Förslag på regelmönster: första ordet/orden i texten utan siffror och tecken, till exempel "ICA MAXI".
function suggestPattern(description) {
  const words = description.toUpperCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
  return words.slice(0, 2).join(' ');
}

export async function renderTransactions(root, query) {
  const [accounts, categories] = await Promise.all([get('/api/accounts'), get('/api/categories')]);
  const f = { account_id: '', category_id: '', q: '', uncategorized: query.uncategorized === '1', from: '', to: '' };
  let items = [];
  let total = 0;
  let sum = 0;

  const select = (id, label, options, onchange) => {
    const el = h('select', { id, onchange: () => onchange(el.value) }, options.map((o) => h('option', { value: o.value }, o.label)));
    return [h('div', { class: 'field' }, h('label', { for: id }, label), el), el];
  };
  const [accField] = select('f-acc', 'Konto', [{ value: '', label: 'Alla' }, ...accounts.items.map((a) => ({ value: a.id, label: a.name }))], (v) => ((f.account_id = v), reload()));
  const [catField] = select('f-cat', 'Kategori', [{ value: '', label: 'Alla' }, ...categories.items.map((c) => ({ value: c.id, label: c.name }))], (v) => ((f.category_id = v), reload()));
  const search = h('input', { id: 'f-q', type: 'text', placeholder: 'Sök i texten', value: '' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => ((f.q = search.value), reload()), 250);
  });
  const unc = h('input', { id: 'f-unc', type: 'checkbox', checked: f.uncategorized, onchange: () => ((f.uncategorized = unc.checked), reload()) });
  const from = h('input', { id: 'f-from', type: 'date', onchange: () => ((f.from = from.value), reload()) });
  const to = h('input', { id: 'f-to', type: 'date', onchange: () => ((f.to = to.value), reload()) });

  const list = h('div');
  const summary = h('p', { class: 'muted' });
  const more = h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, 'Visa fler');

  setKids(
    root,
    h('h1', {}, 'Transaktioner'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, accField, catField, h('div', { class: 'field' }, h('label', { for: 'f-q' }, 'Sök'), search), h('div', { class: 'field' }, h('label', { for: 'f-from' }, 'Från'), from), h('div', { class: 'field' }, h('label', { for: 'f-to' }, 'Till'), to), h('div', { class: 'field check' }, h('label', { for: 'f-unc' }, unc, 'Bara okategoriserade'))), ),
    summary,
    list,
    h('div', { class: 'row mt-m' }, more),
  );

  function categoryOptions(current) {
    const groups = { income: 'Inkomst', expense: 'Utgift', transfer: 'Överföring (ingår inte i resultatet)' };
    const sel = h('select', { 'aria-label': 'Kategori' }, h('option', { value: '' }, '– okategoriserad –'));
    for (const [kind, label] of Object.entries(groups)) {
      const g = h('optgroup', { label });
      for (const c of categories.items.filter((x) => x.kind === kind)) g.append(h('option', { value: c.id, selected: c.id === current }, c.name));
      sel.append(g);
    }
    return sel;
  }

  async function setCategory(t, value, select) {
    const categoryId = value === '' ? null : Number(value);
    const hadNone = t.category_id === null;
    let pattern = '';
    if (categoryId && hadNone) {
      pattern = await askRule(t, categories.items.find((c) => c.id === categoryId).name);
      if (pattern === undefined) {
        select.value = t.category_id ?? '';
        return;
      }
    }
    const r = await patch(`/api/transactions/${t.id}`, { category_id: categoryId, rule_pattern: pattern || undefined });
    if (r.applied) toast(`Regeln satte kategori på ${r.applied} ${r.applied === 1 ? 'transaktion' : 'transaktioner'}.`, 'ok');
    reload();
  }

  // Returnerar mönstret, '' för "bara denna", undefined om användaren avbryter.
  function askRule(t, categoryName) {
    return new Promise((resolve) => {
      const input = h('input', { id: 'rule-pattern', type: 'text', value: suggestPattern(t.description), maxlength: 60 });
      const done = (v) => {
        opened.close();
        resolve(v);
      };
      const opened = openDialog({
        title: 'Samma kategori för liknande?',
        content: [
          h('p', {}, `"${t.description}" blir ${categoryName}. Vill du att alla transaktioner med den här texten (nuvarande och framtida importer) får samma kategori?`),
          h('div', { class: 'field' }, h('label', { for: 'rule-pattern' }, 'Texten ska innehålla ordet/orden'), input, h('div', { class: 'hint' }, 'Matchar hela ord, versaler spelar ingen roll.')),
        ],
        actions: [
          h('button', { class: 'btn', type: 'button', onclick: () => done('') }, 'Bara den här'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => done(input.value.trim()) }, 'Skapa regel'),
        ],
      });
      opened.dialog.addEventListener('close', () => resolve(undefined), { once: true });
    });
  }

  async function load(append) {
    const params = { ...f, uncategorized: f.uncategorized ? '1' : '', limit: PAGE, offset: append ? items.length : 0 };
    const r = await get(`/api/transactions${qs(params)}`);
    items = append ? [...items, ...r.items] : r.items;
    total = r.total;
    sum = r.sum;
    setKids(summary, `${total} transaktioner, summa `, h('strong', { class: sum < 0 ? 'neg' : '' }, fmtSekExact(sum)), '.');
    setKids(
      list,
      h(
        'div',
        { class: 'card flush' },
        dataTable({
          empty: f.q || f.account_id || f.category_id || f.uncategorized ? 'Inga transaktioner matchar filtret.' : 'Inga transaktioner än. Klistra in ett kontoutdrag under Konton.',
          rows: items,
          columns: [
            { label: 'Datum', class: 'nowrap', render: (t) => fmtDate(t.date) },
            { label: 'Text', render: (t) => t.description },
            { label: 'Konto', render: (t) => t.account },
            { label: 'Belopp', num: true, render: (t) => h('span', { class: t.amount < 0 ? 'neg' : 'pos' }, fmtSekExact(t.amount)) },
            {
              label: 'Kategori',
              render: (t) => {
                const sel = categoryOptions(t.category_id);
                sel.addEventListener('change', () => setCategory(t, sel.value, sel).catch((e) => toast(e.message, 'error')));
                return h('div', { class: 'row' }, sel, t.auto === 'transfer' ? h('span', { class: 'chip warn', title: 'Gissad överföring: samma belopp med motsatt tecken på ett annat av dina konton' }, 'gissad') : null);
              },
            },
            { label: '', class: 'actions', render: (t) => h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Ta bort transaktion', onclick: () => remove(t) }, 'Ta bort') },
          ],
        }),
      ),
    );
    more.classList.toggle('hidden', items.length >= total);
  }

  async function remove(t) {
    if (!(await confirmDialog(`Ta bort "${t.description}" (${fmtSekExact(t.amount)})?`, { danger: true, confirmLabel: 'Ta bort' }))) return;
    await del(`/api/transactions/${t.id}`);
    reload();
  }

  const reload = () => load(false).catch((e) => toast(e.message, 'error'));
  await load(false);
}
