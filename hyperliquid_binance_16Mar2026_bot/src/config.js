import 'dotenv/config';

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
}

const allowedPairs = parseCsv(process.env.ALLOWED_PAIRS, ['HYPEUSDT', 'SOLUSDT']);
const allowedTfs = parseCsv(process.env.ALLOWED_TFS, ['1M', '5M']).map((v) => v.toLowerCase());

export const CONFIG = {
  binance: {
    baseUrl: process.env.BINANCE_BASE_URL || 'https://fapi.binance.com',
    apiKey: process.env.BINANCE_API_KEY || ''
  },
  hyperliquid: {
    privateKey: process.env.HYPERLIQUID_PRIVATE_KEY || '',
    walletAddress: process.env.HYPERLIQUID_MAIN_ADDRESS || '',
    testnet: parseBool(process.env.HYPERLIQUID_TESTNET, false),
    leverage: Math.max(1, Math.floor(parseNumber(process.env.LEVERAGE, 10))),
    balanceUsagePct: Math.min(1, Math.max(0.01, parseNumber(process.env.BALANCE_USAGE_PCT, 1))),
    entryBufferPct: Math.max(0, parseNumber(process.env.ENTRY_BUFFER_PCT, 0.0001)),
    emergencySlPct: Math.max(0.0005, parseNumber(process.env.EMERGENCY_SL_PCT, 0.012))
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  runtime: {
    scanIntervalMs: Math.max(1000, parseNumber(process.env.SCAN_INTERVAL_MS, 15000)),
    pendingCheckIntervalMs: Math.max(1000, parseNumber(process.env.PENDING_CHECK_INTERVAL_MS, 2000)),
    positionCheckIntervalMs: Math.max(1000, parseNumber(process.env.POSITION_CHECK_INTERVAL_MS, 2000)),
    reconcileIntervalMs: Math.max(5000, parseNumber(process.env.RECONCILE_INTERVAL_MS, 30000)),
    entryTimeoutMs: Math.max(5000, parseNumber(process.env.ENTRY_TIMEOUT_MS, 45000))
  },
  strategy: {
    allowedPairs,
    allowedTfs,
    targetMap: {
      '1m': 0.002,
      '5m': 0.0035
    },
    bb: {
      period: 20,
      stdDev: 2
    },
    macd: {
      fast: 12,
      slow: 26,
      signal: 9
    },
    dedupeRetentionMs: Math.max(60_000, parseNumber(process.env.DEDUPE_RETENTION_MS, 12 * 60 * 60 * 1000))
  },
  storage: {
    path: process.env.STATE_PATH || './data/state.json'
  }
};
