export class TradeRepo {
  constructor(store) {
    this.store = store;
  }

  tradeKey(symbol, baseTf) {
    return `${symbol}_${baseTf}`;
  }

  all() {
    return this.store.getTrades();
  }

  get(symbol, baseTf) {
    return this.store.getTrade(this.tradeKey(symbol, baseTf));
  }

  upsert(trade) {
    this.store.setTrade(this.tradeKey(trade.symbol, trade.baseTf), trade);
  }

  remove(symbol, baseTf) {
    this.store.deleteTrade(this.tradeKey(symbol, baseTf));
  }

  hasActiveForSymbol(symbol) {
    return this.all().some((trade) => {
      if (trade.symbol !== symbol) return false;
      return ['PENDING_ENTRY', 'PARTIALLY_FILLED', 'OPEN_POSITION', 'SL_ARMED'].includes(trade.status);
    });
  }

  markSignalSeen(signalId) {
    this.store.markSignalTime(signalId);
  }

  lastSignalTime(signalId) {
    return this.store.getSignalTime(signalId);
  }

  markProcessedSignal(signalKey) {
    this.store.markProcessedSignal(signalKey);
  }

  unmarkProcessedSignal(signalKey) {
    this.store.deleteProcessedSignal(signalKey);
  }

  isSignalProcessed(signalKey) {
    return this.store.getProcessedSignalTime(signalKey) > 0;
  }

  pruneProcessedSignals(beforeTs) {
    this.store.pruneProcessedSignals(beforeTs);
  }
}
