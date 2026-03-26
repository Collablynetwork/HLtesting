#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import eth_account
import requests
from eth_account.signers.local import LocalAccount
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info


MAINNET_API_URL = "https://api.hyperliquid.xyz"
TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz"
EMPTY_SPOT_META: Dict[str, List[Any]] = {"universe": [], "tokens": []}

ROLES: Dict[str, Dict[str, str]] = {
    "1m": {"iht": "5m", "fibtf": "15m"},
    "5m": {"iht": "15m", "fibtf": "30m"},
    "15m": {"iht": "30m", "fibtf": "1h"},
    "30m": {"iht": "1h", "fibtf": "2h"},
    "1h": {"iht": "2h", "fibtf": "4h"},
    "2h": {"iht": "4h", "fibtf": "6h"},
    "4h": {"iht": "6h", "fibtf": "12h"},
    "6h": {"iht": "12h", "fibtf": "1d"},
    "8h": {"iht": "12h", "fibtf": "1d"},
    "12h": {"iht": "1d", "fibtf": "3d"},
    "1d": {"iht": "3d", "fibtf": "1w"},
    "3d": {"iht": "1w", "fibtf": "1M"},
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(*parts: Any) -> None:
    print(utc_now_iso(), *parts, flush=True)


def warn(*parts: Any) -> None:
    print(utc_now_iso(), *parts, file=sys.stderr, flush=True)


def error(*parts: Any) -> None:
    print(utc_now_iso(), *parts, file=sys.stderr, flush=True)


def parse_bool(value: Optional[str], fallback: bool = False) -> bool:
    if value is None or value == "":
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def parse_float(value: Optional[str], fallback: float) -> float:
    try:
        return float(value) if value is not None and value != "" else fallback
    except (TypeError, ValueError):
        return fallback


def parse_int(value: Optional[str], fallback: int) -> int:
    try:
        return int(str(value).strip()) if value is not None and str(value).strip() != "" else fallback
    except (TypeError, ValueError):
        return fallback


def parse_csv(value: Optional[str], fallback: List[str]) -> List[str]:
    if value is None or value == "":
        return fallback
    return [item.strip() for item in str(value).split(",") if item.strip()]


def load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def build_signal_id(pair: str, timeframe: str, direction: str, close_time: int) -> str:
    return f"{pair}_{timeframe}_{close_time}_{direction}"


def build_signal_key(signal: Dict[str, Any]) -> str:
    return f"{signal['symbol']}_{signal['side']}_{signal['base_tf']}_{signal['base_candle_close_time']}"


def tp_price(entry: float, side: str, pct: float) -> float:
    return entry * (1 + pct) if side == "LONG" else entry * (1 - pct)


def emergency_sl_price(entry: float, side: str, pct: float) -> float:
    return entry * (1 - pct) if side == "LONG" else entry * (1 + pct)


def round_down(value: float, decimals: int) -> float:
    if decimals <= 0:
        return math.floor(value)
    factor = 10 ** decimals
    return math.floor(value * factor) / factor


@dataclass
class Config:
    binance_base_url: str
    binance_api_key: str
    binance_timeout_ms: int
    hyperliquid_private_key: str
    hyperliquid_account_address: str
    hyperliquid_testnet: bool
    hyperliquid_margin_mode: str
    leverage: int
    balance_usage_pct: float
    balance_safety_factor: float
    entry_buffer_pct: float
    emergency_sl_pct: float
    hyperliquid_timeout_s: float
    telegram_bot_token: str
    telegram_chat_id: str
    scan_interval_ms: int
    pending_check_interval_ms: int
    position_check_interval_ms: int
    reconcile_interval_ms: int
    entry_timeout_ms: int
    dedupe_retention_ms: int
    state_path: str
    allowed_pairs: List[str]
    allowed_tfs: List[str]
    bb_period: int = 20
    bb_std_dev: float = 2.0
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9
    target_map: Dict[str, float] = field(default_factory=lambda: {"1m": 0.002, "5m": 0.0035})
    market_order_slippage: float = 0.01

    @classmethod
    def from_env(cls) -> "Config":
        allowed_pairs = [item.upper() for item in parse_csv(os.getenv("ALLOWED_PAIRS"), ["HYPEUSDT", "SOLUSDT"])]
        allowed_tfs = [item.lower() for item in parse_csv(os.getenv("ALLOWED_TFS"), ["1m", "5m"])]

        return cls(
            binance_base_url=os.getenv("BINANCE_BASE_URL", "https://fapi.binance.com"),
            binance_api_key=os.getenv("BINANCE_API_KEY", ""),
            binance_timeout_ms=max(15_000, parse_int(os.getenv("BINANCE_TIMEOUT_MS"), 30_000)),
            hyperliquid_private_key=os.getenv("HYPERLIQUID_PRIVATE_KEY", ""),
            hyperliquid_account_address=os.getenv("HYPERLIQUID_MAIN_ADDRESS", ""),
            hyperliquid_testnet=parse_bool(os.getenv("HYPERLIQUID_TESTNET"), False),
            hyperliquid_margin_mode=os.getenv("HYPERLIQUID_MARGIN_MODE", "isolated").strip().lower() or "isolated",
            leverage=max(1, parse_int(os.getenv("LEVERAGE"), 10)),
            balance_usage_pct=min(1.0, max(0.01, parse_float(os.getenv("BALANCE_USAGE_PCT"), 1.0))),
            balance_safety_factor=min(1.0, max(0.95, parse_float(os.getenv("BALANCE_SAFETY_FACTOR"), 0.995))),
            entry_buffer_pct=max(0.0, parse_float(os.getenv("ENTRY_BUFFER_PCT"), 0.0001)),
            emergency_sl_pct=max(0.0005, parse_float(os.getenv("EMERGENCY_SL_PCT"), 0.012)),
            hyperliquid_timeout_s=max(15.0, parse_float(os.getenv("HYPERLIQUID_TIMEOUT_MS"), 30_000) / 1000.0),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID", ""),
            scan_interval_ms=max(3_000, parse_int(os.getenv("SCAN_INTERVAL_MS"), 15_000)),
            pending_check_interval_ms=max(2_000, parse_int(os.getenv("PENDING_CHECK_INTERVAL_MS"), 3_000)),
            position_check_interval_ms=max(2_000, parse_int(os.getenv("POSITION_CHECK_INTERVAL_MS"), 3_000)),
            reconcile_interval_ms=max(10_000, parse_int(os.getenv("RECONCILE_INTERVAL_MS"), 20_000)),
            entry_timeout_ms=max(5_000, parse_int(os.getenv("ENTRY_TIMEOUT_MS"), 45_000)),
            dedupe_retention_ms=max(60_000, parse_int(os.getenv("DEDUPE_RETENTION_MS"), 12 * 60 * 60 * 1000)),
            state_path=os.getenv("PY_STATE_PATH") or os.getenv("STATE_PATH", "./data/python_state.json"),
            allowed_pairs=allowed_pairs,
            allowed_tfs=allowed_tfs,
            market_order_slippage=max(0.001, parse_float(os.getenv("HYPERLIQUID_MARKET_SLIPPAGE"), 0.01)),
        )


class JsonStateStore:
    def __init__(self, file_path: str) -> None:
        self.file_path = Path(file_path)
        self.state: Dict[str, Any] = {
            "trades": {},
            "signal_times": {},
            "processed_signals": {},
        }

    def ensure_shape(self) -> Dict[str, Any]:
        self.state = self.state or {}
        self.state.setdefault("trades", {})
        self.state.setdefault("signal_times", {})
        self.state.setdefault("processed_signals", {})
        return self.state

    def load(self) -> Dict[str, Any]:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.file_path.exists():
            self.save()
            return self.ensure_shape()

        raw = self.file_path.read_text(encoding="utf-8").strip()
        self.state = json.loads(raw) if raw else {}
        return self.ensure_shape()

    def save(self) -> None:
        self.ensure_shape()
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        self.file_path.write_text(json.dumps(self.state, indent=2, sort_keys=True), encoding="utf-8")

    def get_trade(self, key: str) -> Optional[Dict[str, Any]]:
        return self.ensure_shape()["trades"].get(key)

    def get_trades(self) -> List[Dict[str, Any]]:
        return list(self.ensure_shape()["trades"].values())

    def set_trade(self, key: str, trade: Dict[str, Any]) -> None:
        self.ensure_shape()["trades"][key] = trade
        self.save()

    def delete_trade(self, key: str) -> None:
        self.ensure_shape()["trades"].pop(key, None)
        self.save()

    def mark_signal_time(self, key: str, value: Optional[int] = None) -> None:
        self.ensure_shape()["signal_times"][key] = value or int(time.time() * 1000)
        self.save()

    def get_signal_time(self, key: str) -> int:
        return int(self.ensure_shape()["signal_times"].get(key, 0))

    def mark_processed_signal(self, key: str, value: Optional[int] = None) -> None:
        self.ensure_shape()["processed_signals"][key] = value or int(time.time() * 1000)
        self.save()

    def get_processed_signal_time(self, key: str) -> int:
        return int(self.ensure_shape()["processed_signals"].get(key, 0))

    def delete_processed_signal(self, key: str) -> None:
        self.ensure_shape()["processed_signals"].pop(key, None)
        self.save()

    def prune_processed_signals(self, before_ts: int) -> None:
        changed = False
        processed = self.ensure_shape()["processed_signals"]
        for key, ts in list(processed.items()):
            if int(ts) < before_ts:
                processed.pop(key, None)
                changed = True
        if changed:
            self.save()


class TradeRepo:
    ACTIVE_STATUSES = {"OPEN_POSITION", "SL_ARMED"}

    def __init__(self, store: JsonStateStore) -> None:
        self.store = store

    @staticmethod
    def trade_key(symbol: str, base_tf: str) -> str:
        return f"{symbol}_{base_tf}"

    def all(self) -> List[Dict[str, Any]]:
        return self.store.get_trades()

    def upsert(self, trade: Dict[str, Any]) -> None:
        self.store.set_trade(self.trade_key(trade["symbol"], trade["base_tf"]), trade)

    def remove(self, symbol: str, base_tf: str) -> None:
        self.store.delete_trade(self.trade_key(symbol, base_tf))

    def has_active_for_symbol(self, symbol: str) -> bool:
        return any(trade["symbol"] == symbol and trade["status"] in self.ACTIVE_STATUSES for trade in self.all())

    def mark_signal_seen(self, signal_id: str) -> None:
        self.store.mark_signal_time(signal_id)

    def mark_processed_signal(self, signal_key: str) -> None:
        self.store.mark_processed_signal(signal_key)

    def unmark_processed_signal(self, signal_key: str) -> None:
        self.store.delete_processed_signal(signal_key)

    def is_signal_processed(self, signal_key: str) -> bool:
        return self.store.get_processed_signal_time(signal_key) > 0

    def prune_processed_signals(self, before_ts: int) -> None:
        self.store.prune_processed_signals(before_ts)


def bollinger_bands(values: List[float], period: int, std_dev: float) -> List[Dict[str, float]]:
    result: List[Dict[str, float]] = []
    if len(values) < period:
        return result

    for idx in range(period - 1, len(values)):
        window = values[idx - period + 1 : idx + 1]
        mean = sum(window) / period
        variance = sum((value - mean) ** 2 for value in window) / period
        sigma = math.sqrt(variance)
        result.append({
            "middle": mean,
            "upper": mean + std_dev * sigma,
            "lower": mean - std_dev * sigma,
        })
    return result


def ema(values: List[float], period: int) -> List[Optional[float]]:
    result: List[Optional[float]] = [None] * len(values)
    if len(values) < period:
        return result

    seed = sum(values[:period]) / period
    result[period - 1] = seed
    multiplier = 2 / (period + 1)
    prev = seed

    for idx in range(period, len(values)):
        prev = (values[idx] - prev) * multiplier + prev
        result[idx] = prev

    return result


def macd_series(values: List[float], fast_period: int, slow_period: int, signal_period: int) -> List[Dict[str, float]]:
    fast = ema(values, fast_period)
    slow = ema(values, slow_period)

    macd_line: List[Optional[float]] = [None] * len(values)
    compact_macd: List[float] = []
    macd_indices: List[int] = []

    for idx in range(len(values)):
        if fast[idx] is None or slow[idx] is None:
            continue
        value = float(fast[idx] - slow[idx])
        macd_line[idx] = value
        compact_macd.append(value)
        macd_indices.append(idx)

    signal_compact = ema(compact_macd, signal_period)
    result: List[Dict[str, float]] = []
    for compact_idx, index in enumerate(macd_indices):
        signal_value = signal_compact[compact_idx]
        macd_value = macd_line[index]
        if signal_value is None or macd_value is None:
            continue
        result.append({
            "MACD": macd_value,
            "signal": float(signal_value),
            "histogram": float(macd_value - signal_value),
        })
    return result


def is_bullish_cross(macd: List[Dict[str, float]]) -> bool:
    if len(macd) < 2:
        return False
    prev = macd[-2]
    last = macd[-1]
    return prev["MACD"] < prev["signal"] and last["MACD"] > last["signal"] and last["MACD"] > 0


def is_bearish_cross(macd: List[Dict[str, float]]) -> bool:
    if len(macd) < 2:
        return False
    prev = macd[-2]
    last = macd[-1]
    return prev["MACD"] > prev["signal"] and last["MACD"] < last["signal"] and last["MACD"] < 0


def detect_volatility_expansion(candles: List[Dict[str, Any]], config: Config) -> bool:
    closes = [float(candle["close"]) for candle in candles]
    bb = bollinger_bands(closes, config.bb_period, config.bb_std_dev)
    if len(bb) < 25:
        return False

    widths = [band["upper"] - band["lower"] for band in bb]
    current_width = widths[-2]
    previous = widths[-22:-2]
    average = sum(previous) / len(previous)
    return current_width > average * 1.1


class BinanceClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.session = requests.Session()
        if config.binance_api_key:
            self.session.headers.update({"X-MBX-APIKEY": config.binance_api_key})

    def _request(self, path: str, params: Dict[str, Any]) -> Any:
        last_error: Optional[Exception] = None
        for attempt in range(4):
            try:
                response = self.session.get(
                    f"{self.config.binance_base_url}{path}",
                    params=params,
                    timeout=self.config.binance_timeout_ms / 1000.0,
                )
                if response.status_code in {429} or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"Binance HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()
                return response.json()
            except Exception as exc:
                last_error = exc
                if attempt == 3:
                    break
                time.sleep(min(10.0, 1.0 * (attempt + 1)))
        assert last_error is not None
        raise last_error

    def get_candles(self, symbol: str, interval: str, limit: int = 60) -> List[Dict[str, Any]]:
        data = self._request("/fapi/v1/klines", {"symbol": symbol, "interval": interval, "limit": limit})
        return [{
            "open_time": int(row[0]),
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "close_time": int(row[6]),
        } for row in data]


class TelegramClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.session = requests.Session()

    def send(self, text: str, reply_to_message_id: Optional[int] = None) -> Optional[int]:
        if not self.config.telegram_bot_token or not self.config.telegram_chat_id:
            return None

        payload: Dict[str, Any] = {
            "chat_id": self.config.telegram_chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        if reply_to_message_id is not None:
            payload["reply_to_message_id"] = reply_to_message_id

        try:
            response = self.session.post(
                f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage",
                json=payload,
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            return data.get("result", {}).get("message_id")
        except Exception as exc:
            warn("telegram send failed:", exc)
            return None


class HyperliquidClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.base_url = TESTNET_API_URL if config.hyperliquid_testnet else MAINNET_API_URL
        self.wallet: LocalAccount = eth_account.Account.from_key(config.hyperliquid_private_key)
        self.account_address = config.hyperliquid_account_address or self.wallet.address
        self.info = Info(
            self.base_url,
            skip_ws=True,
            spot_meta=EMPTY_SPOT_META,
            timeout=config.hyperliquid_timeout_s,
        )
        perp_meta = self.info.meta()
        self.exchange = Exchange(
            self.wallet,
            self.base_url,
            account_address=self.account_address,
            meta=perp_meta,
            spot_meta=EMPTY_SPOT_META,
            timeout=config.hyperliquid_timeout_s,
        )
        self._market_meta: Optional[Dict[str, Dict[str, Any]]] = None

    @staticmethod
    def normalize_coin(symbol: str) -> str:
        coin = symbol.upper().strip()
        for suffix in ("-PERP", "/USDT", "USDT", "/USD", "/USDC"):
            if coin.endswith(suffix):
                coin = coin[: -len(suffix)]
        return coin

    def load_market_meta(self) -> Dict[str, Dict[str, Any]]:
        if self._market_meta is None:
            meta, _ctxs = self.info.meta_and_asset_ctxs()
            self._market_meta = {item["name"]: item for item in meta["universe"]}
        return self._market_meta

    def market_rules(self, symbol: str) -> Dict[str, Any]:
        coin = self.normalize_coin(symbol)
        rules = self.load_market_meta().get(coin)
        if rules is None:
            raise ValueError(f"{symbol} -> {coin} is not listed on Hyperliquid")
        return {
            "coin": coin,
            "max_leverage": int(rules.get("maxLeverage", 0) or 0),
            "only_isolated": bool(rules.get("onlyIsolated", False)),
        }

    def validate_allowed_pairs(self, pairs: List[str], leverage: int, margin_mode: str) -> None:
        for pair in pairs:
            rules = self.market_rules(pair)
            coin = rules["coin"]
            max_leverage = rules["max_leverage"]
            if leverage > max_leverage:
                raise RuntimeError(
                    f"{pair} -> {coin} does not allow configured leverage {leverage}x on this environment. "
                    f"Exchange max is {max_leverage}x."
                )
            if margin_mode == "cross" and rules["only_isolated"]:
                raise RuntimeError(f"{pair} -> {coin} is isolated-only on Hyperliquid")
            log(f"validated {pair} -> {coin}: maxLeverage={max_leverage} isolatedOnly={rules['only_isolated']}")

    def get_size_decimals(self, symbol: str) -> int:
        coin = self.normalize_coin(symbol)
        asset = self.info.name_to_asset(coin)
        return int(self.info.asset_to_sz_decimals[asset])

    def round_size(self, symbol: str, size: float) -> float:
        decimals = self.get_size_decimals(symbol)
        return round_down(size, decimals)

    def all_mids(self) -> Dict[str, Any]:
        return self.info.all_mids()

    def get_mid_price(self, symbol: str) -> float:
        coin = self.normalize_coin(symbol)
        mids = self.all_mids()
        value = mids.get(coin)
        if value is None:
            raise RuntimeError(f"Mid price unavailable for {coin}")
        return float(value)

    def user_state(self) -> Dict[str, Any]:
        return self.info.user_state(self.account_address)

    def get_available_balance(self) -> float:
        state = self.user_state()
        withdrawable = float(state.get("withdrawable") or 0)
        if withdrawable > 0:
            return withdrawable

        summary = state.get("marginSummary", {})
        account_value = float(summary.get("accountValue") or 0)
        total_margin_used = float(summary.get("totalMarginUsed") or 0)
        available = account_value - total_margin_used
        if available <= 0:
            raise RuntimeError("No available Hyperliquid balance for sizing")
        return available

    def get_position(self, symbol: str) -> Optional[Dict[str, Any]]:
        coin = self.normalize_coin(symbol)
        state = self.user_state()
        for row in state.get("assetPositions", []):
            position = row.get("position", row)
            if position.get("coin") != coin:
                continue
            leverage = position.get("leverage", {})
            return {
                "coin": coin,
                "size": float(position.get("szi") or 0),
                "entry_price": float(position["entryPx"]) if position.get("entryPx") else None,
                "unrealized_pnl": float(position.get("unrealizedPnl") or 0),
                "position_value": float(position.get("positionValue") or 0),
                "leverage": int(leverage.get("value", 0) or 0),
                "margin_mode": leverage.get("type"),
            }
        return None

    def set_isolated_leverage(self, symbol: str, leverage: int) -> Dict[str, Any]:
        rules = self.market_rules(symbol)
        coin = rules["coin"]
        if leverage > rules["max_leverage"]:
            raise ValueError(
                f"{coin} max leverage is {rules['max_leverage']}x on this environment, requested {leverage}x"
            )
        result = self.exchange.update_leverage(leverage, coin, is_cross=False)
        if result.get("status") != "ok":
            raise RuntimeError(f"update_leverage failed for {coin}: {result}")
        return result

    @staticmethod
    def parse_order_result(result: Dict[str, Any]) -> Dict[str, Any]:
        if result.get("status") != "ok":
            raise RuntimeError(f"order failed: {result}")

        statuses = result.get("response", {}).get("data", {}).get("statuses", [])
        for status in statuses:
            if "filled" in status:
                filled = status["filled"]
                return {
                    "type": "filled",
                    "size": float(filled.get("totalSz") or 0),
                    "avg_px": float(filled.get("avgPx") or 0),
                    "raw": filled,
                }
            if "error" in status:
                raise RuntimeError(status["error"])
            if "resting" in status:
                raise RuntimeError(f"unexpected resting order from market order: {status['resting']}")

        raise RuntimeError(f"unexpected order response: {result}")

    def market_open(self, symbol: str, side: str, size: float, slippage: float) -> Dict[str, Any]:
        coin = self.normalize_coin(symbol)
        result = self.exchange.market_open(coin, side == "LONG", float(size), slippage=slippage)
        return self.parse_order_result(result)

    def market_close(self, symbol: str, size: Optional[float], slippage: float) -> Dict[str, Any]:
        coin = self.normalize_coin(symbol)
        result = self.exchange.market_close(coin, sz=size, slippage=slippage)
        return self.parse_order_result(result)


def compute_order_size(withdrawable_balance: float, entry_price: float, leverage: int, config: Config) -> float:
    if withdrawable_balance <= 0:
        raise ValueError("Invalid withdrawable balance for size calculation")
    if entry_price <= 0:
        raise ValueError("Invalid entry price for size calculation")

    usable_balance = withdrawable_balance * config.balance_usage_pct * config.balance_safety_factor
    notional = usable_balance * leverage
    if notional <= 0:
        raise ValueError("Invalid notional for size calculation")

    size = notional / entry_price
    if size <= 0:
        raise ValueError("Computed invalid order size")
    return size


def validate_macd(pair: str, direction: str, ihtf: str, config: Config, binance: BinanceClient) -> Dict[str, Any]:
    candles = binance.get_candles(pair, ihtf)
    macd = macd_series([candle["close"] for candle in candles], config.macd_fast, config.macd_slow, config.macd_signal)

    bullish = is_bullish_cross(macd)
    bearish = is_bearish_cross(macd)

    if direction == "LONG" and bearish:
        return {"confirmed": True, "direction": "SHORT"}
    if direction == "SHORT" and bullish:
        return {"confirmed": True, "direction": "LONG"}
    if direction == "LONG" and bullish:
        return {"confirmed": True, "direction": "LONG"}
    if direction == "SHORT" and bearish:
        return {"confirmed": True, "direction": "SHORT"}
    return {"confirmed": False, "direction": direction}


def check_btc_alignment(direction: str, ihtf: str, config: Config, binance: BinanceClient) -> bool:
    candles = binance.get_candles("BTCUSDT", ihtf)
    macd = macd_series([candle["close"] for candle in candles], config.macd_fast, config.macd_slow, config.macd_signal)
    if direction == "LONG":
        return is_bullish_cross(macd)
    if direction == "SHORT":
        return is_bearish_cross(macd)
    return False


def detect_leadership(pair: str, direction: str, ihtf: str, config: Config, binance: BinanceClient) -> str:
    asset = binance.get_candles(pair, ihtf)
    btc = binance.get_candles("BTCUSDT", ihtf)

    asset_macd = macd_series([candle["close"] for candle in asset], config.macd_fast, config.macd_slow, config.macd_signal)
    btc_macd = macd_series([candle["close"] for candle in btc], config.macd_fast, config.macd_slow, config.macd_signal)
    if len(asset_macd) < 2 or len(btc_macd) < 2:
        return "none"

    a = asset_macd[-1]
    b = btc_macd[-1]
    if direction == "LONG" and a["MACD"] > a["signal"] and b["MACD"] < b["signal"]:
        return "asset_leading"
    if direction == "SHORT" and a["MACD"] < a["signal"] and b["MACD"] > b["signal"]:
        return "asset_leading"
    return "none"


def evaluate_signal(pair: str, base_tf: str, config: Config, binance: BinanceClient) -> Optional[Dict[str, Any]]:
    if pair not in config.allowed_pairs or base_tf not in config.allowed_tfs:
        return None

    role = ROLES.get(base_tf)
    if role is None:
        return None

    base_candles = binance.get_candles(pair, base_tf)
    if len(base_candles) < 30:
        return None

    base_bb = bollinger_bands([candle["close"] for candle in base_candles], config.bb_period, config.bb_std_dev)
    base_candle = base_candles[-2]
    base_band = base_bb[-2] if len(base_bb) >= 2 else None
    if base_band is None:
        return None

    direction: Optional[str] = None
    if base_candle["open"] > base_band["upper"] and base_candle["close"] > base_band["upper"]:
        direction = "SHORT"
    if base_candle["open"] < base_band["lower"] and base_candle["close"] < base_band["lower"]:
        direction = "LONG"
    if direction is None:
        return None

    iht_candles = binance.get_candles(pair, role["iht"])
    iht_bb = bollinger_bands([candle["close"] for candle in iht_candles], config.bb_period, config.bb_std_dev)
    if not iht_bb:
        return None

    iht_candle = iht_candles[-1]
    iht_band = iht_bb[-1]
    iht_confirm = (
        (direction == "LONG" and iht_candle["low"] <= iht_band["lower"]) or
        (direction == "SHORT" and iht_candle["high"] >= iht_band["upper"])
    )
    if not iht_confirm:
        return None

    fib_candles = binance.get_candles(pair, role["fibtf"])
    fib_bb = bollinger_bands([candle["close"] for candle in fib_candles], config.bb_period, config.bb_std_dev)
    if not fib_bb:
        return None

    fib_candle = fib_candles[-1]
    fib_band = fib_bb[-1]
    inside = fib_candle["high"] < fib_band["upper"] and fib_candle["low"] > fib_band["lower"]
    if not inside:
        return None

    duration = fib_candle["close_time"] - fib_candle["open_time"]
    elapsed = base_candle["close_time"] - fib_candle["open_time"]
    if elapsed > duration * 0.35:
        return None

    macd_check = validate_macd(pair, direction, role["iht"], config, binance)
    if not macd_check["confirmed"]:
        return None

    direction = str(macd_check["direction"])
    btc_aligned = check_btc_alignment(direction, role["iht"], config, binance)
    lead = "btc_aligned" if btc_aligned else detect_leadership(pair, direction, role["iht"], config, binance)
    target_pct = config.target_map.get(base_tf)
    if target_pct is None:
        return None

    entry_reference = float(base_candle["close"])
    return {
        "signal_id": build_signal_id(pair, base_tf, direction, base_candle["close_time"]),
        "symbol": pair,
        "hyper_symbol": HyperliquidClient.normalize_coin(pair),
        "side": direction,
        "base_tf": base_tf,
        "immediate_tf": role["iht"],
        "structure_tf": role["fibtf"],
        "entry_reference": entry_reference,
        "target_pct": target_pct,
        "base_candle_close_time": int(base_candle["close_time"]),
        "strategy": "bb_macd_binance_to_hyperliquid_python",
        "meta": {
            "btc_aligned": btc_aligned,
            "lead": lead,
            "base_volatility_expansion": detect_volatility_expansion(base_candles, config),
            "iht_volatility_expansion": detect_volatility_expansion(iht_candles, config),
        },
    }


class TradeEngine:
    def __init__(
        self,
        config: Config,
        binance: BinanceClient,
        hyperliquid: HyperliquidClient,
        telegram: TelegramClient,
        repo: TradeRepo,
    ) -> None:
        self.config = config
        self.binance = binance
        self.hyperliquid = hyperliquid
        self.telegram = telegram
        self.repo = repo
        self.in_flight_symbols: set[str] = set()

    def prune_signal_history(self) -> None:
        cutoff = int(time.time() * 1000) - self.config.dedupe_retention_ms
        self.repo.prune_processed_signals(cutoff)

    def on_signal(self, signal: Dict[str, Any]) -> None:
        if signal["symbol"] not in self.config.allowed_pairs:
            return

        signal_key = build_signal_key(signal)
        if self.repo.is_signal_processed(signal_key):
            return
        if signal["symbol"] in self.in_flight_symbols:
            return
        if self.repo.has_active_for_symbol(signal["symbol"]):
            return

        self.in_flight_symbols.add(signal["symbol"])
        try:
            self.prune_signal_history()
            self.repo.mark_processed_signal(signal_key)
            self.repo.mark_signal_seen(signal["signal_id"])

            existing_position = self.hyperliquid.get_position(signal["hyper_symbol"])
            if existing_position and abs(existing_position["size"]) > 0:
                warn(f"Skipping {signal['symbol']} {signal['base_tf']}; position already open on Hyperliquid.")
                return

            self.hyperliquid.set_isolated_leverage(signal["hyper_symbol"], self.config.leverage)

            mid = self.hyperliquid.get_mid_price(signal["hyper_symbol"])
            entry_reference = mid * (1 + self.config.entry_buffer_pct) if signal["side"] == "LONG" else mid * (1 - self.config.entry_buffer_pct)
            available_balance = self.hyperliquid.get_available_balance()
            raw_size = compute_order_size(available_balance, entry_reference, self.config.leverage, self.config)
            rounded_size = self.hyperliquid.round_size(signal["hyper_symbol"], raw_size)
            if rounded_size <= 0:
                raise RuntimeError(f"Rounded size became invalid for {signal['symbol']}")

            fill = self.hyperliquid.market_open(signal["hyper_symbol"], signal["side"], rounded_size, self.config.market_order_slippage)
            fill_price = float(fill["avg_px"] or entry_reference)
            filled_size = float(fill["size"] or rounded_size)
            target_price = tp_price(fill_price, signal["side"], float(signal["target_pct"]))
            emergency_sl = emergency_sl_price(fill_price, signal["side"], self.config.emergency_sl_pct)

            message_id = self.telegram.send(
                "\n".join([
                    "NEW SIGNAL EXECUTED ON HYPERLIQUID",
                    f"Pair: {signal['symbol']}",
                    f"Direction: {signal['side']}",
                    f"Base TF: {signal['base_tf']}",
                    f"Fill Price: {fill_price}",
                    f"Filled Size: {filled_size}",
                    f"Target Price: {target_price}",
                    f"Emergency SL: {emergency_sl}",
                    f"Use Balance: {self.config.balance_usage_pct * 100}%",
                    f"Leverage: {self.config.leverage}x (isolated)",
                ])
            )

            self.repo.upsert({
                **signal,
                "signal_key": signal_key,
                "status": "OPEN_POSITION",
                "created_at": int(time.time() * 1000),
                "updated_at": int(time.time() * 1000),
                "entry_price": fill_price,
                "target_price": target_price,
                "emergency_sl": emergency_sl,
                "requested_size": rounded_size,
                "filled_size": filled_size,
                "message_id": message_id,
                "leverage": self.config.leverage,
                "leverage_mode": "isolated",
                "sl_activated_at": None,
                "sl_price": None,
                "exit_reason": None,
            })

            log(f"Opened position for {signal['symbol']} {signal['base_tf']}")
        except Exception:
            self.repo.unmark_processed_signal(signal_key)
            raise
        finally:
            self.in_flight_symbols.discard(signal["symbol"])

    def check_and_activate_sl(self, trade: Dict[str, Any]) -> Dict[str, Any]:
        if trade.get("sl_activated_at"):
            return trade

        role = ROLES.get(trade["base_tf"])
        if role is None:
            return trade

        candles = self.binance.get_candles(trade["symbol"], role["fibtf"])
        closes = [candle["close"] for candle in candles]
        bb = bollinger_bands(closes, self.config.bb_period, self.config.bb_std_dev)
        if len(candles) < 2 or len(bb) < 2:
            return trade

        closed = candles[-2]
        band = bb[-2]
        should_activate = (
            (trade["side"] == "LONG" and closed["low"] <= band["lower"]) or
            (trade["side"] == "SHORT" and closed["high"] >= band["upper"])
        )
        if not should_activate:
            return trade

        trade["sl_activated_at"] = int(time.time() * 1000)
        trade["sl_price"] = float(closed["close"])
        trade["status"] = "SL_ARMED"
        trade["updated_at"] = int(time.time() * 1000)
        self.repo.upsert(trade)

        self.telegram.send(
            "\n".join([
                "STRATEGY SL ACTIVATED",
                f"Pair: {trade['symbol']}",
                f"Direction: {trade['side']}",
                f"Base TF: {trade['base_tf']}",
                f"SL Price: {trade['sl_price']}",
            ]),
            trade.get("message_id"),
        )
        return trade

    def close_trade(self, trade: Dict[str, Any], reason: str) -> None:
        position = self.hyperliquid.get_position(trade["hyper_symbol"])
        size = abs(float(position["size"])) if position else abs(float(trade.get("filled_size") or trade.get("requested_size") or 0))
        if size > 0:
            self.hyperliquid.market_close(trade["hyper_symbol"], size, self.config.market_order_slippage)

        trade["status"] = reason
        trade["exit_reason"] = reason
        trade["updated_at"] = int(time.time() * 1000)
        self.repo.upsert(trade)

        self.telegram.send(
            "\n".join([
                "TARGET HIT" if reason == "EXITED_TP" else "STOP LOSS HIT",
                f"Pair: {trade['symbol']}",
                f"Direction: {trade['side']}",
                f"Base TF: {trade['base_tf']}",
            ]),
            trade.get("message_id"),
        )
        self.repo.remove(trade["symbol"], trade["base_tf"])

    def watch_open_positions(self) -> None:
        trades = [trade for trade in self.repo.all() if trade.get("status") in {"OPEN_POSITION", "SL_ARMED"}]
        for trade in trades:
            try:
                live_position = self.hyperliquid.get_position(trade["hyper_symbol"])
                if live_position is None or abs(live_position["size"]) == 0:
                    warn(f"Removing orphaned open trade {trade['symbol']} {trade['base_tf']}")
                    self.repo.remove(trade["symbol"], trade["base_tf"])
                    continue

                trade = self.check_and_activate_sl(trade)
                current_mid = self.hyperliquid.get_mid_price(trade["hyper_symbol"])

                tp_hit = (
                    (trade["side"] == "LONG" and current_mid >= trade["target_price"]) or
                    (trade["side"] == "SHORT" and current_mid <= trade["target_price"])
                )
                if tp_hit:
                    self.close_trade(trade, "EXITED_TP")
                    continue

                emergency_hit = (
                    (trade["side"] == "LONG" and current_mid <= trade["emergency_sl"]) or
                    (trade["side"] == "SHORT" and current_mid >= trade["emergency_sl"])
                )
                if emergency_hit:
                    self.close_trade(trade, "EXITED_EMERGENCY_SL")
                    continue

                if trade.get("sl_price") is not None:
                    strategy_sl_hit = (
                        (trade["side"] == "LONG" and current_mid <= trade["sl_price"]) or
                        (trade["side"] == "SHORT" and current_mid >= trade["sl_price"])
                    )
                    if strategy_sl_hit:
                        self.close_trade(trade, "EXITED_STRATEGY_SL")
            except Exception as exc:
                warn(f"watchOpenPositions error for {trade['symbol']}: {exc}")

    def reconcile(self) -> None:
        self.prune_signal_history()
        trades = self.repo.all()
        if not trades:
            return

        for trade in trades:
            try:
                position = self.hyperliquid.get_position(trade["hyper_symbol"])
                has_position = position is not None and abs(position["size"]) > 0
                if trade.get("status") in {"OPEN_POSITION", "SL_ARMED"} and not has_position:
                    warn(f"Removing orphaned open trade {trade['symbol']} {trade['base_tf']}")
                    self.repo.remove(trade["symbol"], trade["base_tf"])
            except Exception as exc:
                warn(f"reconcile error for {trade['symbol']}: {exc}")


class PythonAutotrader:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.binance = BinanceClient(config)
        self.hyperliquid = HyperliquidClient(config)
        self.telegram = TelegramClient(config)
        self.store = JsonStateStore(config.state_path)
        self.store.load()
        self.repo = TradeRepo(self.store)
        self.engine = TradeEngine(config, self.binance, self.hyperliquid, self.telegram, self.repo)

    def validate_startup(self) -> None:
        if not self.config.hyperliquid_private_key:
            raise RuntimeError("Missing HYPERLIQUID_PRIVATE_KEY")
        if not self.config.hyperliquid_account_address:
            raise RuntimeError("Missing HYPERLIQUID_MAIN_ADDRESS")
        if self.config.hyperliquid_margin_mode != "isolated":
            raise RuntimeError("This Python bot is configured for isolated mode only")
        self.hyperliquid.validate_allowed_pairs(self.config.allowed_pairs, self.config.leverage, self.config.hyperliquid_margin_mode)

    def scan_signals(self) -> None:
        for pair in self.config.allowed_pairs:
            for timeframe in self.config.allowed_tfs:
                try:
                    signal = evaluate_signal(pair, timeframe, self.config, self.binance)
                    if signal:
                        self.engine.on_signal(signal)
                except Exception as exc:
                    error(f"scanSignals failed for {pair} {timeframe}: {exc}")

    def run(self) -> None:
        self.validate_startup()

        next_scan = 0.0
        next_positions = 0.0
        next_reconcile = 0.0

        self.scan_signals()
        self.engine.watch_open_positions()
        self.engine.reconcile()

        log(
            "Python Binance -> Hyperliquid autotrader started for pairs:",
            ", ".join(self.config.allowed_pairs),
        )

        while True:
            now = time.monotonic() * 1000.0

            if now >= next_scan:
                self.scan_signals()
                next_scan = now + self.config.scan_interval_ms

            if now >= next_positions:
                try:
                    self.engine.watch_open_positions()
                except Exception as exc:
                    error(f"watchOpenPositions failed: {exc}")
                next_positions = now + self.config.position_check_interval_ms

            if now >= next_reconcile:
                try:
                    self.engine.reconcile()
                except Exception as exc:
                    error(f"reconcile failed: {exc}")
                next_reconcile = now + self.config.reconcile_interval_ms

            time.sleep(0.5)


def main() -> None:
    project_root = Path(__file__).resolve().parent
    load_env_file(project_root / ".env")
    config = Config.from_env()
    bot = PythonAutotrader(config)
    bot.run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Python autotrader stopped")
    except Exception as exc:
        error("Fatal startup error:", exc)
        raise
