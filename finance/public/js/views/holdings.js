import { get, post, patch, del } from '../api.js';
import { h, setKids, toast, dataTable, editDialog, confirmDialog, fmtSek, fmtSekExact, fmtNum, fmtDateTime, fmtPct, parseKr } from '../dom.js';

const CHANGE = (h_) => (h_.cost_basis && h_.value !== null ? (h_.value - h_.cost_basis) / h_.cost_basis : null);

export async function renderHoldings(root) {
  const mount = h('div');
  const refresh = h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, 'Uppdatera kurser');
  setKids(root, h('div', { class: 'row between' }, h('h1', {}, 'Innehav'), h('div', { class: 'row' }, refresh, h('button', { class: 'btn primary', type: 'button', onclick: () => holdingDialog(null, load) }, 'Nytt innehav'))), mount);
  let accounts = [];

  async function load(force) {
    refresh.disabled = true;
    try {
      const [data, acc] = await Promise.all([get(`/api/holdings${force ? '?refresh=1' : ''}`), get('/api/accounts')]);
      accounts = acc.items;
      const unpriced = data.items.filter((x) => x.value === null);
      setKids(
        mount,
        data.provider === 'none' ? h('div', { class: 'alert warn' }, 'Automatiska kurser är avstängda på den här servern. Ange kurs manuellt på varje innehav.') : null,
        unpriced.length ? h('div', { class: 'alert warn' }, `${unpriced.length} innehav saknar kurs och räknas inte med i summan: ${unpriced.map((u) => `${u.name} (${u.reason})`).join('; ')}.`) : null,
        h('div', { class: 'kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Totalt värde'), h('div', { class: 'value' }, fmtSek(data.total)))),
        h(
          'div',
          { class: 'card flush' },
          dataTable({
            empty: 'Inga innehav än. Lägg till aktier, fonder eller andra värdepapper så värderas de till aktuell kurs.',
            rows: data.items,
            columns: [
              { label: 'Namn', render: (x) => h('div', {}, x.name, x.symbol ? h('div', { class: 'small muted' }, x.symbol) : null) },
              { label: 'Antal', num: true, render: (x) => fmtNum(x.quantity, 4) },
              {
                label: 'Kurs',
                num: true,
                render: (x) =>
                  x.price === undefined
                    ? '–'
                    : h('div', {}, `${fmtNum(x.price)} ${x.currency}`, h('div', { class: 'small muted' }, x.stale ? h('span', { class: 'chip warn' }, 'gammal kurs') : x.as_of ? fmtDateTime(x.as_of) : '')),
              },
              { label: 'Värde', num: true, render: (x) => (x.value === null ? h('span', { class: 'muted' }, 'saknar kurs') : fmtSekExact(x.value)) },
              { label: 'Anskaffning', num: true, render: (x) => (x.cost_basis ? fmtSek(x.cost_basis) : '') },
              { label: 'Utveckling', num: true, render: (x) => { const c = CHANGE(x); return c === null ? '' : h('span', { class: c < 0 ? 'neg' : 'pos' }, `${c > 0 ? '+' : ''}${fmtPct(c, 1)}`); } },
              {
                label: '',
                class: 'actions',
                render: (x) =>
                  h(
                    'div',
                    { class: 'row' },
                    h('button', { class: 'btn sm', type: 'button', onclick: () => holdingDialog(x, load) }, 'Ändra'),
                    h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDialog(`Ta bort ${x.name}?`, { danger: true, confirmLabel: 'Ta bort' })) { await del(`/api/holdings/${x.id}`); load(); } } }, 'Ta bort'),
                  ),
              },
            ],
          }),
        ),
        h('p', { class: 'muted small' }, 'Kurser hämtas från en gratis källa utan garantier och kan vara fördröjda eller saknas. Svenska aktier har ändelsen .ST (VOLV-B.ST). Svenska fonder saknar oftast symbol: använd manuell kurs och uppdatera den själv. Anskaffningsvärdet är det du betalat totalt och används bara för att visa utveckling.'),
      );
    } finally {
      refresh.disabled = false;
    }
  }

  await load(false);
}

function holdingDialog(holding, onDone) {
  const mode = holding?.price_mode ?? 'auto';
  const lookupOut = h('div', { class: 'small muted' });
  const extra = h('div', {}, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    const symbol = document.getElementById('f-symbol').value.trim();
    if (!symbol) return;
    try {
      const r = await get(`/api/prices/lookup?symbol=${encodeURIComponent(symbol)}`);
      lookupOut.textContent = `${symbol.toUpperCase()}: ${fmtNum(r.price)} ${r.currency}`;
      document.getElementById('f-currency').value = r.currency;
    } catch (e) {
      lookupOut.textContent = e.message;
    }
  } }, 'Slå upp symbol'), ' ', lookupOut);
  editDialog({
    title: holding ? 'Ändra innehav' : 'Nytt innehav',
    extra,
    fields: [
      { name: 'name', label: 'Namn', required: true, maxlength: 120, full: true },
      { name: 'price_mode', label: 'Kurs', type: 'select', options: [{ value: 'auto', label: 'Automatisk (börssymbol)' }, { value: 'manual', label: 'Manuell' }] },
      { name: 'symbol', label: 'Symbol', maxlength: 40, hint: 'Till exempel VOLV-B.ST, AAPL, ^OMXS30' },
      { name: 'quantity', label: 'Antal', type: 'number', step: 'any', min: 0, required: true },
      { name: 'currency', label: 'Valuta', maxlength: 3 },
      { name: 'manual_price', label: 'Manuell kurs (i valutan)', type: 'number', step: 'any', min: 0, hint: 'Används bara vid manuell kurs.' },
      { name: 'cost_basis', label: 'Anskaffningsvärde totalt (kr, valfritt)' },
      { name: 'shared', label: 'Delat med hushållet (privat om det ligger på ett privat konto)', type: 'checkbox', full: true, default: true },
    ],
    values: holding ? { ...holding, shared: !!holding.shared, cost_basis: holding.cost_basis ? String(holding.cost_basis / 100).replace('.', ',') : '', manual_price: holding.manual_price ?? '' } : { price_mode: mode, currency: 'SEK' },
    onSave: async (v) => {
      const cost = parseKr(v.cost_basis);
      if (Number.isNaN(cost)) throw new Error('Anskaffningsvärdet måste vara ett belopp i kronor.');
      const body = { name: v.name, price_mode: v.price_mode, symbol: v.symbol, quantity: v.quantity, currency: (v.currency || 'SEK').toUpperCase(), cost_basis: cost, manual_price: v.price_mode === 'manual' ? v.manual_price : null, shared: v.shared };
      if (holding) await patch(`/api/holdings/${holding.id}`, body);
      else await post('/api/holdings', body);
      toast('Sparat.', 'ok');
      onDone();
    },
  });
}
