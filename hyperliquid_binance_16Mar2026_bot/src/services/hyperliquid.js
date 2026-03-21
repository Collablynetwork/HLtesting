import axios from 'axios';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../config.js';
import { clampNumber, stripTrailingZeros } from '../lib/utils.js';

const MAINNET_INFO_URL = 'https://api.hyperliquid.xyz/info';
const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
const TRANSPORT_URL = CONFIG.hyperliquid.testnet
  ? 'https://api.hyperliquid-testnet.xyz'
  : 'https://api.hyperliquid.xyz';

function toNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(err) {
  const status = err?.response?.status;
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '').toLowerCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    msg.includes('eai_again') ||
    msg.includes('getaddrinfo') ||
    msg.includes('temporary failure in name resolution') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('socket hang up')
  );
}

async function withRetry(fn, { retries = 5, baseDelayMs = 800, maxDelayMs = 7000 } = {}) {
  let lastErr;

  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || i === retries) throw err;
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = Math.min(baseDelayMs * (2 ** i) + jitterMs, maxDelayMs);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

export class HyperliquidService {
  constructor() {
    if (!CONFIG.hyperliquid.privateKey) {
      throw new Error('Missing HYPERLIQUID_PRIVATE_KEY in .env');
    }

    if (!CONFIG.hyperliquid.walletAddress) {
      throw new Error('Missing HYPERLIQUID_MAIN_ADDRESS in .env');
    }

    this.infoUrl = CONFIG.hyperliquid.testnet ? TESTNET_INFO_URL : MAINNET_INFO_URL;
    this.http = axios.create({
      timeout: Math.max(5000, Number(CONFIG.hyperliquid.timeoutMs || 15000)),
      headers: { 'Content-Type': 'application/json' }
    });
    this.transport = new HttpTransport({ url: TRANSPORT_URL });
    this.wallet = privateKeyToAccount(CONFIG.hyperliquid.privateKey);
    this.exchange = new ExchangeClient({ transport: this.transport, wallet: this.wallet });
    this.walletAddress = CONFIG.hyperliquid.walletAddress;
    this.assetMap = new Map();
  }

  async postInfo(body) {
    return withRetry(async () => {
      const { data } = await this.http.post(this.infoUrl, body);
      return data;
    });
  }

  async init() {
    const meta = await this.postInfo({ type: 'meta' });
    const universe = meta?.universe || [];

    universe.forEach((item, index) => {
      this.assetMap.set(item.name, {
        asset: index,
        name: item.name,
        szDecimals: Number(item.szDecimals || 0)
      });
    });
  }

  getAssetInfo(coin) {
    const info = this.assetMap.get(coin);
    if (!info) {
      throw new Error(`Hyperliquid asset not found for ${coin}`);
    }
    return info;
  }

  roundSize(coin, size) {
    const { szDecimals } = this.getAssetInfo(coin);
    const rounded = clampNumber(size).toFixed(szDecimals);
    return stripTrailingZeros(rounded);
  }

  roundPrice(coin, price, mode = 'nearest') {
    const { szDecimals } = this.getAssetInfo(coin);
    const maxDecimals = Math.max(0, 6 - szDecimals);

    let n = clampNumber(price);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid raw price for ${coin}`);
    }

    if (Number.isInteger(n)) {
      return String(Math.trunc(n));
    }

    // Hyperliquid perp price rule: <= 5 significant figures and <= (6 - szDecimals) decimals.
    n = Number(n.toPrecision(5));

    const factor = 10 ** maxDecimals;
    const scaled = n * factor;
    let adjusted;

    if (mode === 'up') {
      adjusted = Math.ceil(scaled - 1e-12) / factor;
    } else if (mode === 'down') {
      adjusted = Math.floor(scaled + 1e-12) / factor;
    } else {
      adjusted = Math.round(scaled) / factor;
    }

    if (!Number.isFinite(adjusted) || adjusted <= 0) {
      adjusted = Math.max(1 / factor, Number(n.toFixed(maxDecimals)));
    }

    if (!Number.isInteger(adjusted)) {
      adjusted = Number(adjusted.toPrecision(5));
      const rescaled = adjusted * factor;
      if (mode === 'up') {
        adjusted = Math.ceil(rescaled - 1e-12) / factor;
      } else if (mode === 'down') {
        adjusted = Math.floor(rescaled + 1e-12) / factor;
      } else {
        adjusted = Math.round(rescaled) / factor;
      }
    }

    return stripTrailingZeros(adjusted.toFixed(maxDecimals));
  }

  async allMids() {
    return this.postInfo({ type: 'allMids' });
  }

  async getMidPrice(coin) {
    const mids = await this.allMids();
    const value = mids?.[coin];
    if (value == null) {
      throw new Error(`Mid price unavailable for ${coin}`);
    }

    const mid = Number(value);
    if (!Number.isFinite(mid) || mid <= 0) {
      throw new Error(`Invalid mid price for ${coin}`);
    }

    return mid;
  }

  async getUserState() {
    return this.postInfo({ type: 'clearinghouseState', user: this.walletAddress });
  }

  extractAvailableBalance(userState) {
    const candidates = [
      userState?.withdrawable,
      userState?.marginSummary?.withdrawable,
      userState?.crossMarginSummary?.withdrawable,
      userState?.marginSummary?.accountValue,
      userState?.crossMarginSummary?.accountValue
    ];

    for (const candidate of candidates) {
      const n = toNum(candidate);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return NaN;
  }

  async getWithdrawableBalance() {
    const state = await this.getUserState();
    const available = this.extractAvailableBalance(state);

    if (!Number.isFinite(available) || available <= 0) {
      throw new Error(
        'Invalid available balance for size calculation. ' +
        'Check HYPERLIQUID_MAIN_ADDRESS, wallet funding, and account mode.'
      );
    }

    return available;
  }

  async getPosition(coin) {
    const state = await this.getUserState();
    const positions = state?.assetPositions || [];

    for (const row of positions) {
      const pos = row.position || row;
      if (pos.coin === coin) {
        return {
          coin,
          szi: Number(pos.szi || 0),
          entryPx: Number(pos.entryPx || 0),
          leverage: Number(pos.leverage?.value || 0),
          unrealizedPnl: Number(pos.unrealizedPnl || 0),
          raw: row
        };
      }
    }

    return null;
  }

  async getOpenOrders() {
    const orders = await this.postInfo({ type: 'openOrders', user: this.walletAddress });
    return Array.isArray(orders) ? orders : [];
  }

  findOpenOrderByCloid(openOrders, coin, cloid) {
    return openOrders.find((o) => {
      const orderCoin = o.coin || o.assetName || o.name;
      const orderCloid = o.cloid || o.order?.cloid || o.clientOrderId;
      return orderCoin === coin && orderCloid === cloid;
    }) || null;
  }

  async updateLeverage(coin, requestedLeverage) {
    const { asset } = this.getAssetInfo(coin);

    const leverage = Number(requestedLeverage);
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error(`Invalid leverage value: ${requestedLeverage}`);
    }

    return withRetry(async () => {
      return this.exchange.updateLeverage({
        asset,
        isCross: true,
        leverage
      });
    });
  }

  async placeLimitOrder({ coin, side, size, price, reduceOnly = false, tif = 'Gtc', cloid }) {
    const { asset } = this.getAssetInfo(coin);

    const sideMode = side === 'LONG' ? 'up' : 'down';
    const roundedPrice = this.roundPrice(coin, price, sideMode);
    const roundedSize = this.roundSize(coin, size);

    if (!roundedPrice || Number(roundedPrice) <= 0) {
      throw new Error(`Invalid rounded price for ${coin}`);
    }

    if (!roundedSize || Number(roundedSize) <= 0) {
      throw new Error(`Invalid rounded size for ${coin}`);
    }

    const submit = (px) => {
      return this.exchange.order({
        orders: [{
          a: asset,
          b: side === 'LONG',
          p: px,
          s: roundedSize,
          r: reduceOnly,
          t: { limit: { tif } },
          ...(cloid ? { c: cloid } : {})
        }],
        grouping: 'na'
      });
    };

    try {
      return await withRetry(() => submit(roundedPrice));
    } catch (err) {
      const message = String(err?.message || '');
      if (!/tick size|divisible/i.test(message)) throw err;

      const fallbackMode = side === 'LONG' ? 'down' : 'up';
      const fallbackPrice = this.roundPrice(coin, price, fallbackMode);
      if (fallbackPrice === roundedPrice) throw err;

      return withRetry(() => submit(fallbackPrice));
    }
  }

  async cancelByCloid(coin, cloid) {
    const { asset } = this.getAssetInfo(coin);

    return withRetry(async () => {
      return this.exchange.cancelByCloid({
        cancels: [{ asset, cloid }]
      });
    });
  }

  async safeCancelByCloid(coin, cloid) {
    if (!cloid) return null;

    try {
      return await this.cancelByCloid(coin, cloid);
    } catch (err) {
      const message = String(err?.message || err || '').toLowerCase();
      if (
        message.includes('unknown') ||
        message.includes('filled') ||
        message.includes('does not exist') ||
        message.includes('already')
      ) {
        return null;
      }
      throw err;
    }
  }

  async closePositionMarketish({ coin, side, size }) {
    const mid = await this.getMidPrice(coin);
    const aggressivePrice = side === 'LONG' ? mid * 0.995 : mid * 1.005;

    return this.placeLimitOrder({
      coin,
      side: side === 'LONG' ? 'SHORT' : 'LONG',
      size,
      price: aggressivePrice,
      reduceOnly: true,
      tif: 'Ioc'
    });
  }
}
