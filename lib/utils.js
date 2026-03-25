import crypto from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function stripTrailingZeros(value) {
  const s = String(value);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function generateCloid(prefix = 'sig') {
  const hex = crypto.randomBytes(16).toString('hex');
  return `0x${hex}`;
}

export function buildSignalId(pair, tf, direction, time) {
  return `${pair}_${tf}_${time}_${direction}`;
}

export function buildSignalKey({ symbol, side, baseTf, baseCandleCloseTime }) {
  return `${symbol}_${side}_${baseTf}_${baseCandleCloseTime}`;
}

export function tpPrice(entry, side, pct) {
  return side === 'LONG' ? entry * (1 + pct) : entry * (1 - pct);
}

export function emergencySlPrice(entry, side, pct) {
  return side === 'LONG' ? entry * (1 - pct) : entry * (1 + pct);
}

export function closeSideForPosition(side) {
  return side === 'LONG' ? 'SHORT' : 'LONG';
}

export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
