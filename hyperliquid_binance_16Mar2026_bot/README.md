# Binance Signal -> Hyperliquid Execution Bot

This bot reads long/short signals from Binance candle data and executes the trade on Hyperliquid.

## Defaults in this build

- Allowed pairs: `HYPEUSDT`, `SOLUSDT`
- Allowed base timeframes: `1m`, `5m`
- Leverage: `10x`
- Balance usage: `100%`
- TP: `0.2%` for `1m`, `0.35%` for `5m`
- Strategy SL: same delayed Bollinger-band activation logic as your original bot
- Emergency SL: `1.2%` fallback only
- Duplicate-trade protection:
  - candle-level signal dedupe
  - in-flight symbol lock
  - blocks duplicate pending/open positions on same symbol

## Setup

```bash
cp .env.example .env
npm install
npm start
```

## Important env values

```env
LEVERAGE=10
BALANCE_USAGE_PCT=1.0
ALLOWED_PAIRS=HYPEUSDT,SOLUSDT
ALLOWED_TFS=1m,5m
```

## Trade flow

1. Detect signal on Binance.
2. Map `HYPEUSDT -> HYPE` and `SOLUSDT -> SOL` for Hyperliquid.
3. Place aggressive limit entry near Hyperliquid mid price.
4. If target is touched before entry fill, cancel the entry.
5. When entry fills, place reduce-only take-profit.
6. Use the original strategy SL activation logic from the uploaded bot.
7. Use emergency SL only as a hard fallback.
