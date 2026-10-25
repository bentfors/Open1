import { get, post, patch, del } from '../api.js';
import { h, setKids, toast, dataTable, editDialog, confirmDialog, promptDialog } from '../dom.js';
import { state } from '../state.js';

const KIND = { income: 'Inkomst', expense: 'Utgift', transfer: 'Överföring' };

export async function renderSettings(root) {
  const cats = h('div');
  const rules = h('div');
  const pw = passwordCard();
  setKids(
    root,
    h('h1', {}, 'Inställningar'),
    h('h2', {}, 'Kategorier'),
    cats,
    h('h2', { class: 'mt-l' }, 'Regler för automatisk kategorisering'),
    rules,
    h('h2', { class: 'mt-l' }, 'Konto och data'),
    pw,
    dataCard(),
  );

  async function loadCats() {
    const { items } = await get('/api/categories');
    setKids(
      cats,
      h('p', { class: 'muted small' }, 'Överföringar ingår inte i resultatrapporten: egna kontoöverföringar, sparande och amortering av lån.'),
      h('div', { class: 'card flush' }, dataTable({
        rows: items,
        columns: [
          { label: 'Kategori', render: (c) => c.name },
          { label: 'Typ', render: (c) => KIND[c.kind] },
          { label: '', class: 'actions', render: (c) => h('div', { class: 'row' },
            h('button', { class: 'btn sm', type: 'button', onclick: () => editCat(c) }, 'Ändra'),
            h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDialog(`Ta bort ${c.name}? Transaktioner i kategorin blir okategoriserade och reglerna för den försvinner.`, { danger: true, confirmLabel: 'Ta bort' })) { await del(`/api/categories/${c.id}`); loadCats(); loadRules(); } } }, 'Ta bort')) },
        ],
      })),
      h('div', { class: 'mt-s' }, h('button', { class: 'btn', type: 'button', onclick: () => editCat(null) }, 'Ny kategori')),
    );
  }

  function editCat(c) {
    editDialog({
      title: c ? 'Ändra kategori' : 'Ny kategori',
      fields: [{ name: 'name', label: 'Namn', required: true, maxlength: 60 }, { name: 'kind', label: 'Typ', type: 'select', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) }],
      values: c || { kind: 'expense' },
      onSave: async (v) => {
        if (c) await patch(`/api/categories/${c.id}`, v);
        else await post('/api/categories', v);
        loadCats();
        loadRules();
      },
    });
  }

  async function loadRules() {
    const [{ items }, { items: categories }] = await Promise.all([get('/api/rules'), get('/api/categories')]);
    setKids(
      rules,
      h('p', { class: 'muted small' }, 'En regel gäller när texten innehåller mönstret som helt ord. Längsta mönstret vinner. Nya regler sätter bara kategori på okategoriserade transaktioner.'),
      h('div', { class: 'card flush' }, dataTable({
        empty: 'Inga regler.',
        rows: items,
        columns: [
          { label: 'Texten innehåller', render: (r) => r.pattern },
          { label: 'Kategori', render: (r) => r.category },
          { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { await del(`/api/rules/${r.id}`); loadRules(); } }, 'Ta bort') },
        ],
      })),
      h('div', { class: 'mt-s' }, h('button', { class: 'btn', type: 'button', onclick: () => editDialog({
        title: 'Ny regel',
        fields: [{ name: 'pattern', label: 'Texten innehåller', required: true, maxlength: 60 }, { name: 'category_id', label: 'Kategori', type: 'select', options: categories.map((c) => ({ value: c.id, label: c.name })) }],
        values: {},
        onSave: async (v) => {
          const r = await post('/api/rules', v);
          toast(r.applied ? `Regeln satte kategori på ${r.applied} transaktioner.` : 'Regeln är sparad.', 'ok');
          loadRules();
        },
      }) }, 'Ny regel')),
    );
  }

  await Promise.all([loadCats(), loadRules()]);
}

function passwordCard() {
  const current = h('input', { id: 'current', type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { id: 'next', type: 'password', autocomplete: 'new-password', required: true });
  const error = h('div', { class: 'alert error hidden', role: 'alert' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    error.classList.add('hidden');
    try {
      await post('/api/auth/password', { current: current.value, next: next.value });
      toast('Lösenordet är bytt.', 'ok');
      form.reset();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  } }, error, h('div', { class: 'field' }, h('label', { for: 'current' }, 'Nuvarande lösenord'), current), h('div', { class: 'field' }, h('label', { for: 'next' }, 'Nytt lösenord (minst 10 tecken)'), next), h('button', { class: 'btn primary', type: 'submit' }, 'Byt lösenord'));
  return h('div', { class: 'card' }, h('p', {}, 'Inloggad som ', h('strong', {}, state.user.email), '.'), form);
}

function dataCard() {
  return h('div', { class: 'card' }, h('h3', {}, 'Dina data'), h('p', { class: 'muted' }, 'Ladda ner allt som är sparat om dig som JSON, eller radera kontot och all data permanent.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: '/api/export', download: 'min-ekonomi.json' }, 'Ladda ner mina data'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        const password = await promptDialog({ title: 'Radera kontot', label: 'Skriv ditt lösenord för att radera kontot och all data. Det går inte att ångra.', confirmLabel: 'Radera allt', multiline: false });
        if (!password) return;
        try {
          await post('/api/auth/delete-account', { password });
          location.reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, 'Radera konto')));
}
