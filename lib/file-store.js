import fs from 'node:fs';
import path from 'node:path';

export class FileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      trades: {},
      signalTimes: {},
      processedSignals: {}
    };
  }

  ensureShape() {
    this.state ||= {};
    this.state.trades ||= {};
    this.state.signalTimes ||= {};
    this.state.processedSignals ||= {};
    return this.state;
  }

  load() {
    const full = path.resolve(this.filePath);
    const dir = path.dirname(full);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(full)) {
      this.ensureShape();
      fs.writeFileSync(full, JSON.stringify(this.state, null, 2));
      return this.state;
    }

    const raw = fs.readFileSync(full, 'utf8');
    this.state = raw ? JSON.parse(raw) : {};
    return this.ensureShape();
  }

  save() {
    this.ensureShape();
    const full = path.resolve(this.filePath);
    fs.writeFileSync(full, JSON.stringify(this.state, null, 2));
  }

  getTrade(key) {
    return this.ensureShape().trades[key] || null;
  }

  getTrades() {
    return Object.values(this.ensureShape().trades);
  }

  setTrade(key, trade) {
    this.ensureShape().trades[key] = trade;
    this.save();
  }

  deleteTrade(key) {
    delete this.ensureShape().trades[key];
    this.save();
  }

  markSignalTime(key, value = Date.now()) {
    this.ensureShape().signalTimes[key] = value;
    this.save();
  }

  getSignalTime(key) {
    return this.ensureShape().signalTimes[key] || 0;
  }

  markProcessedSignal(key, value = Date.now()) {
    this.ensureShape().processedSignals[key] = value;
    this.save();
  }

  getProcessedSignalTime(key) {
    return this.ensureShape().processedSignals[key] || 0;
  }

  deleteProcessedSignal(key) {
    delete this.ensureShape().processedSignals[key];
    this.save();
  }

  pruneProcessedSignals(beforeTs) {
    const state = this.ensureShape();
    let changed = false;

    for (const [key, ts] of Object.entries(state.processedSignals)) {
      if (Number(ts) < beforeTs) {
        delete state.processedSignals[key];
        changed = true;
      }
    }

    if (changed) {
      this.save();
    }
  }
}
