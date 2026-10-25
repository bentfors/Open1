export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message) => new HttpError(400, message);
export const forbidden = (message = 'Du har inte behörighet till det här.') => new HttpError(403, message);
export const notFound = (message = 'Hittades inte.') => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);

// Markerar att handlern redan skrivit svaret själv (CSV, filer).
export const HANDLED = Symbol('handled');

// Svar med egen status eller egna headers (t.ex. Set-Cookie).
export const respond = (body, { status = 200, headers = {} } = {}) => ({ __respond: true, body, status, headers });

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, opts, handler) {
      const keys = [];
      const source = pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      });
      routes.push({ method, regex: new RegExp(`^${source}$`), keys, opts, handler });
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
      return { route: null, pathMatched };
    },
  };
}

export async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Förfrågan är för stor.');
    chunks.push(chunk);
  }
  if (!size) return {};
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') throw new HttpError(415, 'Innehållet måste vara JSON.');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw bad('Ogiltig JSON.');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, body, contentType, headers = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function queryObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) out[k] = v;
  return out;
}
