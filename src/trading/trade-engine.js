import { CONFIG } from '../config.js';
import { getCandles } from '../services/binance.js';
import { sendTelegram } from '../services/telegram.js';
import { getBB } from '../strategy/indicators.js';
import { computeOrderSize } from './risk-manager.js';
import {
  buildSignalKey,
  closeSideForPosition,
  emergencySlPrice,
  generateCloid,
  safeJson,
  tpPrice
} from '../lib/utils.js';
import { roles } from '../timeframes.js';
import { log, warn } from '../lib/logger.js';

export class TradeEngine {
  constructor({ hyperliquid, repo }) {
    this.hyperliquid = hyperliquid;
    this.repo = repo;
    this.inFlightSymbols = new Set();
  }

  pruneSignalHistory() {
    const cutoff = Date.now() - CONFIG.strategy.dedupeRetentionMs;
    this.repo.pruneProcessedSignals(cutoff);
  }

  async onSignal(signal) {
    if (!signal) return;
    if (!CONFIG.strategy.allowedPairs.includes(signal.symbol)) return;

    const signalKey = buildSignalKey(signal);
    if (this.repo.isSignalProcessed(signalKey)) return;
    if (this.inFlightSymbols.has(signal.symbol)) return;
    if (this.repo.hasActiveForSymbol(signal.symbol)) return;

    this.inFlightSymbols.add(signal.symbol);

    try {
      this.pruneSignalHistory();
      this.repo.markProcessedSignal(signalKey);
      this.repo.markSignalSeen(signal.signalId);

      const existingPosition = await this.hyperliquid.getPosition(signal.hyperSymbol);
      if (existingPosition && Math.abs(existingPosition.szi) > 0) {
        warn(`Skipping ${signal.symbol} ${signal.baseTf}; position already open on Hyperliquid.`);
        return;
      }

      const leverageUpdate = await this.hyperliquid.updateLeverage(
        signal.hyperSymbol,
        CONFIG.hyperliquid.leverage
      );
      const appliedLeverage = Number(leverageUpdate?.leverage || CONFIG.hyperliquid.leverage);
      const leverageMode = leverageUpdate?.isCross === false ? 'isolated' : 'cross';

      const mid = await this.hyperliquid.getMidPrice(signal.hyperSymbol);
      const rawEntryPrice = signal.side === 'LONG'
        ? mid * (1 + CONFIG.hyperliquid.entryBufferPct)
        : mid * (1 - CONFIG.hyperliquid.entryBufferPct);
      const entryPrice = Number(this.hyperliquid.roundPrice(signal.hyperSymbol, rawEntryPrice));

      const withdrawableBalance = await this.hyperliquid.getWithdrawableBalance();
      const rawSize = computeOrderSize({
        withdrawableBalance,
        entryPrice,
        leverage: appliedLeverage
      });
      const roundedSize = Number(this.hyperliquid.roundSize(signal.hyperSymbol, rawSize));

      if (!Number.isFinite(roundedSize) || roundedSize <= 0) {
        throw new Error(`Rounded size became invalid for ${signal.symbol}`);
      }

      const entryCloid = generateCloid('entry');
      const currentTargetPrice = Number(this.hyperliquid.roundPrice(
        signal.hyperSymbol,
        tpPrice(entryPrice, signal.side, signal.targetPct)
      ));
      const emergencySl = Number(this.hyperliquid.roundPrice(
        signal.hyperSymbol,
        emergencySlPrice(entryPrice, signal.side, CONFIG.hyperliquid.emergencySlPct)
      ));

      const orderResult = await this.hyperliquid.placeLimitOrder({
        coin: signal.hyperSymbol,
        side: signal.side,
        size: roundedSize,
        price: entryPrice,
        reduceOnly: false,
        tif: 'Gtc',
        cloid: entryCloid
      });

      const messageId = await sendTelegram([
        '🚨 NEW SIGNAL EXECUTED ON HYPERLIQUID',
        `Pair: ${signal.symbol}`,
        `Direction: ${signal.side}`,
        `Base TF: ${signal.baseTf}`,
        `Entry Order: ${entryCloid}`,
        `Entry Price: ${entryPrice}`,
        `Target Price: ${currentTargetPrice}`,
        `Emergency SL: ${emergencySl}`,
        `Use Balance: ${CONFIG.hyperliquid.balanceUsagePct * 100}%`,
        `Leverage: ${appliedLeverage}x (${leverageMode})`
      ].join('\n'));

      this.repo.upsert({
        ...signal,
        signalKey,
        status: 'PENDING_ENTRY',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryPrice,
        targetPrice: currentTargetPrice,
        emergencySl,
        requestedSize: roundedSize,
        entryCloid,
        entryResponse: orderResult,
        tpCloid: null,
        messageId,
        fillPrice: null,
        filledSize: 0,
        leverage: appliedLeverage,
        leverageMode,
        slActivatedAt: null,
        slPrice: null,
        exitReason: null
      });

      log(`Pending entry created for ${signal.symbol} ${signal.baseTf}`);
    } catch (err) {
      this.repo.unmarkProcessedSignal(signalKey);
      throw err;
    } finally {
      this.inFlightSymbols.delete(signal.symbol);
    }
  }

  async watchPendingEntries() {
    const trades = this.repo.all().filter((t) => t.status === 'PENDING_ENTRY');
    if (!trades.length) return;

    const openOrders = await this.hyperliquid.getOpenOrders();

    for (const trade of trades) {
      try {
        const now = Date.now();
        const currentMid = await this.hyperliquid.getMidPrice(trade.hyperSymbol);
        const targetReachedBeforeFill =
          (trade.side === 'LONG' && currentMid >= trade.targetPrice) ||
          (trade.side === 'SHORT' && currentMid <= trade.targetPrice);

        const position = await this.hyperliquid.getPosition(trade.hyperSymbol);
        const openOrder = this.hyperliquid.findOpenOrderByCloid(openOrders, trade.hyperSymbol, trade.entryCloid);
        const liveSize = Math.abs(Number(position?.szi || 0));
        const hasPosition = liveSize > 0;

        if (hasPosition) {
          const fillPrice = Number(position?.entryPx || trade.entryPrice);
          const filledSize = liveSize;
          const tpCloid = generateCloid('tp');

          await this.hyperliquid.placeLimitOrder({
            coin: trade.hyperSymbol,
            side: closeSideForPosition(trade.side),
            size: filledSize,
            price: trade.targetPrice,
            reduceOnly: true,
            tif: 'Gtc',
            cloid: tpCloid
          });

          trade.status = 'OPEN_POSITION';
          trade.updatedAt = now;
          trade.fillPrice = fillPrice;
          trade.filledSize = filledSize;
          trade.tpCloid = tpCloid;
          this.repo.upsert(trade);

          await sendTelegram([
            '✅ ENTRY FILLED',
            `Pair: ${trade.symbol}`,
            `Direction: ${trade.side}`,
            `Filled Size: ${filledSize}`,
            `Fill Price: ${fillPrice}`,
            `TP Order: ${tpCloid}`,
            `TP Price: ${trade.targetPrice}`
          ].join('\n'), trade.messageId);
          continue;
        }

        if (targetReachedBeforeFill) {
          await this.hyperliquid.safeCancelByCloid(trade.hyperSymbol, trade.entryCloid);
          trade.status = 'CANCELLED_TARGET_BEFORE_FILL';
          trade.updatedAt = now;
          trade.exitReason = 'TARGET_TOUCHED_BEFORE_ENTRY_FILL';
          this.repo.upsert(trade);
          await sendTelegram(
            `⚠️ Entry cancelled before fill because target was already touched\nPair: ${trade.symbol}\nBase TF: ${trade.baseTf}`,
            trade.messageId
          );
          this.repo.remove(trade.symbol, trade.baseTf);
          continue;
        }

        if (now - trade.createdAt > CONFIG.runtime.entryTimeoutMs) {
          await this.hyperliquid.safeCancelByCloid(trade.hyperSymbol, trade.entryCloid);
          trade.status = 'CANCELLED_TIMEOUT';
          trade.updatedAt = now;
          trade.exitReason = 'ENTRY_TIMEOUT';
          this.repo.upsert(trade);
          await sendTelegram(
            `⌛ Entry cancelled because it timed out\nPair: ${trade.symbol}\nBase TF: ${trade.baseTf}`,
            trade.messageId
          );
          this.repo.remove(trade.symbol, trade.baseTf);
          continue;
        }

        if (!openOrder && !hasPosition) {
          warn(`Pending entry missing from open orders and no live position for ${trade.symbol}; removing as rejected/cancelled.`);
          trade.status = 'ENTRY_NOT_LIVE';
          trade.updatedAt = now;
          trade.exitReason = 'ENTRY_NOT_FOUND_ON_EXCHANGE';
          this.repo.upsert(trade);
          this.repo.remove(trade.symbol, trade.baseTf);
        }
      } catch (err) {
        warn(`watchPendingEntries error for ${trade.symbol}: ${err.message}`);
      }
    }
  }

  async checkAndActivateSL(trade) {
    if (trade.slActivatedAt) return trade;

    const role = roles[trade.baseTf];
    if (!role) return trade;

    const candles = await getCandles(trade.symbol, role.fibtf);
    const closed = candles.at(-2);
    const bb = getBB(candles.map((c) => c.close)).at(-2);
    if (!closed || !bb) return trade;

    const shouldActivate =
      (trade.side === 'LONG' && closed.low <= bb.lower) ||
      (trade.side === 'SHORT' && closed.high >= bb.upper);

    if (!shouldActivate) return trade;

    trade.slActivatedAt = Date.now();
    trade.slPrice = closed.close;
    trade.status = 'SL_ARMED';
    trade.updatedAt = Date.now();
    this.repo.upsert(trade);

    await sendTelegram([
      '⚠️ STRATEGY SL ACTIVATED',
      `Pair: ${trade.symbol}`,
      `Direction: ${trade.side}`,
      `Base TF: ${trade.baseTf}`,
      `SL Price: ${trade.slPrice}`
    ].join('\n'), trade.messageId);

    return trade;
  }

  async closeTrade(trade, reason) {
    const position = await this.hyperliquid.getPosition(trade.hyperSymbol);
    const size = Math.abs(Number(position?.szi || trade.filledSize || trade.requestedSize || 0));

    if (trade.tpCloid) {
      await this.hyperliquid.safeCancelByCloid(trade.hyperSymbol, trade.tpCloid);
    }

    if (size > 0) {
      await this.hyperliquid.closePositionMarketish({
        coin: trade.hyperSymbol,
        side: trade.side,
        size
      });
    }

    trade.status = reason;
    trade.exitReason = reason;
    trade.updatedAt = Date.now();
    this.repo.upsert(trade);

    await sendTelegram([
      reason === 'EXITED_TP' ? '✅ TARGET HIT' : '❌ STOP LOSS HIT',
      `Pair: ${trade.symbol}`,
      `Direction: ${trade.side}`,
      `Base TF: ${trade.baseTf}`
    ].join('\n'), trade.messageId);

    this.repo.remove(trade.symbol, trade.baseTf);
  }

  async watchOpenPositions() {
    const trades = this.repo.all().filter((t) => ['OPEN_POSITION', 'SL_ARMED'].includes(t.status));

    for (let trade of trades) {
      try {
        trade = await this.checkAndActivateSL(trade);

        const currentMid = await this.hyperliquid.getMidPrice(trade.hyperSymbol);
        const tpHit =
          (trade.side === 'LONG' && currentMid >= trade.targetPrice) ||
          (trade.side === 'SHORT' && currentMid <= trade.targetPrice);

        if (tpHit) {
          await this.closeTrade(trade, 'EXITED_TP');
          continue;
        }

        const hardEmergencyHit =
          (trade.side === 'LONG' && currentMid <= trade.emergencySl) ||
          (trade.side === 'SHORT' && currentMid >= trade.emergencySl);

        if (hardEmergencyHit) {
          await this.closeTrade(trade, 'EXITED_EMERGENCY_SL');
          continue;
        }

        if (trade.slPrice) {
          const strategySlHit =
            (trade.side === 'LONG' && currentMid <= trade.slPrice) ||
            (trade.side === 'SHORT' && currentMid >= trade.slPrice);

          if (strategySlHit) {
            await this.closeTrade(trade, 'EXITED_STRATEGY_SL');
            continue;
          }
        }
      } catch (err) {
        warn(`watchOpenPositions error for ${trade.symbol}: ${err.message}`);
      }
    }
  }

  async reconcile() {
    this.pruneSignalHistory();
    const trades = this.repo.all();
    if (!trades.length) return;

    const openOrders = await this.hyperliquid.getOpenOrders();

    for (const trade of trades) {
      try {
        const position = await this.hyperliquid.getPosition(trade.hyperSymbol);
        const hasPosition = position && Math.abs(Number(position.szi || 0)) > 0;
        const openForCoin = openOrders.some((o) => (o.coin || o.assetName || o.name) === trade.hyperSymbol);

        if (trade.status === 'PENDING_ENTRY' && !openForCoin && !hasPosition) {
          warn(`Removing orphaned pending trade ${trade.symbol} ${trade.baseTf}`);
          this.repo.remove(trade.symbol, trade.baseTf);
        }

        if (['OPEN_POSITION', 'SL_ARMED'].includes(trade.status) && !hasPosition) {
          warn(`Removing orphaned open trade ${trade.symbol} ${trade.baseTf}`);
          this.repo.remove(trade.symbol, trade.baseTf);
        }
      } catch (err) {
        warn(`reconcile error for ${trade.symbol}: ${err.message}; raw=${safeJson(err)}`);
      }
    }
  }
}
