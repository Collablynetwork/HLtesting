import { CONFIG } from '../config.js';

export function computeOrderSize({ withdrawableBalance, entryPrice, leverage = CONFIG.hyperliquid.leverage }) {
  const availableBalance = Number(withdrawableBalance);
  const appliedLeverage = Number(leverage);

  if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
    throw new Error('Invalid available balance for size calculation');
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Invalid entry price for size calculation');
  }

  if (!Number.isFinite(appliedLeverage) || appliedLeverage <= 0) {
    throw new Error('Invalid leverage for size calculation');
  }

  const usableBalance =
    availableBalance *
    CONFIG.hyperliquid.balanceUsagePct *
    CONFIG.hyperliquid.balanceSafetyFactor;

  const notional = usableBalance * appliedLeverage;

  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error('Invalid notional for size calculation');
  }

  const size = notional / entryPrice;

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Computed invalid order size');
  }

  return size;
}
