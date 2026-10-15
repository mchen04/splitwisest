// Single source of truth for supported currency codes. Kept dependency-free so
// both server (fx.ts) and client (client.ts) can import it without pulling in
// the database driver.
import { invalidInput } from "./errors";

export const CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "MXN", "CNY", "KRW", "CHF", "SEK", "NZD", "BRL",
];

// Currencies with no minor unit — amounts are whole units (no sub-yen / sub-won).
// Money is still stored in 1/100 "cents", so stored amounts for these are always
// multiples of 100 and splits distribute whole units.
export const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW"]);

// Smallest representable amount, in stored 1/100 "cents", for a currency: 1 for
// normal 2-decimal currencies, 100 for zero-decimal (JPY/KRW).
export function currencyStep(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 100 : 1;
}

export function validateCurrencyAmount(cents: number, currency: string) {
  if (cents % currencyStep(currency) !== 0) invalidInput("Amount must be whole units for this currency");
}

// Fraction digits to display for a currency (0 for JPY/KRW, else 2).
export function currencyFractionDigits(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

// Short, human currency symbols for compact input adornments (e.g. the per-person
// exact-amount field). Falls back to the code itself for anything unmapped.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", CAD: "$", AUD: "$", JPY: "¥", INR: "₹",
  MXN: "$", CNY: "¥", KRW: "₩", CHF: "Fr", SEK: "kr", NZD: "$", BRL: "R$",
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}
