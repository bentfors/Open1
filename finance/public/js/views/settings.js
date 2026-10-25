import { get, post, patch, del } from '../api.js';
import { h, setKids, toast, dataTable, editDialog, confirmDialog, promptDialog } from '../dom.js';
import { state } from '../state.js';

const KIND = { income: 'Inkomst', expense: 'Utgift', transfer: 'Överföring' };

export async function renderSettings(root) {
  const household = h('div');
  const advisors = h('div');
  const cats = h('div');
  const rules = h('div');
  const pw = passwordCard();
  setKids(
    root,
    h('h1', {}, 'Inställningar'),
    h('h2', {}, 'Hushåll och antaganden'),
    household,
    h('h2', { class: 'mt-l' }, 'Rådgivare'),
    advisors,
    h('h2', { class: 'mt-l' }, 'Kategorier'),
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

  async function loadHousehold() {
    const hh = await get('/api/household');
    state.householdSize = hh.members.length;
    const a = hh.assumptions;
    const fields = [['return_rate', 'Avkastning på placeringar (% per år)'], ['cash_rate', 'Ränta på kontanter (% per år)'], ['fixed_growth', 'Värdeutveckling övriga tillgångar (% per år)'], ['inflation', 'Inflation (% per år)']];
    const inputs = Object.fromEntries(fields.map(([k]) => [k, h('input', { id: `as-${k}`, type: 'number', step: 'any', value: a[k] })]));
    const code = h('div');
    setKids(
      household,
      h('div', { class: 'card' },
        h('h3', {}, hh.name),
        h('p', {}, 'Medlemmar: ', hh.members.map((m) => m.name).join(', '), '.'),
        h('p', { class: 'muted small' }, 'Hushållet delar kategorier, regler, budget, mål och scenarier. Konton är delade om de inte markerats som privata, och privata konton syns bara för ägaren. Alla medlemmar kan ändra det som är delat.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: async () => { const r = await post('/api/household/invite'); setKids(code, h('div', { class: 'alert' }, `Inbjudningskod (visas bara nu, gäller en person i ${r.days} dagar): `, h('strong', {}, r.code))); } }, 'Bjud in någon'),
          h('button', { class: 'btn', type: 'button', onclick: joinDialog }, 'Gå med via kod'),
          hh.members.length > 1 ? h('button', { class: 'btn danger', type: 'button', onclick: leave }, 'Lämna hushållet') : null),
        code),
      h('div', { class: 'card' },
        h('h3', {}, 'Antaganden för prognoser'),
        h('p', { class: 'muted small' }, 'Det här är gissningar om framtiden, inte fakta. De styr alla scenarier och mål. Ta försiktiga tal: avkastning på aktier och fonder varierar mycket mellan år.'),
        h('div', { class: 'form-grid' }, fields.map(([k, label]) => h('div', { class: 'field' }, h('label', { for: `as-${k}` }, label), inputs[k]))),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value.replace(',', '.'))]));
          try { await patch('/api/household', body); toast('Antagandena är sparade.', 'ok'); } catch (e) { toast(e.message, 'error'); }
        } }, 'Spara antaganden')),
    );
  }

  function joinDialog() {
    editDialog({
      title: 'Gå med i ett hushåll',
      fields: [{ name: 'code', label: 'Inbjudningskod', required: true, full: true, hint: 'Dina konton, kategorier, mål och scenarier följer med. Din nuvarande budget ersätts av hushållets.' }],
      values: {},
      saveLabel: 'Gå med',
      onSave: async (v) => {
        await post('/api/household/join', { code: v.code });
        toast('Du är med i hushållet.', 'ok');
        location.reload();
      },
    });
  }

  async function leave() {
    if (!(await confirmDialog('Du får ett eget hushåll med dina konton. Budget, mål och scenarier stannar kvar hos de andra. Delade konton du äger följer med dig.', { confirmLabel: 'Lämna', danger: true }))) return;
    await post('/api/household/leave');
    location.reload();
  }

  let shownCode = null; // koden måste överleva omritningen av listan
  const GRANT_STATE = {
    invitation: ['Kod skapad, ej inlöst', 'warn'],
    code_expired: ['Koden har gått ut', 'rejected'],
    awaiting_approval: ['Väntar på godkännande', 'warn'],
    active: ['Aktivt', 'approved'],
    expired: ['Har gått ut', 'rejected'],
    revoked: ['Återkallat', 'rejected'],
  };

  async function loadAdvisors() {
    const data = await get('/api/advisors');
    if (!data.enabled) return setKids(advisors, h('p', { class: 'muted' }, 'Rådgivarfunktionen är avstängd på den här servern.'));
    const level = h('select', { id: 'adv-level' }, h('option', { value: 'summary' }, 'Sammanfattning: nyckeltal, rapporter, budget, mål och scenarier'), h('option', { value: 'detail' }, 'Detaljer: dessutom enskilda transaktioner'));
    const months = h('select', { id: 'adv-months' }, [3, 6, 12, 24].map((m) => h('option', { value: m, selected: m === 12 }, `${m} månader`)));
    const code = h('div');
    if (shownCode) setKids(code, shownCode);
    setKids(
      advisors,
      h('div', { class: 'card' },
        h('p', {}, 'Du bestämmer vem som får titta på din ekonomi, hur mycket och hur länge. Rådgivaren får bara läsa. Privata konton och deras transaktioner och innehav visas aldrig. Alla i hushållet måste godkänna, vem som helst kan återkalla, och allt rådgivaren öppnar syns i loggen nedan.'),
        h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { for: 'adv-level' }, 'Vad får rådgivaren se?'), level), h('div', { class: 'field' }, h('label', { for: 'adv-months' }, 'Hur länge?'), months)),
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try {
            const r = await post('/api/advisors', { level: level.value, months: Number(months.value) });
            shownCode = h('div', { class: 'alert' }, `Ge rådgivaren den här koden (visas bara nu, gäller i ${r.code_days} dagar): `, h('strong', {}, r.code), '. Rådgivaren skapar ett eget konto och löser in den under Inställningar.');
            loadAdvisors();
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, 'Skapa kod för rådgivare'),
        code),
      data.items.length ? h('div', { class: 'card flush mt-m' }, dataTable({
        rows: data.items,
        columns: [
          { label: 'Rådgivare', render: (g) => g.advisor || h('span', { class: 'muted' }, 'inte inlöst') },
          { label: 'Nivå', render: (g) => (g.level === 'detail' ? 'Detaljer' : 'Sammanfattning') },
          { label: 'Status', render: (g) => h('div', {}, h('span', { class: `chip ${GRANT_STATE[g.state][1]}` }, GRANT_STATE[g.state][0]), g.approvals.missing.length && !['revoked', 'expired', 'code_expired'].includes(g.state) ? h('div', { class: 'small muted' }, `Saknar godkännande från ${g.approvals.missing.map((m) => m.name).join(', ')}`) : null) },
          { label: 'Gäller till', render: (g) => g.expires_at.slice(0, 10) },
          { label: '', class: 'actions', render: (g) => h('div', { class: 'row' },
            !g.i_approved && !['revoked', 'expired', 'code_expired'].includes(g.state) ? h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { await post(`/api/advisors/${g.id}/approve`); toast('Godkänt.', 'ok'); loadAdvisors(); } }, 'Godkänn') : null,
            !['revoked', 'expired', 'code_expired'].includes(g.state) ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDialog('Rådgivaren förlorar åtkomsten direkt. Det går inte att ångra, men du kan ge ett nytt samtycke.', { danger: true, confirmLabel: 'Återkalla' })) { await post(`/api/advisors/${g.id}/revoke`); loadAdvisors(); } } }, 'Återkalla') : null) },
        ],
      })) : null,
      h('h3', { class: 'mt-m' }, 'Åtkomstlogg'),
      h('div', { class: 'card flush' }, dataTable({ empty: 'Ingen rådgivare har öppnat något.', rows: data.log, columns: [{ label: 'Tid (UTC)', class: 'nowrap', render: (l) => l.at }, { label: 'Rådgivare', render: (l) => l.advisor }, { label: 'Öppnade', render: (l) => l.action }] })),
      h('div', { class: 'card mt-m' },
        h('h3', {}, 'Är du rådgivare?'),
        h('p', { class: 'muted small' }, 'Lös in en kod du fått av en kund för att se kundens ekonomi (med kundens samtycke). Menyvalet Rådgivare dyker upp.'),
        (() => {
          const input = h('input', { id: 'redeem-code', type: 'text', autocomplete: 'off', placeholder: 'Kod från kunden' });
          return h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'button', onclick: async () => {
            try {
              await post('/api/advisor/redeem', { code: input.value.trim() });
              location.hash = '#/radgivare';
              location.reload();
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, 'Lös in'));
        })()),
      h('p', { class: 'muted small' }, 'Rådgivarens egna anteckningar om dig ser du inte. De tillhör rådgivaren, som är ansvarig för dem. Radera hela kontot här nedan om du vill att din data ska försvinna.'),
    );
  }

  await Promise.all([loadHousehold(), loadAdvisors(), loadCats(), loadRules()]);
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
