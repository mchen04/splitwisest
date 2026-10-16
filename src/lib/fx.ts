import { sql } from "./db";
import { CURRENCIES, currencyStep } from "./currencies";
import { invalidInput } from "./errors";
export { CURRENCIES };

// Fallback approximate rates (units per USD) used if the live fetch fails and
// the cache is empty. Conversion rates are snapshotted onto each expense at
// creation time, so later rate drift never changes recorded balances.
const FALLBACK_PER_USD: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.52, JPY: 155, INR: 84,
  MXN: 18.2, CNY: 7.2, KRW: 1370, CHF: 0.89, SEK: 10.5, NZD: 1.64, BRL: 5.4,
};

const MAX_AGE_MS = 24 * 3600 * 1000;

export async function getRatesPerUsd(): Promise<Record<string, number>> {
  const cached = await sql`SELECT currency, rate_per_usd, fetched_at FROM fx_rates`;
  const cachedMap = Object.fromEntries(cached.map((r) => [r.currency, Number(r.rate_per_usd)]));
  const oldest = cached.reduce(
    (min, r) => Math.min(min, new Date(r.fetched_at).getTime()),
    Infinity
  );
  const fresh = cached.length > 0 && Date.now() - oldest < MAX_AGE_MS;
  // Always merge the fallback table UNDER live/cached rates so a currency missing
  // from the upstream feed (or the cache) still resolves instead of making
  // convert() throw "Unsupported currency". Live wins, then cache, then fallback.
  if (fresh) {
    return { ...FALLBACK_PER_USD, ...cachedMap };
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    if (json?.result === "success" && json.rates) {
      const rates: Record<string, number> = {};
      for (const c of CURRENCIES) {
        if (json.rates[c]) rates[c] = json.rates[c];
      }
      const entries = Object.entries(rates);
      if (entries.length > 0) {
        // One round-trip instead of one INSERT per currency.
        await sql`
          INSERT INTO fx_rates (currency, rate_per_usd, fetched_at)
          SELECT c, r, now()
          FROM unnest(${entries.map(([c]) => c)}::text[], ${entries.map(([, r]) => r)}::numeric[]) AS t(c, r)
          ON CONFLICT (currency) DO UPDATE SET rate_per_usd = EXCLUDED.rate_per_usd, fetched_at = now()`;
      }
      return { ...FALLBACK_PER_USD, ...cachedMap, ...rates };
    }
  } catch {
    // fall through to cache/fallback
  }
  // Stale cache or failed fetch: still merge fallback so every supported code
  // resolves (when the cache is empty this is just FALLBACK_PER_USD).
  return { ...FALLBACK_PER_USD, ...cachedMap };
}

// Convert amountCents in `from` currency to cents in `to` currency. The result is
// snapped to the target currency's smallest unit (whole yen/won for JPY/KRW).
export async function convert(amountCents: number, from: string, to: string): Promise<{ cents: number; rate: number }> {
  if (from === to) return { cents: amountCents, rate: 1 };
  const rates = await getRatesPerUsd();
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!fromRate || !toRate) invalidInput(`Unsupported currency ${from} or ${to}`);
  const rate = toRate / fromRate;
  const step = currencyStep(to);
  const raw = amountCents * rate;
  // Snap to the target unit, but never collapse a positive amount to zero (the
  // converted_cents > 0 CHECK would reject it) — floor it to one whole unit.
  const cents = raw > 0 ? Math.max(Math.round(raw / step) * step, step) : raw;
  return { cents, rate };
}
