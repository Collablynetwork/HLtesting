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

export class HyperliquidService {
  constructor() {
    if (!CONFIG.hyperliquid.privateKey) {
      throw new Error('Missing HYPERLIQUID_PRIVATE_KEY in .env');
    }

    if (!CONFIG.hyperliquid.walletAddress) {
      throw new Error('Missing HYPERLIQUID_MAIN_ADDRESS in .env');
    }

    this.infoUrl = CONFIG.hyperliquid.testnet ? TESTNET_INFO_URL : MAINNET_INFO_URL;
    this.http = axios.create({ timeout: 15000 });
    this.transport = new HttpTransport({ url: TRANSPORT_URL });
    this.wallet = privateKeyToAccount(CONFIG.hyperliquid.privateKey);
    this.exchange = new ExchangeClient({ transport: this.transport, wallet: this.wallet });
    this.walletAddress = CONFIG.hyperliquid.walletAddress;
    this.assetMap = new Map();
  }

  async postInfo(body) {
    const { data } = await this.http.post(this.infoUrl, body, {
      headers: { 'Content-Type': 'application/json' }
    });
    return data;
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
    return Number(value);
  }

  async getUserState() {
    return this.postInfo({ type: 'clearinghouseState', user: this.walletAddress });
  }

  async getWithdrawableBalance() {
    const state = await this.getUserState();
    return Number(state?.withdrawable || 0);
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

  async updateLeverage(coin, leverage) {
    const { asset } = this.getAssetInfo(coin);
    return this.exchange.updateLeverage({
      asset,
      isCross: true,
      leverage
    });
  }

  async placeLimitOrder({ coin, side, size, price, reduceOnly = false, tif = 'Gtc', cloid }) {
    const { asset } = this.getAssetInfo(coin);

    return this.exchange.order({
      orders: [{
        a: asset,
        b: side === 'LONG',
        p: this.roundPrice(coin, price),
        s: this.roundSize(coin, size),
        r: reduceOnly,
        t: { limit: { tif } },
        ...(cloid ? { c: cloid } : {})
      }],
      grouping: 'na'
    });
  }

  async cancelByCloid(coin, cloid) {
    const { asset } = this.getAssetInfo(coin);
    return this.exchange.cancelByCloid({
      cancels: [{ asset, cloid }]
    });
  }

  async safeCancelByCloid(coin, cloid) {
    if (!cloid) return null;

    try {
      return await this.cancelByCloid(coin, cloid);
    } catch (err) {
      const message = String(err?.message || err || '');
      if (message.toLowerCase().includes('unknown') || message.toLowerCase().includes('filled')) {
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
