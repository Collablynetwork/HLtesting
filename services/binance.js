import axios from 'axios';
import { CONFIG } from '../config.js';

const client = axios.create({
  baseURL: CONFIG.binance.baseUrl,
  timeout: 15000,
  headers: {
    'X-MBX-APIKEY': CONFIG.binance.apiKey
  }
});

export async function getCandles(symbol, interval, limit = 60) {
  const { data } = await client.get('/fapi/v1/klines', {
    params: { symbol, interval, limit }
  });

  return data.map((c) => ({
    openTime: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    closeTime: c[6]
  }));
}

export async function getCurrentPrice(symbol) {
  const { data } = await client.get('/fapi/v1/ticker/price', {
    params: { symbol }
  });

  return Number(data.price);
}
