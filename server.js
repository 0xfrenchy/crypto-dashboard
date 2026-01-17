require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// API CONFIGURATIONS
// ============================================

const COINALYZE_API = 'https://api.coinalyze.net/v1';
const API_KEY = process.env.COINALYZE_API_KEY;
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

// Exchanges we want from Coinalyze
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
// INITIALIZE - Get ONE symbol per exchange
// ============================================
async function initializeSymbols() {
  try {
    console.log('🔍 Fetching Coinalyze futures markets...');
    const markets = await coinalyzeRequest('/future-markets');
    
    const wantedCodes = Object.keys(COINALYZE_EXCHANGES);
    
    // Get BTC perpetuals, prefer USDT over USD
    const btcMarkets = markets.filter(m => {
      const code = m.symbol.split('.')[1];
      return m.base_asset === 'BTC' && 
             m.is_perpetual && 
             wantedCodes.includes(code);
    });
    
    // Get ETH perpetuals
    const ethMarkets = markets.filter(m => {
      const code = m.symbol.split('.')[1];
      return m.base_asset === 'ETH' && 
             m.is_perpetual && 
             wantedCodes.includes(code);
    });

    // Pick ONE symbol per exchange (prefer USDT_PERP)
    cache.btcSymbols = pickOnePerExchange(btcMarkets);
    cache.ethSymbols = pickOnePerExchange(ethMarkets);

    console.log('');
    console.log('📊 Selected symbols (one per exchange):');
    console.log(`   BTC: ${cache.btcSymbols.join(', ')}`);
    console.log(`   ETH: ${cache.ethSymbols.join(', ')}`);
    console.log('');
    
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize:', error.message);
    // Fallback to known good symbols
    cache.btcSymbols = ['BTCUSDT_PERP.A', 'BTCUSDT.6', 'BTCUSDT_PERP.3'];
    cache.ethSymbols = ['ETHUSDT_PERP.A', 'ETHUSDT.6', 'ETHUSDT_PERP.3'];
    return false;
  }
}

// Pick one symbol per exchange, preferring USDT perpetuals
function pickOnePerExchange(markets) {
  const byExchange = {};
  
  for (const m of markets) {
    const code = m.symbol.split('.')[1];
    const isUSDT = m.quote_asset === 'USDT';
    const isPreferred = m.symbol.includes('USDT_PERP') || m.symbol.includes('USDT.');
    
    // If we don't have this exchange yet, or this is a better symbol
    if (!byExchange[code] || (isUSDT && isPreferred)) {
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
    console.log('  🌐 Fetching Hyperliquid data...');
    
    const metaData = await hyperliquidRequest({ type: 'metaAndAssetCtxs' });
    const universe = metaData[0].universe;
    const assetCtxs = metaData[1];
    
    const btcIndex = universe.findIndex(a => a.name === 'BTC');
    const ethIndex = universe.findIndex(a => a.name === 'ETH');
    
    let btcData = null;
    let ethData = null;
    
    if (btcIndex !== -1 && assetCtxs[btcIndex]) {
      const ctx = assetCtxs[btcIndex];
      btcData = {
        openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx),
        fundingRate: parseFloat(ctx.funding), // This is hourly rate
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
// REFRESH ALL DATA
// ============================================
async function refreshAllData() {
  if (cache.isRefreshing) {
    console.log('⏳ Refresh already in progress...');
    return;
  }
  
  cache.isRefreshing = true;
  console.log('🔄 Refreshing all data...');
  
  try {
    const btcSymbolsStr = cache.btcSymbols.join(',');
    const ethSymbolsStr = cache.ethSymbols.join(',');
    
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    // Fetch Hyperliquid first
    const hyperliquid = await fetchHyperliquidData();
    await sleep(500);

    // Fetch Coinalyze data
    console.log('  📈 Fetching BTC Open Interest...');
    const coinalyzeBtcOI = await coinalyzeRequest('/open-interest', { 
      symbols: btcSymbolsStr, 
      convert_to_usd: 'true' 
    });
    await sleep(1500);

    console.log('  📈 Fetching ETH Open Interest...');
    const coinalyzeEthOI = await coinalyzeRequest('/open-interest', { 
      symbols: ethSymbolsStr, 
      convert_to_usd: 'true' 
    });
    await sleep(1500);

    console.log('  💰 Fetching BTC Funding Rate...');
    const coinalyzeBtcFR = await coinalyzeRequest('/funding-rate', { 
      symbols: btcSymbolsStr 
    });
    await sleep(1500);

    console.log('  💰 Fetching ETH Funding Rate...');
    const coinalyzeEthFR = await coinalyzeRequest('/funding-rate', { 
      symbols: ethSymbolsStr 
    });
    await sleep(1500);

    console.log('  📊 Fetching BTC OI History...');
    const coinalyzeBtcOIHistory = await coinalyzeRequest('/open-interest-history', {
      symbols: btcSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now,
      convert_to_usd: 'true'
    });
    await sleep(1500);

    console.log('  📊 Fetching ETH OI History...');
    const coinalyzeEthOIHistory = await coinalyzeRequest('/open-interest-history', {
      symbols: ethSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now,
      convert_to_usd: 'true'
    });
    await sleep(1500);

    console.log('  📊 Fetching BTC FR History...');
    const coinalyzeBtcFRHistory = await coinalyzeRequest('/funding-rate-history', {
      symbols: btcSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    console.log('  📊 Fetching ETH FR History...');
    const coinalyzeEthFRHistory = await coinalyzeRequest('/funding-rate-history', {
      symbols: ethSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    // Long/Short ratio
    console.log('  ⚖️ Fetching BTC Long/Short...');
    const coinalyzeBtcLS = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: btcSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    console.log('  ⚖️ Fetching ETH Long/Short...');
    const coinalyzeEthLS = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: ethSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });

    // ============================================
    // MERGE & CLEAN DATA
    // ============================================
    
    // Open Interest
    cache.data.btcOI = [...coinalyzeBtcOI];
    if (hyperliquid.btc) {
      cache.data.btcOI.push({
        symbol: 'BTC.HYPERLIQUID',
        value: hyperliquid.btc.openInterest,
        update: Date.now()
      });
    }
    
    cache.data.ethOI = [...coinalyzeEthOI];
    if (hyperliquid.eth) {
      cache.data.ethOI.push({
        symbol: 'ETH.HYPERLIQUID',
        value: hyperliquid.eth.openInterest,
        update: Date.now()
      });
    }
    
    // Funding Rate - filter out bad data
    cache.data.btcFR = filterValidFundingRates(coinalyzeBtcFR);
    if (hyperliquid.btc && isValidFundingRate(hyperliquid.btc.fundingRate)) {
      cache.data.btcFR.push({
        symbol: 'BTC.HYPERLIQUID',
        value: hyperliquid.btc.fundingRate,
        update: Date.now()
      });
    }
    
    cache.data.ethFR = filterValidFundingRates(coinalyzeEthFR);
    if (hyperliquid.eth && isValidFundingRate(hyperliquid.eth.fundingRate)) {
      cache.data.ethFR.push({
        symbol: 'ETH.HYPERLIQUID',
        value: hyperliquid.eth.fundingRate,
        update: Date.now()
      });
    }
    
    // History data
    cache.data.btcOIHistory = coinalyzeBtcOIHistory;
    cache.data.ethOIHistory = coinalyzeEthOIHistory;
    cache.data.btcFRHistory = coinalyzeBtcFRHistory;
    cache.data.ethFRHistory = coinalyzeEthFRHistory;
    cache.data.btcLSHistory = coinalyzeBtcLS;
    cache.data.ethLSHistory = coinalyzeEthLS;

    cache.lastUpdate = Date.now();
    console.log('✅ All data refreshed successfully!');
    console.log('');
    
  } catch (error) {
    console.error('❌ Error refreshing data:', error.message);
  } finally {
    cache.isRefreshing = false;
  }
}

// ============================================
// DATA VALIDATION & CLEANING
// ============================================

// Valid funding rate is typically between -0.5% and +0.5% (as decimal: -0.005 to 0.005)
// Anything outside this range is likely bad data
function isValidFundingRate(rate) {
  if (rate === null || rate === undefined) return false;
  // Funding rates are in decimal form, so 0.0001 = 0.01%
  // Valid range: -0.005 to 0.005 (which is -0.5% to +0.5%)
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

// ============================================
// AGGREGATION HELPERS
// ============================================

function aggregateOI(data) {
  if (!data || !Array.isArray(data)) return { total: 0, byExchange: [] };
  
  // Aggregate by exchange name (in case of any remaining duplicates)
  const byExchangeMap = {};
  
  data.forEach(item => {
    if (!item.value) return;
    const exchange = getExchangeName(item.symbol);
    if (!byExchangeMap[exchange]) {
      byExchangeMap[exchange] = 0;
    }
    byExchangeMap[exchange] += item.value;
  });
  
  const byExchange = Object.entries(byExchangeMap)
    .map(([exchange, value]) => ({ exchange, value }))
    .sort((a, b) => b.value - a.value);
  
  const total = byExchange.reduce((sum, item) => sum + item.value, 0);
  
  return { total, byExchange };
}

function aggregateFR(data) {
  if (!data || !Array.isArray(data)) return { average: 0, byExchange: [] };
  
  // Aggregate by exchange name
  const byExchangeMap = {};
  
  data.forEach(item => {
    if (item.value === null || item.value === undefined) return;
    const exchange = getExchangeName(item.symbol);
    if (!byExchangeMap[exchange]) {
      byExchangeMap[exchange] = { sum: 0, count: 0 };
    }
    byExchangeMap[exchange].sum += item.value;
    byExchangeMap[exchange].count += 1;
  });
  
  const byExchange = Object.entries(byExchangeMap)
    .map(([exchange, { sum, count }]) => ({ 
      exchange, 
      value: count > 0 ? sum / count : 0 
    }))
    .filter(item => item.value !== 0);
  
  const average = byExchange.length > 0
    ? byExchange.reduce((sum, item) => sum + item.value, 0) / byExchange.length
    : 0;
  
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
    .map(([t, value]) => ({ t: parseInt(t), value }))
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
    .map(([t, { sum, count }]) => ({ t: parseInt(t), value: count > 0 ? sum / count : 0 }))
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
      t: parseInt(t),
      ratio: count > 0 ? ratioSum / count : 1,
      long: count > 0 ? longSum / count : 50,
      short: count > 0 ? shortSum / count : 50
    }))
    .sort((a, b) => a.t - b.t);
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/open-interest/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcOI : cache.data.ethOI;
  
  if (!data) {
    return res.status(503).json({ error: 'Data not yet loaded. Please wait...' });
  }
  
  const result = aggregateOI(data);
  res.json({ coin, ...result, timestamp: cache.lastUpdate });
});

app.get('/api/funding-rate/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcFR : cache.data.ethFR;
  
  if (!data) {
    return res.status(503).json({ error: 'Data not yet loaded. Please wait...' });
  }
  
  const result = aggregateFR(data);
  res.json({ coin, ...result, timestamp: cache.lastUpdate });
});

app.get('/api/open-interest-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcOIHistory : cache.data.ethOIHistory;
  
  if (!data) {
    return res.status(503).json({ error: 'Data not yet loaded. Please wait...' });
  }
  
  res.json({ coin, history: aggregateHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/funding-rate-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcFRHistory : cache.data.ethFRHistory;
  
  if (!data) {
    return res.status(503).json({ error: 'Data not yet loaded. Please wait...' });
  }
  
  res.json({ coin, history: averageHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/long-short-history/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase();
  const data = coin === 'BTC' ? cache.data.btcLSHistory : cache.data.ethLSHistory;
  
  if (!data) {
    return res.status(503).json({ error: 'Data not yet loaded. Please wait...' });
  }
  
  res.json({ coin, history: averageLSHistory(data), timestamp: cache.lastUpdate });
});

app.get('/api/debug', (req, res) => {
  res.json({
    exchanges: { ...COINALYZE_EXCHANGES, 'HYPERLIQUID': 'Hyperliquid' },
    btcSymbols: cache.btcSymbols,
    ethSymbols: cache.ethSymbols,
    lastUpdate: cache.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
    isRefreshing: cache.isRefreshing,
    rawData: {
      btcOI: cache.data.btcOI,
      btcFR: cache.data.btcFR,
      ethOI: cache.data.ethOI,
      ethFR: cache.data.ethFR
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   🚀 Crypto Derivatives Dashboard');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Server: http://localhost:${PORT}`);
  console.log('');
  console.log('   Data Sources:');
  console.log('   • Coinalyze: Binance, Bybit, Huobi, OKX');
  console.log('   • Hyperliquid: Direct API');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('⏳ Loading initial data...');
  console.log('');
  
  await initializeSymbols();
  await sleep(2000);
  await refreshAllData();
  
  setInterval(async () => {
    console.log('🔄 Scheduled refresh...');
    await refreshAllData();
  }, CACHE_TTL);
});