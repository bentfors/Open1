// Kurshämtning med cache. Leverantören är utbytbar: den behöver bara ha fetchQuote(symbol) → { price, currency }.

export function yahooProvider({ timeoutMs = 6000 } = {}) {
  return {
    name: 'yahoo',
    async fetchQuote(symbol) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 min-ekonomi' } });
      if (!res.ok) throw new Error(`Kurskällan svarade ${res.status}`);
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('Okänd symbol');
      return { price: meta.regularMarketPrice, currency: meta.currency || 'SEK' };
    },
  };
}

export const noProvider = { name: 'none', async fetchQuote() { throw new Error('Automatiska kurser är avstängda'); } };

// Börser som anger kurs i minsta enhet (pence).
function normalize({ price, currency }) {
  if (currency === 'GBp' || currency === 'GBX') return { price: price / 100, currency: 'GBP' };
  return { price, currency: String(currency || 'SEK').toUpperCase() };
}

export function createPriceService({ db, provider, ttlMinutes = 15, now = () => Date.now() }) {
  const getCached = db.prepare('SELECT symbol, price, currency, fetched_at FROM prices WHERE symbol = ?');
  const put = db.prepare(
    `INSERT INTO prices (symbol, price, currency, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency, fetched_at = excluded.fetched_at`,
  );

  const fresh = (row) => row && now() - Date.parse(row.fetched_at) < ttlMinutes * 60000;

  /** Returnerar Map symbol → { price, currency, fetched_at, stale, error }. Saknad kurs ger ingen post. */
  async function quotes(symbols, { force = false } = {}) {
    const out = new Map();
    const todo = [];
    for (const symbol of new Set(symbols.filter(Boolean))) {
      const cached = getCached.get(symbol);
      if (cached && !force && fresh(cached)) out.set(symbol, { ...cached, stale: false });
      else todo.push([symbol, cached]);
    }
    await Promise.all(
      todo.map(async ([symbol, cached]) => {
        try {
          const q = normalize(await provider.fetchQuote(symbol));
          const fetched_at = new Date(now()).toISOString();
          put.run(symbol, q.price, q.currency, fetched_at);
          out.set(symbol, { ...q, fetched_at, stale: false });
        } catch (err) {
          if (cached) out.set(symbol, { ...cached, stale: true, error: err.message });
          else out.set(symbol, { error: err.message, missing: true });
        }
      }),
    );
    return out;
  }

  return { quotes, provider: provider.name };
}

/** Värdet i öre av ett innehav, eller null om kurs eller valutakurs saknas. */
export function valueHolding(h, quoteMap) {
  let price;
  let currency;
  let asOf = null;
  let stale = false;
  if (h.price_mode === 'manual') {
    if (h.manual_price === null) return { value: null, reason: 'Kurs saknas' };
    price = h.manual_price;
    currency = h.currency;
    asOf = h.manual_price_date;
  } else {
    const q = quoteMap.get(h.symbol);
    if (!q || q.missing) return { value: null, reason: q?.error || 'Kurs saknas' };
    price = q.price;
    currency = q.currency;
    asOf = q.fetched_at;
    stale = q.stale;
  }
  let rate = 1;
  if (currency !== 'SEK') {
    const fx = quoteMap.get(`${currency}SEK=X`);
    if (!fx || fx.missing) return { value: null, reason: `Valutakurs ${currency}/SEK saknas`, price, currency };
    rate = fx.price;
    stale = stale || fx.stale;
  }
  return { value: Math.round(h.quantity * price * rate * 100), price, currency, as_of: asOf, stale };
}

/** Hämtar kurser (och valutakurser) och värderar alla innehav. Returnerar innehaven med value/price/currency/stale. */
export async function valueAll(prices, holdings, opts) {
  const symbols = new Set();
  for (const h of holdings) {
    if (h.price_mode === 'auto' && h.symbol) symbols.add(h.symbol);
    else if (h.price_mode === 'manual' && h.currency !== 'SEK') symbols.add(`${h.currency}SEK=X`);
  }
  const map = await prices.quotes([...symbols], opts);
  // Kursens egen valuta avgör växelkursen, så en andra omgång hämtar de valutor som dök upp först nu.
  const fx = new Set();
  for (const q of map.values()) {
    if (q.currency && q.currency !== 'SEK' && !map.has(`${q.currency}SEK=X`)) fx.add(`${q.currency}SEK=X`);
  }
  if (fx.size) for (const [k, v] of await prices.quotes([...fx], opts)) map.set(k, v);
  return holdings.map((h) => ({ ...h, ...valueHolding(h, map) }));
}
