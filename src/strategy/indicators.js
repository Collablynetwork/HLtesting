import { BollingerBands, MACD } from 'technicalindicators';
import { CONFIG } from '../config.js';

export function getBB(closes) {
  return BollingerBands.calculate({
    period: CONFIG.strategy.bb.period,
    stdDev: CONFIG.strategy.bb.stdDev,
    values: closes
  });
}

export function getMACD(closes) {
  return MACD.calculate({
    values: closes,
    fastPeriod: CONFIG.strategy.macd.fast,
    slowPeriod: CONFIG.strategy.macd.slow,
    signalPeriod: CONFIG.strategy.macd.signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
}

export function isBullishCross(macd) {
  if (macd.length < 2) return false;
  const prev = macd.at(-2);
  const last = macd.at(-1);

  return prev.MACD < prev.signal && last.MACD > last.signal && last.MACD > 0;
}

export function isBearishCross(macd) {
  if (macd.length < 2) return false;
  const prev = macd.at(-2);
  const last = macd.at(-1);

  return prev.MACD > prev.signal && last.MACD < last.signal && last.MACD < 0;
}

export function detectVolatilityExpansion(candles) {
  const closes = candles.map((c) => c.close);
  const bb = getBB(closes);

  if (bb.length < 25) return false;

  const widths = bb.map((b) => b.upper - b.lower);
  const currentWidth = widths.at(-2);
  const prev = widths.slice(-22, -2);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;

  return currentWidth > avg * 1.1;
}
