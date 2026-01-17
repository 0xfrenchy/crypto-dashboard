require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// API CONFIGURATIONS
// ============================================
const COINALYZE_API = 'https://api.coinalyze.net/v1';
const API_KEY = process.env.COINALYZE_API_KEY;
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

const COINALYZE_EXCHANGES = {
  'A': 'Binance',
  '6': 'Bybit',
  '4': 'Huobi',
  '3': 'OKX'
};

// ============================================
// CACHING SYSTEM
// ============================================
const cache = {
  btcSymbols: [],
  ethSymbols: [],
  data: {
    btcOI: null,
    ethOI: null,
    btcFR: null,
    ethFR: null,
    btcOIHistory: null,
    ethOIHistory: null,
    btcFRHistory: null,
    ethFRHistory: null,
    btcLSHistory: null,
    ethLSHistory: null
  },
  lastUpdate: null,
  isRefreshing: false
};

const CACHE_TTL = 60 * 1000;

// ============================================
// API HELPERS
// ============================================
async function coinalyzeRequest(endpoint, params = {}, retries = 3) {
  const queryParams = new URLSearchParams({ ...params, api_key: API_KEY });
  const url = `${COINALYZE_API}${endpoint}?${queryParams}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
        console.log(`⏳ Rate limited, waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        console.error(`❌ Coinalyze ${endpoint} failed:`, error.message);
        throw error;
      }
      await sleep(2000 * attempt);
    }
  }
}

async function hyperliquidRequest(body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(HYPERLIQUID_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Hyperliquid error: ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        console.error(`❌ Hyperliquid failed:`, error.message);
        throw error;
      }
      await sleep(2000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// INITIALIZE
// ============================================
async function initializeSymbols() {
  try {
    console.log('🔍 Fetching Coinalyze futures markets...');
    const markets = await coinalyzeRequest('/future-markets');
    const wantedCodes = Object.keys(COINALYZE_EXCHANGES);
    
    const btcMarkets = markets.filter(m => {
      const code = m.symbol.split('.')[1];
      return m.base_asset === 'BTC' && m.is_perpetual && wantedCodes.includes(code);
    });
    
    const ethMarkets = markets.filter(m => {
      const code = m.symbol.split('.')[1];
      return m.base_asset === 'ETH' && m.is_perpetual && wantedCodes.includes(code);
    });

    cache.btcSymbols = pickOnePerExchange(btcMarkets);
    cache.ethSymbols = pickOnePerExchange(ethMarkets);

    console.log(`   BTC: ${cache.btcSymbols.join(', ')}`);
    console.log(`   ETH: ${cache.ethSymbols.join(', ')}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize:', error.message);
    cache.btcSymbols = ['BTCUSDT_PERP.A', 'BTCUSDT.6', 'BTCUSDT_PERP.3'];
    cache.ethSymbols = ['ETHUSDT_PERP.A', 'ETHUSDT.6', 'ETHUSDT_PERP.3'];
    return false;
  }
}

function pickOnePerExchange(markets) {
  const byExchange = {};
  for (const m of markets) {
    const code = m.symbol.split('.')[1];
    const isPreferred = m.symbol.includes('USDT_PERP') || m.symbol.includes('USDT.');
    if (!byExchange[code] || isPreferred) {
      byExchange[code] = m.symbol;
    }
  }
  return Object.values(byExchange);
}

// ============================================
// FETCH HYPERLIQUID DATA
// ============================================
async function fetchHyperliquidData() {
  try {
    console.log('  🌐 Fetching Hyperliquid...');
    const metaData = await hyperliquidRequest({ type: 'metaAndAssetCtxs' });
    const universe = metaData[0].universe;
    const assetCtxs = metaData[1];
    
    const btcIndex = universe.findIndex(a => a.name === 'BTC');
    const ethIndex = universe.findIndex(a => a.name === 'ETH');
    
    let btcData = null, ethData = null;
    
    if (btcIndex !== -1 && assetCtxs[btcIndex]) {
      const ctx = assetCtxs[btcIndex];
      btcData = {
        openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        fundingRate: parseFloat(ctx.funding),
        markPrice: parseFloat(ctx.markPx)
      };
    }
    
    if (ethIndex !== -1 && assetCtxs[ethIndex]) {
      const ctx = assetCtxs[ethIndex];
      ethData = {
        openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        fundingRate: parseFloat(ctx.funding),
        markPrice: parseFloat(ctx.markPx)
      };
    }
    
    return { btc: btcData, eth: ethData };
  } catch (error) {
    console.error('  ❌ Hyperliquid error:', error.message);
    return { btc: null, eth: null };
  }
}

// ============================================
// REFRESH ALL DATA (5 days history)
// ============================================
async function refreshAllData() {
  if (cache.isRefreshing) return;
  
  cache.isRefreshing = true;
  console.log('🔄 Refreshing data...');
  
  try {
    const btcSymbolsStr = cache.btcSymbols.join(',');
    const ethSymbolsStr = cache.ethSymbols.join(',');
    
    const now = Math.floor(Date.now() / 1000);
    const fiveDaysAgo = now - (5 * 24 * 60 * 60);

    const hyperliquid = await fetchHyperliquidData();
    await sleep(500);

    console.log('  📈 Fetching current data...');
    const [coinalyzeBtcOI, coinalyzeEthOI, coinalyzeBtcFR, coinalyzeEthFR] = await Promise.all([
      coinalyzeRequest('/open-interest', { symbols: btcSymbolsStr, convert_to_usd: 'true' }),
      coinalyzeRequest('/open-interest', { symbols: ethSymbolsStr, convert_to_usd: 'true' }),
      coinalyzeRequest('/funding-rate', { symbols: btcSymbolsStr }),
      coinalyzeRequest('/funding-rate', { symbols: ethSymbolsStr })
    ]);
    await sleep(2000);

    // Fetch 5-day history with 4-hour intervals (gives us good resolution without too many points)
    console.log('  📊 Fetching 5-day history...');
    const [btcOIHist, ethOIHist] = await Promise.all([
      coinalyzeRequest('/open-interest-history', {
        symbols: btcSymbolsStr, interval: '4hour', from: fiveDaysAgo, to: now, convert_to_usd: 'true'
      }),
      coinalyzeRequest('/open-interest-history', {
        symbols: ethSymbolsStr, interval: '4hour', from: fiveDaysAgo, to: now, convert_to_usd: 'true'
      })
    ]);
    await sleep(2000);

    const [btcFRHist, ethFRHist] = await Promise.all([
      coinalyzeRequest('/funding-rate-history', {
        symbols: btcSymbolsStr, interval: '4hour', from: fiveDaysAgo, to: now
      }),
      coinalyzeRequest('/funding-rate-history', {
        symbols: ethSymbolsStr, interval: '4hour', from: fiveDaysAgo, to: now
      })
    ]);
    await sleep(2000);

    const [btcLSHist, ethLSHist] = await Promise.all([
      coinalyzeRequest('/long-short-ratio-history', {
        symbols: cache.btcSymbols.slice(0, 2).join(','), interval: '4hour', from: fiveDaysAgo, to: now
      }),
      coinalyzeRequest('/long-short-ratio-history', {
        symbols: cache.ethSymbols.slice(0, 2).join(','), interval: '4hour', from: fiveDaysAgo, to: now
      })
    ]);

    // Merge data
    cache.data.btcOI = [...coinalyzeBtcOI];
    cache.data.ethOI = [...coinalyzeEthOI];
    
    if (hyperliquid.btc) {
      cache.data.btcOI.push({ symbol: 'BTC.HYPERLIQUID', value: hyperliquid.btc.openInterest });
    }
    if (hyperliquid.eth) {
      cache.data.ethOI.push({ symbol: 'ETH.HYPERLIQUID', value: hyperliquid.eth.openInterest });
    }
    
    cache.data.btcFR = filterValidFundingRates(coinalyzeBtcFR);
    cache.data.ethFR = filterValidFundingRates(coinalyzeEthFR);
    
    if (hyperliquid.btc && isValidFundingRate(hyperliquid.btc.fundingRate)) {
      cache.data.btcFR.push({ symbol: 'BTC.HYPERLIQUID', value: hyperliquid.btc.fundingRate });
    }
    if (hyperliquid.eth && isValidFundingRate(hyperliquid.eth.fundingRate)) {
      cache.data.ethFR.push({ symbol: 'ETH.HYPERLIQUID', value: hyperliquid.eth.fundingRate });
    }
    
    cache.data.btcOIHistory = btcOIHist;
    cache.data.ethOIHistory = ethOIHist;
    cache.data.btcFRHistory = btcFRHist;
    cache.data.ethFRHistory = ethFRHist;
    cache.data.btcLSHistory = btcLSHist;
    cache.data.ethLSHistory = ethLSHist;

    cache.lastUpdate = Date.now();
    console.log('✅ Data refreshed!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    cache.isRefreshing = false;
  }
}

// ============================================
// DATA HELPERS
// ============================================
function isValidFundingRate(rate) {
  if (rate === null || rate === undefined) return false;
  return Math.abs(rate) < 0.005;
}

function filterValidFundingRates(data) {
  if (!Array.isArray(data)) return [];
  return data.filter(item => isValidFundingRate(item.value));
}

function getExchangeName(symbol) {
  if (symbol.includes('HYPERLIQUID')) return 'Hyperliquid';
  const code = symbol.split('.')[1];
  return COINALYZE_EXCHANGES[code] || code;
}

function aggregateOI(data) {
  if (!data || !Array.isArray(data)) return { total: 0, byExchange: [] };
  
  const byExchangeMap = {};
  data.forEach(item => {
    if (!item.value) return;
    const exchange = getExchangeName(item.symbol);
    byExchangeMap[exchange] = (byExchangeMap[exchange] || 0) + item.value;
  });
  
  const byExchange = Object.entries(byExchangeMap)
    .map(([exchange, value]) => ({ exchange, value }))
    .sort((a, b) => b.value - a.value);
  
  return { total: byExchange.reduce((s, i) => s + i.value, 0), byExchange };
}

function aggregateFR(data) {
  if (!data || !Array.isArray(data)) return { average: 0, byExchange: [] };
  
  const byExchangeMap = {};
  data.forEach(item => {
    if (item.value === null || item.value === undefined) return;
    const exchange = getExchangeName(item.symbol);
    if (!byExchangeMap[exchange]) byExchangeMap[exchange] = { sum: 0, count: 0 };
    byExchangeMap[exchange].sum += item.value;
    byExchangeMap[exchange].count += 1;
  });
  
  const byExchange = Object.entries(byExchangeMap)
    .map(([exchange, { sum, count }]) => ({ exchange, value: count > 0 ? sum / count : 0 }))
    .filter(item => item.value !== 0);
  
  const average = byExchange.length > 0
    ? byExchange.reduce((s, i) => s + i.value, 0) / byExchange.length : 0;
  
  return { average, byExchange };
}

function aggregateHistory(data) {
  if (!data || !Array.isArray(data)) return [];
  const byTime = {};
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) byTime[point.t] = 0;
        byTime[point.t] += point.c || 0;
      });
    }
  });
  return Object.entries(byTime)
    .map(([t, value]) => ({ t: parseInt(t) * 1000, value }))
    .sort((a, b) => a.t - b.t);
}

function averageHistory(data) {
  if (!data || !Array.isArray(data)) return [];
  const byTime = {};
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) byTime[point.t] = { sum: 0, count: 0 };
        if (point.c != null && isValidFundingRate(point.c)) {
          byTime[point.t].sum += point.c;
          byTime[point.t].count += 1;
        }
      });
    }
  });
  return Object.entries(byTime)
    .map(([t, { sum, count }]) => ({ t: parseInt(t) * 1000, value: count > 0 ? sum / count : 0 }))
    .sort((a, b) => a.t - b.t);
}

function averageLSHistory(data) {
  if (!data || !Array.isArray(data)) return [];
  const byTime = {};
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) byTime[point.t] = { ratioSum: 0, longSum: 0, shortSum: 0, count: 0 };
        if (point.r != null) {
          byTime[point.t].ratioSum += point.r;
          byTime[point.t].longSum += point.l || 0;
          byTime[point.t].shortSum += point.s || 0;
          byTime[point.t].count += 1;
        }
      });
    }
  });
  return Object.entries(byTime)
    .map(([t, { ratioSum, longSum, shortSum, count }]) => ({
      t: parseInt(t) * 1000,
      ratio: count > 0 ? ratioSum / count : 1,
      long: count > 0 ? longSum / count : 50,
      short: count > 0 ? shortSum / count : 50
    }))
    .sort((a, b) => a.t - b.t);
}

// ============================================
// TREND ANALYSIS
// ============================================
function analyzeTrend(coin) {
  const oiData = coin === 'BTC' ? cache.data.btcOI : cache.data.ethOI;
  const frData = coin === 'BTC' ? cache.data.btcFR : cache.data.ethFR;
  const oiHistory = aggregateHistory(coin === 'BTC' ? cache.data.btcOIHistory : cache.data.ethOIHistory);
  const lsHistory = averageLSHistory(coin === 'BTC' ? cache.data.btcLSHistory : cache.data.ethLSHistory);
  
  let signals = { bullish: 0, bearish: 0, reasons: [] };
  
  // 1. Funding Rate Analysis
  const avgFR = aggregateFR(frData).average;
  if (avgFR > 0.0001) {
    signals.bullish += 1;
    signals.reasons.push('Positive funding rate indicates bullish sentiment');
  } else if (avgFR < -0.0001) {
    signals.bearish += 1;
    signals.reasons.push('Negative funding rate indicates bearish sentiment');
  }
  
  // 2. Open Interest Trend (compare first vs last third of data)
  if (oiHistory.length >= 6) {
    const firstThird = oiHistory.slice(0, Math.floor(oiHistory.length / 3));
    const lastThird = oiHistory.slice(-Math.floor(oiHistory.length / 3));
    const avgFirst = firstThird.reduce((s, i) => s + i.value, 0) / firstThird.length;
    const avgLast = lastThird.reduce((s, i) => s + i.value, 0) / lastThird.length;
    const oiChange = ((avgLast - avgFirst) / avgFirst) * 100;
    
    if (oiChange > 5) {
      signals.bullish += 1;
      signals.reasons.push(`Open Interest up ${oiChange.toFixed(1)}% - new money entering`);
    } else if (oiChange < -5) {
      signals.bearish += 1;
      signals.reasons.push(`Open Interest down ${Math.abs(oiChange).toFixed(1)}% - positions closing`);
    }
  }
  
  // 3. Long/Short Ratio
  if (lsHistory.length > 0) {
    const latestLS = lsHistory[lsHistory.length - 1];
    if (latestLS.ratio > 1.1) {
      signals.bullish += 1;
      signals.reasons.push(`Long/Short ratio ${latestLS.ratio.toFixed(2)} - more longs than shorts`);
    } else if (latestLS.ratio < 0.9) {
      signals.bearish += 1;
      signals.reasons.push(`Long/Short ratio ${latestLS.ratio.toFixed(2)} - more shorts than longs`);
    }
  }
  
  // Determine overall trend
  let trend = 'neutral';
  let confidence = 'low';
  
  if (signals.bullish > signals.bearish) {
    trend = 'bullish';
    confidence = signals.bullish >= 2 ? 'moderate' : 'low';
  } else if (signals.bearish > signals.bullish) {
    trend = 'bearish';
    confidence = signals.bearish >= 2 ? 'moderate' : 'low';
  }
  
  if (signals.bullish >= 3 || signals.bearish >= 3) {
    confidence = 'high';
  }
  
  return {
    trend,
    confidence,
    signals: {
      bullish: signals.bullish,
      bearish: signals.bearish
    },
    reasons: signals.reasons
  };
}

// ============================================
// API ENDPOINTS
// ============================================
app.get('/api/open-interest/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcOI : cache.data.ethOI;
  if (!data) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, ...aggregateOI(data), timestamp: cache.lastUpdate });
});

app.get('/api/funding-rate/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcFR : cache.data.ethFR;
  if (!data) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, ...aggregateFR(data), timestamp: cache.lastUpdate });
});

app.get('/api/open-interest-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcOIHistory : cache.data.ethOIHistory;
  if (!data) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, history: aggregateHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/funding-rate-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcFRHistory : cache.data.ethFRHistory;
  if (!data) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, history: averageHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/long-short-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcLSHistory : cache.data.ethLSHistory;
  if (!data) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, history: averageLSHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/trend/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  if (!cache.data.btcOI) return res.status(503).json({ error: 'Loading...' });
  res.json({ coin, ...analyzeTrend(coin), timestamp: cache.lastUpdate });
});

app.get('/api/debug', (req, res) => {
  res.json({
    exchanges: { ...COINALYZE_EXCHANGES, 'HYPERLIQUID': 'Hyperliquid' },
    btcSymbols: cache.btcSymbols,
    ethSymbols: cache.ethSymbols,
    lastUpdate: cache.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START
// ============================================
app.listen(PORT, async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   🚀 Crypto Derivatives Dashboard');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Server: http://localhost:${PORT}`);
  console.log('   Exchanges: Binance, Bybit, Huobi, OKX, Hyperliquid');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  
  await initializeSymbols();
  await sleep(2000);
  await refreshAllData();
  
  setInterval(async () => {
    console.log('🔄 Refreshing...');
    await refreshAllData();
  }, CACHE_TTL);
});