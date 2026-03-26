export const roles = {
  '1m': { iht: '5m', fibtf: '15m' },
  '5m': { iht: '15m', fibtf: '30m' },
  '15m': { iht: '30m', fibtf: '1h' },
  '30m': { iht: '1h', fibtf: '2h' },
  '1h': { iht: '2h', fibtf: '4h' },
  '2h': { iht: '4h', fibtf: '6h' },
  '4h': { iht: '6h', fibtf: '12h' },
  '6h': { iht: '12h', fibtf: '1d' },
  '8h': { iht: '12h', fibtf: '1d' },
  '12h': { iht: '1d', fibtf: '3d' },
  '1d': { iht: '3d', fibtf: '1w' },
  '3d': { iht: '1w', fibtf: '1M' }
};
