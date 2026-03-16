import { CONFIG } from '../config.js';

export function computeOrderSize({ withdrawableBalance, entryPrice }) {
  const notional = Number(withdrawableBalance) * CONFIG.hyperliquid.balanceUsagePct * CONFIG.hyperliquid.leverage;

  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error('Invalid withdrawable balance for size calculation');
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Invalid entry price for size calculation');
  }

  const size = notional / entryPrice;

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Computed invalid order size');
  }

  return size;
}
