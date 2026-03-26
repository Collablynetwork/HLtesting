import 'dotenv/config';

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseInteger(value, fallback) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) ? n : fallback;
}

function parseMarginMode(value, fallback = 'isolated') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'cross' ? 'cross' : fallback;
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
const leverage = Math.max(1, parseInteger(process.env.LEVERAGE, 10));
const balanceUsagePct = Math.min(1, Math.max(0.01, parseNumber(process.env.BALANCE_USAGE_PCT, 1)));

export const CONFIG = {
  binance: {
    baseUrl: process.env.BINANCE_BASE_URL || 'https://fapi.binance.com',
    apiKey: process.env.BINANCE_API_KEY || '',
    timeoutMs: Math.max(15000, parseInteger(process.env.BINANCE_TIMEOUT_MS, 30000))
  },
  hyperliquid: {
    privateKey: process.env.HYPERLIQUID_PRIVATE_KEY || '',
    walletAddress: process.env.HYPERLIQUID_MAIN_ADDRESS || '',
    testnet: parseBool(process.env.HYPERLIQUID_TESTNET, false),
    marginMode: parseMarginMode(process.env.HYPERLIQUID_MARGIN_MODE, 'isolated'),
    leverage,
    balanceUsagePct,
    balanceSafetyFactor: Math.min(1, Math.max(0.95, parseNumber(process.env.BALANCE_SAFETY_FACTOR, 0.995))),
    entryBufferPct: Math.max(0, parseNumber(process.env.ENTRY_BUFFER_PCT, 0.0001)),
    emergencySlPct: Math.max(0.0005, parseNumber(process.env.EMERGENCY_SL_PCT, 0.012)),
    timeoutMs: Math.max(15000, parseInteger(process.env.HYPERLIQUID_TIMEOUT_MS, 30000)),
    retryCount: Math.max(0, parseInteger(process.env.HYPERLIQUID_RETRY_COUNT, 3)),
    retryBaseDelayMs: Math.max(250, parseInteger(process.env.HYPERLIQUID_RETRY_BASE_DELAY_MS, 1000)),
    retryMaxDelayMs: Math.max(250, parseInteger(process.env.HYPERLIQUID_RETRY_MAX_DELAY_MS, 10000))
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  runtime: {
    scanIntervalMs: Math.max(3000, parseInteger(process.env.SCAN_INTERVAL_MS, 15000)),
    pendingCheckIntervalMs: Math.max(2000, parseInteger(process.env.PENDING_CHECK_INTERVAL_MS, 3000)),
    positionCheckIntervalMs: Math.max(2000, parseInteger(process.env.POSITION_CHECK_INTERVAL_MS, 3000)),
    reconcileIntervalMs: Math.max(10000, parseInteger(process.env.RECONCILE_INTERVAL_MS, 20000)),
    entryTimeoutMs: Math.max(5000, parseInteger(process.env.ENTRY_TIMEOUT_MS, 45000))
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
