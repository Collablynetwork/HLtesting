import pairs from './pairs.js';
import { CONFIG } from './config.js';
import { FileStore } from './lib/file-store.js';
import { log, error } from './lib/logger.js';
import { HyperliquidService } from './services/hyperliquid.js';
import { evaluateSignal } from './strategy/signal-engine.js';
import { TradeRepo } from './trading/trade-repo.js';
import { TradeEngine } from './trading/trade-engine.js';

function makeSingleRunner(name, fn) {
  let running = false;

  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      error(`${name} failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
}

async function main() {
  const store = new FileStore(CONFIG.storage.path);
  store.load();

  const hyperliquid = new HyperliquidService();
  await hyperliquid.init();

  const repo = new TradeRepo(store);
  const tradeEngine = new TradeEngine({ hyperliquid, repo });

  const scanSignals = makeSingleRunner('scanSignals', async () => {
    for (const pair of pairs) {
      for (const tf of CONFIG.strategy.allowedTfs) {
        try {
          const signal = await evaluateSignal(pair, tf);
          if (signal) {
            await tradeEngine.onSignal(signal);
          }
        } catch (err) {
          error(`scanSignals failed for ${pair} ${tf}: ${err.message}`);
        }
      }
    }
  });

  const watchPendingEntries = makeSingleRunner('watchPendingEntries', () => tradeEngine.watchPendingEntries());
  const watchOpenPositions = makeSingleRunner('watchOpenPositions', () => tradeEngine.watchOpenPositions());
  const reconcile = makeSingleRunner('reconcile', () => tradeEngine.reconcile());

  await scanSignals();
  await watchPendingEntries();
  await watchOpenPositions();
  await reconcile();

  setInterval(scanSignals, CONFIG.runtime.scanIntervalMs);
  setInterval(watchPendingEntries, CONFIG.runtime.pendingCheckIntervalMs);
  setInterval(watchOpenPositions, CONFIG.runtime.positionCheckIntervalMs);
  setInterval(reconcile, CONFIG.runtime.reconcileIntervalMs);

  log(`Binance signal -> Hyperliquid execution bot started for pairs: ${pairs.join(', ')}`);
}

main().catch((err) => {
  error('Fatal startup error:', err.message);
  process.exit(1);
});
