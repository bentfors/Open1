import { state } from './state.js';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const handlers = { unauthenticated: () => {}, passwordChange: () => {} };
export const onApiEvent = (h) => Object.assign(handlers, h);

export async function api(method, url, body) {
  // Vyn "bara mina" gäller alla anrop utom inloggning. Servern ignorerar parametern där den inte betyder något.
  if (state.scope === 'me' && !url.startsWith('/api/auth')) url += `${url.includes('?') ? '&' : '?'}scope=me`;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Kunde inte nå servern. Kontrollera anslutningen.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error || `Fel ${res.status}`, data?.code);
    if (res.status === 401 && !url.startsWith('/api/auth/login')) handlers.unauthenticated();
    if (err.code === 'PASSWORD_CHANGE_REQUIRED') handlers.passwordChange();
    throw err;
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const patch = (url, body = {}) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url);

export function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
