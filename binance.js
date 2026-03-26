import axios from 'axios';
import { CONFIG } from '../config.js';

const client = axios.create({
  baseURL: CONFIG.binance.baseUrl,
  timeout: CONFIG.binance.timeoutMs,
  headers: {
    'X-MBX-APIKEY': CONFIG.binance.apiKey
  }
});

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(err) {
  const status = Number(err?.response?.status || 0);
  return (
    err?.code === 'ECONNABORTED' ||
    err?.code === 'ETIMEDOUT' ||
    status === 429 ||
    status >= 500 ||
    /timeout/i.test(String(err?.message || '')) ||
    /network/i.test(String(err?.message || ''))
  );
}

async function withRetry(fn, { retries = 3, baseDelayMs = 1000, maxDelayMs = 10000 } = {}) {
  let lastErr;

  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === retries || !shouldRetry(err)) throw err;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (i + 1));
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

export async function getCandles(symbol, interval, limit = 60) {
  const { data } = await withRetry(() => client.get('/fapi/v1/klines', {
    params: { symbol, interval, limit }
  }));

  return data.map((c) => ({
    openTime: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    closeTime: c[6]
  }));
}

export async function getCurrentPrice(symbol) {
  const { data } = await withRetry(() => client.get('/fapi/v1/ticker/price', {
    params: { symbol }
  }));

  return Number(data.price);
}
