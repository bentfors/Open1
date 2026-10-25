import { get, qs } from '../api.js';
import { h, add, setKids } from '../dom.js';

// Kolumner som går att sortera: [nyckel på servern, rubrik, riktning vid första klicket].
const COLUMNS = [
  ['at', 'När', 'desc'],
  ['actor', 'Utförd av', 'asc'],
  ['action', 'Typ av ändring', 'asc'],
  ['entity', 'Avser', 'asc'],
  ['label', 'Beskrivning', 'asc'],
  ['customer', 'Kund', 'asc'],
  ['project', 'Projekt', 'asc'],
  ['user', 'Användare', 'asc'],
];

const ACTION_CHIP = { create: 'approved', approve: 'approved', delete: 'rejected', reject: 'rejected', undo: 'rejected', password: 'warn', reopen: 'warn', waive: 'warn', restore: 'warn' };
const PAGE_SIZES = [25, 50, 100, 200];
const SHOWN_CHANGES = 4;

const dayFmt = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat('sv-SE', { timeStyle: 'short' });

function changeLine(c, action) {
  const field = h('span', { class: 'chg-field' }, `${c.field}: `);
  if (c.from === '–') return h('div', { class: 'small muted' }, field, c.to);
  if (c.to === '–' && action === 'delete') return h('div', { class: 'small muted' }, field, c.from);
  return h('div', { class: 'small muted' }, field, c.from, ' → ', c.to);
}

function changeLines(r) {
  const lines = r.changes.map((c) => changeLine(c, r.action));
  if (lines.length <= SHOWN_CHANGES) return lines;
  return [...lines.slice(0, SHOWN_CHANGES), h('details', {}, h('summary', {}, `+${lines.length - SHOWN_CHANGES} till`), lines.slice(SHOWN_CHANGES))];
}

export async function logTab(root) {
  const q = { sort: 'at', dir: 'desc', offset: 0, limit: 50, actor_id: '', action: '', entity: '', customer_id: '', project_id: '', user_id: '', from: '', to: '', q: '' };
  const FILTER_KEYS = ['actor_id', 'action', 'entity', 'customer_id', 'project_id', 'user_id', 'from', 'to', 'q'];
  const controls = {};
  const result = h('div', { class: 'card flush' });

  const first = await get(`/api/audit${qs({ ...q, facets: 1 })}`);
  const { facets, labels } = first;

  async function load() {
    try {
      draw(await get(`/api/audit${qs(q)}`));
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  function changeFilter(key, value) {
    q[key] = value;
    q.offset = 0;
    load();
  }

  // Ett klick på ett namn i tabellen filtrerar på det.
  function filterLink(text, key, id) {
    if (!text) return null;
    if (!id) return text;
    return h(
      'button',
      {
        class: 'linklike',
        type: 'button',
        title: 'Visa bara det här',
        onclick: () => {
          const select = controls[key];
          if (![...select.options].some((o) => o.value === String(id))) select.append(h('option', { value: String(id) }, text));
          select.value = String(id);
          changeFilter(key, String(id));
        },
      },
      text,
    );
  }

  function sortBy(key, firstDir) {
    if (q.sort === key) q.dir = q.dir === 'asc' ? 'desc' : 'asc';
    else {
      q.sort = key;
      q.dir = firstDir;
    }
    q.offset = 0;
    load();
  }

  function draw(data) {
    const head = h(
      'tr',
      {},
      COLUMNS.map(([key, label, firstDir]) => {
        const active = data.sort === key;
        return h(
          'th',
          { class: 'sortable', 'aria-sort': active ? (data.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
          h(
            'button',
            { class: `sort-btn ${active ? 'active' : ''}`, type: 'button', title: `Sortera på ${label.toLowerCase()}`, onclick: () => sortBy(key, firstDir) },
            label,
            h('span', { class: 'sort-arrow', 'aria-hidden': 'true' }, active ? (data.dir === 'asc' ? '▲' : '▼') : '↕'),
          ),
        );
      }),
    );

    const rows = data.rows.map((r) =>
      h(
        'tr',
        {},
        h('td', { class: 'nowrap' }, dayFmt.format(new Date(r.at)), h('div', { class: 'small muted' }, timeFmt.format(new Date(r.at)))),
        h('td', {}, filterLink(r.actor_name, 'actor_id', r.actor_id)),
        h('td', {}, h('span', { class: `chip ${ACTION_CHIP[r.action] ?? ''}` }, labels.action[r.action] ?? r.action)),
        h('td', {}, labels.entity[r.entity] ?? r.entity),
        h('td', { class: 'log-desc' }, h('div', {}, r.label || '–'), changeLines(r), r.note ? h('div', { class: 'small muted' }, r.note) : null),
        h('td', {}, filterLink(r.customer_label, 'customer_id', r.customer_id)),
        h('td', {}, filterLink(r.project_label, 'project_id', r.project_id)),
        h('td', {}, filterLink(r.user_label, 'user_id', r.user_id)),
      ),
    );

    const from = data.total ? data.offset + 1 : 0;
    const to = Math.min(data.offset + data.limit, data.total);
    const sizeSelect = h(
      'select',
      {
        'aria-label': 'Rader per sida',
        onchange: (e) => {
          q.limit = Number(e.target.value);
          q.offset = 0;
          load();
        },
      },
      PAGE_SIZES.map((n) => h('option', { value: n, selected: n === data.limit }, `${n} per sida`)),
    );
    const step = (dir) => () => {
      q.offset = Math.max(0, data.offset + dir * data.limit);
      load();
    };

    setKids(
      result,
      data.rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, rows)))
        : h('div', { class: 'empty' }, 'Inga ändringar för urvalet.'),
      h(
        'div',
        { class: 'row between log-foot' },
        h('span', { class: 'muted small', 'aria-live': 'polite' }, `Visar ${from}–${to} av ${data.total}`),
        h(
          'div',
          { class: 'row' },
          sizeSelect,
          h('button', { class: 'btn sm', type: 'button', disabled: data.offset === 0, onclick: step(-1) }, 'Föregående'),
          h('button', { class: 'btn sm', type: 'button', disabled: to >= data.total, onclick: step(1) }, 'Nästa'),
        ),
      ),
    );
  }

  const choice = (key, label, options) => {
    const el = h('select', { id: `log-${key}`, onchange: (e) => changeFilter(key, e.target.value) }, h('option', { value: '' }, 'Alla'), options.map((o) => h('option', { value: String(o.value) }, o.label)));
    controls[key] = el;
    return h('div', { class: 'field' }, h('label', { for: `log-${key}` }, label), el);
  };
  const date = (key, label) => {
    const el = h('input', { id: `log-${key}`, type: 'date', onchange: (e) => changeFilter(key, e.target.value) });
    controls[key] = el;
    return h('div', { class: 'field' }, h('label', { for: `log-${key}` }, label), el);
  };

  let timer;
  const search = h('input', {
    id: 'log-q',
    type: 'text',
    autocomplete: 'off',
    placeholder: 'Namn, anteckning, värde …',
    maxlength: '100',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => changeFilter('q', e.target.value), 300);
    },
  });
  controls.q = search;

  const named = (list) => list.map((x) => ({ value: x.id, label: x.name }));
  const filters = h(
    'div',
    { class: 'filters' },
    choice('actor_id', 'Utförd av', named(facets.actors)),
    choice('action', 'Typ av ändring', facets.actions),
    choice('entity', 'Avser', facets.entities),
    choice('customer_id', 'Kund', named(facets.customers)),
    choice('project_id', 'Projekt', named(facets.projects)),
    choice('user_id', 'Användare', named(facets.users)),
    date('from', 'Från'),
    date('to', 'Till'),
    h('div', { class: 'field' }, h('label', { for: 'log-q' }, 'Sök'), search),
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          for (const key of FILTER_KEYS) {
            q[key] = '';
            controls[key].value = '';
          }
          q.offset = 0;
          load();
        },
      },
      'Rensa filter',
    ),
    h('a', { class: 'btn', href: '#', onclick: (e) => { e.currentTarget.href = `/api/audit${qs({ ...q, format: 'csv', offset: undefined, limit: undefined })}`; } }, 'Exportera CSV'),
  );

  add(
    root,
    h('div', {}, h('h2', {}, 'Ändringslogg'), h('p', { class: 'muted' }, 'Vem som ändrat vad. Raderna kan inte ändras eller tas bort. Klicka på en rubrik för att sortera, eller på ett namn för att filtrera på det.')),
    h('div', { class: 'card' }, filters),
    result,
    h('p', { class: 'muted small' }, 'Loggen visar ändringar av användare, kunder, projekt, avtal, provisionsregler och inställningar, samt fakturering, avskrivning, attest, och när någon rapporterar eller rättar åt någon annan eller i en låst period. Egen tid och egna utlägg loggas inte.'),
  );
  draw(first);
}
