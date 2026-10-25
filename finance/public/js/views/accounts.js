import { get, post, patch, del } from '../api.js';
import { h, add, setKids, toast, dataTable, editDialog, confirmDialog, openDialog, fmtSek, fmtSekExact, fmtDate, parseKr } from '../dom.js';

const LIABILITY = new Set(['loan', 'credit']);

export async function renderAccounts(root) {
  const mount = h('div');
  let kinds = {};
  setKids(root, h('div', { class: 'row between' }, h('h1', {}, 'Konton'), h('button', { class: 'btn primary', type: 'button', onclick: () => accountDialog(null, load, kinds) }, 'Nytt konto')), mount);
  async function load() {
    const data = await get('/api/accounts');
    kinds = data.kinds;
        setKids(
      mount,
      h('p', { class: 'muted' }, 'Lägg upp varje konto du vill ha med: lönekonto, sparkonto, ISK, lån. Klistra sedan in kontoutdrag per konto så byggs resultatrapporten.'),
      h(
        'div',
        { class: 'card flush' },
        dataTable({
          empty: 'Du har inga konton än. Börja med ditt lönekonto.',
          rows: data.items,
          columns: [
            { label: 'Konto', render: (a) => a.name },
            { label: 'Typ', render: (a) => kinds[a.kind] },
            { label: 'Saldo', num: true, render: (a) => h('span', { class: a.balance < 0 ? 'neg' : '' }, fmtSekExact(a.balance)) },
            { label: 'Transaktioner', num: true, render: (a) => a.tx_count },
            { label: 'Senast', render: (a) => (a.last_tx ? fmtDate(a.last_tx) : '') },
            {
              label: '',
              class: 'actions',
              render: (a) =>
                h(
                  'div',
                  { class: 'row' },
                  h('button', { class: 'btn sm primary', type: 'button', onclick: () => importDialog(a, load) }, 'Klistra in kontoutdrag'),
                  h('button', { class: 'btn sm', type: 'button', onclick: () => accountDialog(a, load, kinds) }, 'Ändra'),
                  h('button', { class: 'btn sm danger', type: 'button', onclick: () => remove(a) }, 'Ta bort'),
                ),
            },
          ],
        }),
      ),
      h('p', { class: 'muted small' }, 'Saldot är det du har idag. Ändrar du det räknas ingångsvärdet om så att saldot stämmer med importerade transaktioner. Skulder (lån, kreditkort) anges som positivt belopp du är skyldig.'),
    );
  }

  async function remove(a) {
    if (!(await confirmDialog(`Ta bort ${a.name} och alla ${a.tx_count} transaktioner på kontot? Det går inte att ångra.`, { danger: true, confirmLabel: 'Ta bort' }))) return;
    await del(`/api/accounts/${a.id}`);
    toast('Kontot är borttaget.', 'ok');
    load();
  }

  await load();
}

function accountDialog(account, onDone, kinds) {
  const kindOptions = Object.entries(kinds).map(([value, label]) => ({ value, label }));
  editDialog({
    title: account ? 'Ändra konto' : 'Nytt konto',
    fields: [
      { name: 'name', label: 'Namn', required: true, maxlength: 80, full: true },
      { name: 'kind', label: 'Typ', type: 'select', options: kindOptions },
      { name: 'balance', label: 'Saldo idag (kr)', hint: 'För lån och kreditkort: skulden som positivt belopp.', skip: false },
    ],
    values: account ? { name: account.name, kind: account.kind, balance: String(Math.abs(account.balance) / 100).replace('.', ',') } : { kind: 'checking', balance: '0' },
    onSave: async (v) => {
      const kr = parseKr(v.balance);
      if (kr === null || Number.isNaN(kr)) throw new Error('Saldot måste vara ett belopp, till exempel 12 345,50.');
      const signed = LIABILITY.has(v.kind) ? -Math.abs(kr) : kr;
      const body = { name: v.name, kind: v.kind, balance: signed };
      if (account) await patch(`/api/accounts/${account.id}`, body);
      else await post('/api/accounts', body);
      toast('Sparat.', 'ok');
      onDone();
    },
  });
}

const ROLES = [
  ['date', 'Datum'],
  ['description', 'Text'],
  ['amount', 'Belopp'],
  ['balance', 'Saldo (valfritt)'],
];

function importDialog(account, onDone) {
  const text = h('textarea', { id: 'stmt', rows: 10, placeholder: 'Klistra in raderna från ditt kontoutdrag här. Funkar med tabb- och semikolonseparerat från de flesta banker.', spellcheck: false });
  const result = h('div');
  const error = h('div', { class: 'alert error hidden' });
  let mapping = null;
  let dialog;

  const body = () => ({ account_id: account.id, text: text.value, ...(mapping ? { mapping } : {}) });

  async function preview() {
    error.classList.add('hidden');
    if (!text.value.trim()) return;
    try {
      const r = await post('/api/import/preview', body());
      mapping = r.mapping;
      draw(r);
    } catch (e) {
      error.textContent = e.message;
      error.classList.remove('hidden');
    }
  }

  function mappingSelect(role, label, r) {
    const options = [h('option', { value: '' }, '(ingen)'), ...Array.from({ length: r.columns }, (_, i) => h('option', { value: String(i), selected: r.mapping[role] === i }, `Kolumn ${i + 1}${r.preview[0]?.[i] ? `: ${r.preview[0][i].slice(0, 18)}` : ''}`))];
    const sel = h('select', { id: `map-${role}`, onchange: () => ((mapping = { ...mapping, [role]: sel.value === '' ? null : Number(sel.value) }), preview()) }, options);
    return h('div', { class: 'field' }, h('label', { for: `map-${role}` }, label), sel);
  }

  function draw(r) {
    const ok = r.rows.length && r.mapping.date !== null && r.mapping.amount !== null;
    setKids(
      result,
      h('div', { class: 'section-title' }, 'Kontrollera tolkningen'),
      h('div', { class: 'filters' }, ROLES.map(([role, label]) => mappingSelect(role, label, r))),
      r.skipped_count ? h('div', { class: 'alert warn' }, `${r.skipped_count} rader gick inte att tolka och hoppas över (rubriker och summarader är normalt). Första: "${r.skipped[0].text}" – ${r.skipped[0].reason}.`) : null,
      ok
        ? [
            h('p', {}, `${r.count} rader, ${r.range.from} till ${r.range.to}. `, h('strong', {}, `${r.new_count} nya`), r.count - r.new_count ? `, ${r.count - r.new_count} finns redan och hoppas över.` : '.'),
            dataTable({
              rows: r.rows.slice(0, 12),
              columns: [
                { label: 'Datum', render: (x) => x.date },
                { label: 'Text', render: (x) => x.description },
                { label: 'Belopp', num: true, render: (x) => h('span', { class: x.amount < 0 ? 'neg' : 'pos' }, fmtSekExact(x.amount)) },
                { label: 'Kategori', render: (x) => x.category || h('span', { class: 'muted' }, 'okänd') },
                { label: '', render: (x) => (x.duplicate ? h('span', { class: 'chip' }, 'finns redan') : '') },
              ],
            }),
            r.count > 12 ? h('p', { class: 'muted small' }, `Visar 12 av ${r.count}.`) : null,
          ]
        : h('div', { class: 'alert error' }, 'Hittade inga rader med både datum och belopp. Välj rätt kolumner ovan.'),
    );
    commit.disabled = !ok || r.new_count === 0;
    commit.textContent = r.new_count ? `Importera ${r.new_count} rader` : 'Inget nytt att importera';
  }

  const commit = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: async () => {
    commit.disabled = true;
    try {
      const r = await post('/api/import/commit', body());
      toast(`${r.added} rader importerade${r.transfers ? `, ${r.transfers} överföringar mellan dina konton hittades` : ''}.`, 'ok');
      dialog.close();
      onDone();
    } catch (e) {
      error.textContent = e.message;
      error.classList.remove('hidden');
      commit.disabled = false;
    }
  } }, 'Importera');

  text.addEventListener('input', () => {
    mapping = null;
  });
  const opened = openDialog({
    title: `Kontoutdrag för ${account.name}`,
    wide: true,
    content: [
      error,
      h('p', { class: 'muted small' }, 'Innehållet läses av servern och sparas som transaktioner. Rader du importerat tidigare hoppas över, så överlappande utdrag är ofarliga.'),
      text,
      h('div', { class: 'row mt-s' }, h('button', { class: 'btn', type: 'button', onclick: () => { mapping = null; preview(); } }, 'Förhandsgranska')),
      result,
    ],
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => opened.close() }, 'Avbryt'), commit],
  });
  dialog = opened;
  text.focus();
}
