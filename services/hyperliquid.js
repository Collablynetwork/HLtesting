import axios from 'axios';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../config.js';
import { clampNumber, stripTrailingZeros } from '../lib/utils.js';
import { warn } from '../lib/logger.js';

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

async function withRetry(fn, {
  retries = CONFIG.hyperliquid.retryCount,
  baseDelayMs = CONFIG.hyperliquid.retryBaseDelayMs,
  maxDelayMs = CONFIG.hyperliquid.retryMaxDelayMs,
  shouldRetry = (err) => {
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
} = {}) {
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
      timeout: CONFIG.hyperliquid.timeoutMs,
      headers: { 'Content-Type': 'application/json' }
    });
    this.transport = new HttpTransport({ url: TRANSPORT_URL });
    this.wallet = privateKeyToAccount(CONFIG.hyperliquid.privateKey);
    this.exchange = new ExchangeClient({ transport: this.transport, wallet: this.wallet });
    this.walletAddress = CONFIG.hyperliquid.walletAddress;
    this.assetMap = new Map();
    this.maxLeverageByCoin = new Map();
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
        szDecimals: Number(item.szDecimals || 0),
        maxLeverage: Number(item.maxLeverage || item.maxLev || 0),
        onlyIsolated: Boolean(item.onlyIsolated),
        marginMode: item.marginMode || null
      });

      const maxLev = Number(item.maxLeverage || item.maxLev || 0);
      if (Number.isFinite(maxLev) && maxLev > 0) {
        this.maxLeverageByCoin.set(item.name, maxLev);
      }
    });
  }

  getAssetInfo(coin) {
    const info = this.assetMap.get(coin);
    if (!info) {
      throw new Error(`Hyperliquid asset not found for ${coin}`);
    }
    return info;
  }

  getMaxLeverage(coin) {
    const fromMap = this.maxLeverageByCoin.get(coin);
    if (Number.isFinite(fromMap) && fromMap >= 1) return fromMap;
    return CONFIG.hyperliquid.leverage;
  }

  resolveLeverageSettings(coin, requestedLeverage) {
    const info = this.getAssetInfo(coin);
    const lev = Number(requestedLeverage);

    if (!Number.isInteger(lev) || lev < 1) {
      throw new Error(`Invalid leverage value: ${requestedLeverage}`);
    }

    const maxLeverage = this.getMaxLeverage(coin);
    const leverage = Math.min(lev, maxLeverage);
    const exchangeRequiresIsolated = (
      info.onlyIsolated ||
      info.marginMode === 'strictIsolated' ||
      info.marginMode === 'noCross'
    );
    const requestedMode = CONFIG.hyperliquid.marginMode;
    const isCross = requestedMode === 'cross' && !exchangeRequiresIsolated;

    return {
      leverage,
      isCross,
      maxLeverage,
      requestedLeverage: lev,
      requestedMode,
      exchangeRequiresIsolated
    };
  }

  roundSize(coin, size) {
    const { szDecimals } = this.getAssetInfo(coin);
    const rounded = clampNumber(size).toFixed(szDecimals);
    return stripTrailingZeros(rounded);
  }

  roundPrice(coin, price) {
    const { szDecimals } = this.getAssetInfo(coin);
    const maxDecimals = Math.max(0, 6 - szDecimals);
    const rounded = clampNumber(price).toFixed(maxDecimals);
    return stripTrailingZeros(rounded);
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
    const leverageSettings = this.resolveLeverageSettings(coin, requestedLeverage);

    if (leverageSettings.leverage !== leverageSettings.requestedLeverage) {
      warn(
        `Clamping leverage for ${coin} from ${leverageSettings.requestedLeverage}x ` +
        `to ${leverageSettings.leverage}x (exchange max ${leverageSettings.maxLeverage}x).`
      );
    }

    if (!leverageSettings.isCross) {
      const reason = leverageSettings.exchangeRequiresIsolated
        ? 'cross margin is not allowed by exchange metadata'
        : 'configured margin mode is isolated';
      warn(`Using isolated margin for ${coin} because ${reason}.`);
    }

    const response = await withRetry(async () => {
      return this.exchange.updateLeverage({
        asset,
        isCross: leverageSettings.isCross,
        leverage: leverageSettings.leverage
      });
    });

    return {
      ...response,
      leverage: leverageSettings.leverage,
      isCross: leverageSettings.isCross,
      maxLeverage: leverageSettings.maxLeverage,
      requestedLeverage: leverageSettings.requestedLeverage
    };
  }

  async placeLimitOrder({ coin, side, size, price, reduceOnly = false, tif = 'Gtc', cloid }) {
    const { asset } = this.getAssetInfo(coin);

    const roundedPrice = this.roundPrice(coin, price);
    const roundedSize = this.roundSize(coin, size);

    if (!roundedPrice || Number(roundedPrice) <= 0) {
      throw new Error(`Invalid rounded price for ${coin}`);
    }

    if (!roundedSize || Number(roundedSize) <= 0) {
      throw new Error(`Invalid rounded size for ${coin}`);
    }

    return withRetry(async () => {
      return this.exchange.order({
        orders: [{
          a: asset,
          b: side === 'LONG',
          p: roundedPrice,
          s: roundedSize,
          r: reduceOnly,
          t: { limit: { tif } },
          ...(cloid ? { c: cloid } : {})
        }],
        grouping: 'na'
      });
    });
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
