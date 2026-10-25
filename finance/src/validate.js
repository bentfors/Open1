import { bad } from './http.js';

export function str(v, label, { max = 200, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} måste anges.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${label} har fel format.`);
  const s = v.trim();
  if (required && !s) throw bad(`${label} måste anges.`);
  if (s.length > max) throw bad(`${label} är för långt (högst ${max} tecken).`);
  return s;
}

export function oneOf(v, label, allowed) {
  if (!allowed.includes(v)) throw bad(`${label} har ett ogiltigt värde.`);
  return v;
}

// Belopp i öre. Heltal, högst en biljon kronor så att summor inte spricker.
export function ore(v, label, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} måste anges.`);
    return null;
  }
  if (!Number.isInteger(v) || Math.abs(v) > 1e14) throw bad(`${label} måste vara ett belopp i öre.`);
  return v;
}

export function num(v, label, { min = 0, max = 1e12, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} måste anges.`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${label} måste vara ett tal mellan ${min} och ${max}.`);
  return v;
}

export function isoDate(v, label, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} måste anges.`);
    return null;
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`);
  return v;
}

export function id(v, label, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} måste anges.`);
    return null;
  }
  if (!Number.isInteger(v) || v < 1) throw bad(`${label} är ogiltig.`);
  return v;
}
