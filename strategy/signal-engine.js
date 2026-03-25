import { CONFIG } from '../config.js';
import { roles } from '../timeframes.js';
import { getCandles } from '../services/binance.js';
import { getBB, getMACD, isBearishCross, isBullishCross, detectVolatilityExpansion } from './indicators.js';
import { buildSignalId, tpPrice } from '../lib/utils.js';

function toHyperliquidCoin(pair) {
  if (!pair.endsWith('USDT')) {
    throw new Error(`Unsupported pair ${pair}. Expected USDT pair.`);
  }

  return pair.slice(0, -4);
}

async function validateMACD(pair, direction, ihtf) {
  const candles = await getCandles(pair, ihtf);
  const macd = getMACD(candles.map((c) => c.close));

  const bullish = isBullishCross(macd);
  const bearish = isBearishCross(macd);

  if (direction === 'LONG' && bearish) return { confirmed: true, direction: 'SHORT' };
  if (direction === 'SHORT' && bullish) return { confirmed: true, direction: 'LONG' };
  if (direction === 'LONG' && bullish) return { confirmed: true, direction: 'LONG' };
  if (direction === 'SHORT' && bearish) return { confirmed: true, direction: 'SHORT' };

  return { confirmed: false, direction };
}

async function checkBTCAlignment(direction, ihtf) {
  const candles = await getCandles('BTCUSDT', ihtf);
  const macd = getMACD(candles.map((c) => c.close));

  if (direction === 'LONG') return isBullishCross(macd);
  if (direction === 'SHORT') return isBearishCross(macd);
  return false;
}

async function detectLeadership(pair, direction, ihtf) {
  const asset = await getCandles(pair, ihtf);
  const btc = await getCandles('BTCUSDT', ihtf);

  const assetMacd = getMACD(asset.map((c) => c.close));
  const btcMacd = getMACD(btc.map((c) => c.close));

  if (assetMacd.length < 2 || btcMacd.length < 2) return 'none';

  const a = assetMacd.at(-1);
  const b = btcMacd.at(-1);

  if (direction === 'LONG' && a.MACD > a.signal && b.MACD < b.signal) return 'asset_leading';
  if (direction === 'SHORT' && a.MACD < a.signal && b.MACD > b.signal) return 'asset_leading';

  return 'none';
}

export async function evaluateSignal(pair, baseTF) {
  if (!CONFIG.strategy.allowedPairs.includes(pair)) return null;
  if (!CONFIG.strategy.allowedTfs.includes(baseTF)) return null;

  const role = roles[baseTF];
  if (!role) return null;

  const baseCandles = await getCandles(pair, baseTF);
  if (baseCandles.length < 30) return null;

  const baseBbSeries = getBB(baseCandles.map((c) => c.close));
  const baseCandle = baseCandles.at(-2);
  const baseBB = baseBbSeries.at(-2);
  if (!baseCandle || !baseBB) return null;

  let direction = null;

  if (baseCandle.open > baseBB.upper && baseCandle.close > baseBB.upper) {
    direction = 'SHORT';
  }

  if (baseCandle.open < baseBB.lower && baseCandle.close < baseBB.lower) {
    direction = 'LONG';
  }

  if (!direction) return null;

  const ihtCandles = await getCandles(pair, role.iht);
  const ihtBbSeries = getBB(ihtCandles.map((c) => c.close));
  const ihtCandle = ihtCandles.at(-1);
  const ihtBB = ihtBbSeries.at(-1);
  if (!ihtCandle || !ihtBB) return null;

  const ihtConfirm =
    (direction === 'LONG' && ihtCandle.low <= ihtBB.lower) ||
    (direction === 'SHORT' && ihtCandle.high >= ihtBB.upper);

  if (!ihtConfirm) return null;

  const fibCandles = await getCandles(pair, role.fibtf);
  const fibBbSeries = getBB(fibCandles.map((c) => c.close));
  const fibCandle = fibCandles.at(-1);
  const fibBB = fibBbSeries.at(-1);
  if (!fibCandle || !fibBB) return null;

  const inside = fibCandle.high < fibBB.upper && fibCandle.low > fibBB.lower;
  if (!inside) return null;

  const duration = fibCandle.closeTime - fibCandle.openTime;
  const elapsed = baseCandle.closeTime - fibCandle.openTime;
  if (elapsed > duration * 0.35) return null;

  const macdCheck = await validateMACD(pair, direction, role.iht);
  if (!macdCheck.confirmed) return null;

  direction = macdCheck.direction;

  const btcAligned = await checkBTCAlignment(direction, role.iht);
  const lead = btcAligned ? 'btc_aligned' : await detectLeadership(pair, direction, role.iht);

  const targetPct = CONFIG.strategy.targetMap[baseTF];
  if (!targetPct) return null;

  const entryReference = baseCandle.close;
  const targetPrice = tpPrice(entryReference, direction, targetPct);

  return {
    signalId: buildSignalId(pair, baseTF, direction, baseCandle.closeTime),
    symbol: pair,
    hyperSymbol: toHyperliquidCoin(pair),
    side: direction,
    baseTf: baseTF,
    immediateTf: role.iht,
    structureTf: role.fibtf,
    entryReference,
    targetPct,
    targetPrice,
    baseCandleCloseTime: baseCandle.closeTime,
    strategy: 'bb_macd_binance_to_hyperliquid',
    meta: {
      btcAligned,
      lead,
      baseVolatilityExpansion: detectVolatilityExpansion(baseCandles),
      ihtVolatilityExpansion: detectVolatilityExpansion(ihtCandles)
    }
  };
}
