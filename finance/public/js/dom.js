// Liten DOM-hjälpare. Text sätts alltid som textnoder, aldrig som HTML, så användardata kan inte injicera markup.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'type' || k === 'id') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => {
  el.replaceChildren();
  return el;
};

// Null-säkra varianter av append/replaceChildren. De nativa skriver ut "null" som text.
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function setKids(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ── Formatering ─────────────────────────────────────────────────────────
export const fmtNum = (n, decimals = 2) =>
  new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(n ?? 0);

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
export const fmtDate = (iso) => (iso ? dateFmt.format(utc(iso)) : '');
export const fmtShort = (iso) => shortFmt.format(utc(iso));

export function addDays(iso, n) {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthRange(offset = 0, now = new Date()) {
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1));
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export const fmtMonth = (ym) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${ym}-01T00:00:00Z`));

export function quarterRange(offset = 0, now = new Date()) {
  const q = Math.floor(now.getMonth() / 3) + offset;
  const first = new Date(Date.UTC(now.getFullYear(), q * 3, 1));
  const last = new Date(Date.UTC(now.getFullYear(), q * 3 + 3, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── Meddelanden och dialoger ────────────────────────────────────────────
export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

export function openDialog({ title, content, actions = [], wide = false }) {
  const dialog = h('dialog', { class: wide ? 'wide' : '' });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Stäng', onclick: close }, '✕')),
    h('div', { class: 'dialog-body' }, content),
  );
  if (actions.length) dialog.append(h('div', { class: 'dialog-foot' }, actions));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog(message, { confirmLabel = 'OK', danger = false, title = 'Bekräfta' } = {}) {
  return new Promise((resolve) => {
    const done = (value) => {
      close();
      resolve(value);
    };
    const { close } = openDialog({
      title,
      content: h('p', {}, message),
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Avbryt'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => done(true) }, confirmLabel),
      ],
    });
  });
}

export function promptDialog({ title, label, confirmLabel = 'OK', required = true, multiline = true }) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea', { id: 'prompt-input', maxlength: 500 }) : h('input', { id: 'prompt-input', type: 'text', maxlength: 500 });
    const error = h('div', { class: 'alert error hidden' });
    const done = (value) => {
      close();
      resolve(value);
    };
    const { close, dialog } = openDialog({
      title,
      content: [error, h('div', { class: 'field' }, h('label', { for: 'prompt-input' }, label), input)],
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Avbryt'),
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: () => {
              const value = input.value.trim();
              if (required && !value) {
                error.textContent = 'Fältet får inte vara tomt.';
                error.classList.remove('hidden');
                return;
              }
              done(value);
            },
          },
          confirmLabel,
        ),
      ],
    });
    input.focus();
    dialog.addEventListener('close', () => resolve(null), { once: true });
  });
}

// ── Formulär ────────────────────────────────────────────────────────────
// fält: { name, label, type, options, required, hint, step, min, max, maxlength, full }
export function buildForm(fields, values = {}) {
  const inputs = new Map();
  const el = h('div', { class: 'form-grid' });
  for (const f of fields) {
    const id = `f-${f.name}`;
    let input;
    const v = values[f.name];
    if (f.type === 'select') {
      input = h('select', { id, disabled: f.disabled });
      for (const o of f.options) {
        input.append(h('option', { value: String(o.value ?? ''), selected: String(o.value ?? '') === String(v ?? '') }, o.label));
      }
    } else if (f.type === 'checkbox') {
      input = h('input', { id, type: 'checkbox', checked: v === undefined ? !!f.default : !!v });
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, maxlength: f.maxlength, value: v ?? '' });
    } else {
      input = h('input', {
        id,
        type: f.type || 'text',
        value: v ?? f.default ?? '',
        step: f.step,
        min: f.min,
        max: f.max,
        maxlength: f.maxlength,
        autocomplete: f.type === 'password' ? 'new-password' : 'off',
      });
    }
    inputs.set(f.name, { input, def: f });
    const wrap =
      f.type === 'checkbox'
        ? h('div', { class: `field check ${f.full ? 'full' : ''}` }, h('label', { for: id }, input, f.label))
        : h('div', { class: `field ${f.full ? 'full' : ''}` }, h('label', { for: id }, f.label + (f.required ? ' *' : '')), input);
    if (f.hint) wrap.append(h('div', { class: 'hint' }, f.hint));
    el.append(wrap);
  }
  const read = () => {
    const out = {};
    for (const [name, { input, def }] of inputs) {
      if (def.skip) continue;
      if (def.type === 'checkbox') out[name] = input.checked;
      else if (def.type === 'select') {
        const opt = def.options.find((o) => String(o.value ?? '') === input.value);
        out[name] = opt?.value ?? null;
      } else if (def.type === 'number') out[name] = input.value.trim() === '' ? null : Number(input.value.replace(',', '.'));
      else out[name] = input.value.trim() === '' ? (def.nullable ? null : '') : input.value.trim();
    }
    return out;
  };
  return { el, read, inputs };
}

export function editDialog({ title, fields, values, onSave, saveLabel = 'Spara', wide = false, extra }) {
  const form = buildForm(fields, values);
  const error = h('div', { class: 'alert error hidden' });
  const save = h('button', { class: 'btn primary', type: 'button' }, saveLabel);
  const { close } = openDialog({
    title,
    wide,
    content: [error, form.el, extra],
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Avbryt'), save],
  });
  const submit = async () => {
    error.classList.add('hidden');
    save.disabled = true;
    try {
      await onSave(form.read());
      close();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  form.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      submit();
    }
  });
  return { close };
}

// ── Tabeller ────────────────────────────────────────────────────────────
// kolumner: { label, render(row) | key, class, num }
export function dataTable({ columns, rows, empty = 'Inget att visa.', rowClass, footer }) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : c.class || '' }, c.label))));
  const tbody = h(
    'tbody',
    {},
    rows.map((r) =>
      h(
        'tr',
        { class: rowClass ? rowClass(r) : '' },
        columns.map((c) => h('td', { class: c.num ? `num ${c.class || ''}` : c.class || '' }, c.render ? c.render(r) : r[c.key] ?? '')),
      ),
    ),
  );
  const parts = [thead, tbody];
  if (footer) parts.push(h('tfoot', {}, h('tr', {}, columns.map((c, i) => h('td', { class: c.num ? 'num' : '' }, footer(c, i) ?? '')))));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, parts));
}

export const optionList = (items, { value = (i) => i.id, label = (i) => i.name, blank } = {}) => [
  ...(blank !== undefined ? [{ value: null, label: blank }] : []),
  ...items.map((i) => ({ value: value(i), label: label(i) })),
];

// ── SVG, tidsspann och kompakta belopp ──────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// 12 340 → "12,3 tkr", 1 200 000 → "1,2 mkr"
export function fmtK(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}${fmtNum(a / 1e6, 1)} mkr`;
  if (a >= 1e3) return `${sign}${fmtNum(a / 1e3, 1)} tkr`;
  return `${sign}${fmtNum(a, 0)}`;
}

export const shortMonth = (ym) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', month: 'short' }).format(new Date(`${ym}-01T00:00:00Z`)).replace('.', '');

// ── Belopp. API:et räknar i öre, gränssnittet visar kronor. ─────────────
const sek = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const sekExact = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtSek = (ore) => `${(ore < 0 ? '−' : '') + sek.format(Math.abs(ore) / 100)} kr`;
export const fmtSekExact = (ore) => `${(ore < 0 ? '−' : '') + sekExact.format(Math.abs(ore) / 100)} kr`;
export const fmtPct = (x, d = 0) => (x === null || x === undefined ? '–' : `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: d }).format(x * 100)} %`);

// "1 234,5" eller "1234.5" → öre. Tom sträng → null, ogiltigt → NaN.
export function parseKr(input) {
  const s = String(input ?? '').trim().replace(/[\s\u00a0]/g, '').replace('−', '-').replace(',', '.');
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

export const fmtDateTime = (iso) => (iso ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');
