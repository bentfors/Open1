import { bad } from './http.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Varje fält är { required, nullable, label, parse(raw) }.
function field(opts, parse) {
  return { required: false, nullable: false, ...opts, parse };
}

export const f = {
  str: (o = {}) =>
    field(o, (raw, label) => {
      if (typeof raw !== 'string') throw bad(`${label} måste vara text.`);
      const s = raw.trim();
      if (o.required && !s) throw bad(`${label} saknas.`);
      if (o.max && s.length > o.max) throw bad(`${label} får vara högst ${o.max} tecken.`);
      return s;
    }),
  email: (o = {}) =>
    field(o, (raw, label) => {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200) throw bad(`${label} är ogiltig.`);
      return s;
    }),
  int: (o = {}) =>
    field(o, (raw, label) => {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (!Number.isInteger(n)) throw bad(`${label} måste vara ett heltal.`);
      if (o.min !== undefined && n < o.min) throw bad(`${label} måste vara minst ${o.min}.`);
      if (o.max !== undefined && n > o.max) throw bad(`${label} får vara högst ${o.max}.`);
      return n;
    }),
  num: (o = {}) =>
    field(o, (raw, label) => {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(',', '.')) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${label} måste vara ett tal.`);
      if (o.min !== undefined && n < o.min) throw bad(`${label} måste vara minst ${o.min}.`);
      if (o.max !== undefined && n > o.max) throw bad(`${label} får vara högst ${o.max}.`);
      return n;
    }),
  bool: (o = {}) =>
    field(o, (raw, label) => {
      if (typeof raw === 'boolean') return raw ? 1 : 0;
      if (raw === 0 || raw === 1) return raw;
      throw bad(`${label} måste vara ja eller nej.`);
    }),
  date: (o = {}) =>
    field(o, (raw, label) => {
      if (!isDate(raw)) throw bad(`${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`);
      return raw;
    }),
  oneOf: (values, o = {}) =>
    field(o, (raw, label) => {
      if (!values.includes(raw)) throw bad(`${label} har ett ogiltigt värde.`);
      return raw;
    }),
};

// schema: { nyckel: f.xxx({ label, required, nullable }) }
// partial: för PATCH, saknade fält hoppas över.
export function parse(body, schema, { partial = false } = {}) {
  const out = {};
  for (const [key, def] of Object.entries(schema)) {
    const label = def.label || key;
    const raw = body[key];
    if (raw === undefined) {
      if (!partial && def.required) throw bad(`${label} saknas.`);
      continue;
    }
    if (raw === null || raw === '') {
      if (def.nullable) {
        out[key] = null;
        continue;
      }
      if (def.required) throw bad(`${label} saknas.`);
      if (raw === null) throw bad(`${label} får inte vara tomt.`);
    }
    out[key] = def.parse(raw, label);
  }
  return out;
}

// Query-parametrar för rapporter m.m.
export function optDate(value, label) {
  if (value === undefined || value === '') return undefined;
  if (!isDate(value)) throw bad(`${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`);
  return value;
}

export function optId(value, label) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${label} är ogiltigt.`);
  return n;
}

export function reqId(value, label) {
  const n = optId(value, label);
  if (n === undefined) throw bad(`${label} saknas.`);
  return n;
}
