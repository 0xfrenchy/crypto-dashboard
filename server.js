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

// Coinalyze
const COINALYZE_API = 'https://api.coinalyze.net/v1';
const API_KEY = process.env.COINALYZE_API_KEY;

// Hyperliquid (no API key needed)
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

// Exchanges from Coinalyze (4 exchanges)
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
  // Coinalyze symbols
  btcSymbols: [],
  ethSymbols: [],
  
  // Combined data (Coinalyze + Hyperliquid)
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

const CACHE_TTL = 60 * 1000; // 60 seconds

// ============================================
// COINALYZE API HELPER
// ============================================
async function coinalyzeRequest(endpoint, params = {}, retries = 3) {
  const queryParams = new URLSearchParams({ ...params, api_key: API_KEY });
  const url = `${COINALYZE_API}${endpoint}?${queryParams}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '5');
        console.log(`⏳ Rate limited on ${endpoint}, waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
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

// ============================================
// HYPERLIQUID API HELPER
// ============================================
async function hyperliquidRequest(body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(HYPERLIQUID_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        throw new Error(`Hyperliquid API error: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      if (attempt === retries) {
        console.error(`❌ Hyperliquid request failed:`, error.message);
        throw error;
      }
      await sleep(2000 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getExchangeName(symbol) {
  const code = symbol.split('.')[1];
  return COINALYZE_EXCHANGES[code] || code;
}

// ============================================
// INITIALIZE COINALYZE SYMBOLS
// ============================================
async function initializeSymbols() {
  try {
    console.log('🔍 Fetching Coinalyze futures markets...');
    const markets = await coinalyzeRequest('/future-markets');
    
    const wantedCodes = Object.keys(COINALYZE_EXCHANGES);
    
    cache.btcSymbols = markets
      .filter(m => {
        const code = m.symbol.split('.')[1];
        return m.base_asset === 'BTC' && 
               m.is_perpetual && 
               (m.quote_asset === 'USDT' || m.quote_asset === 'USD') &&
               wantedCodes.includes(code);
      })
      .map(m => m.symbol);
    
    cache.ethSymbols = markets
      .filter(m => {
        const code = m.symbol.split('.')[1];
        return m.base_asset === 'ETH' && 
               m.is_perpetual && 
               (m.quote_asset === 'USDT' || m.quote_asset === 'USD') &&
               wantedCodes.includes(code);
      })
      .map(m => m.symbol);

    console.log('');
    console.log('📊 Coinalyze Exchanges:', Object.values(COINALYZE_EXCHANGES).join(', '));
    console.log(`   BTC symbols: ${cache.btcSymbols.join(', ')}`);
    console.log(`   ETH symbols: ${cache.ethSymbols.join(', ')}`);
    console.log('');
    console.log('📊 Hyperliquid: Direct API (no key needed)');
    console.log('');
    
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Coinalyze:', error.message);
    // Fallback
    cache.btcSymbols = ['BTCUSDT_PERP.A', 'BTCUSDT.6', 'BTCUSDT_PERP.4', 'BTCUSDT_PERP.3'];
    cache.ethSymbols = ['ETHUSDT_PERP.A', 'ETHUSDT.6', 'ETHUSDT_PERP.4', 'ETHUSDT_PERP.3'];
    return false;
  }
}

// ============================================
// FETCH HYPERLIQUID DATA
// ============================================
async function fetchHyperliquidData() {
  try {
    console.log('  🌐 Fetching Hyperliquid data...');
    
    // Get current market data (includes OI and funding rate)
    const metaData = await hyperliquidRequest({ type: 'metaAndAssetCtxs' });
    
    // metaData[0] = universe (list of assets)
    // metaData[1] = asset contexts (current data for each asset)
    const universe = metaData[0].universe;
    const assetCtxs = metaData[1];
    
    // Find BTC and ETH indices
    const btcIndex = universe.findIndex(a => a.name === 'BTC');
    const ethIndex = universe.findIndex(a => a.name === 'ETH');
    
    let btcData = null;
    let ethData = null;
    
    if (btcIndex !== -1 && assetCtxs[btcIndex]) {
      const ctx = assetCtxs[btcIndex];
      btcData = {
        openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx), // Convert to USD
        fundingRate: parseFloat(ctx.funding),
        markPrice: parseFloat(ctx.markPx)
      };
    }
    
    if (ethIndex !== -1 && assetCtxs[ethIndex]) {
      const ctx = assetCtxs[ethIndex];
      ethData = {
        openInterest: parseFloat(ctx.openInterest) * parseFloat(ctx.markPx), // Convert to USD
        fundingRate: parseFloat(ctx.funding),
        markPrice: parseFloat(ctx.markPx)
      };
    }
    
    // Get funding history for charts (last 24 hours)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    const [btcFundingHistory, ethFundingHistory] = await Promise.all([
      hyperliquidRequest({ type: 'fundingHistory', coin: 'BTC', startTime: oneDayAgo }),
      hyperliquidRequest({ type: 'fundingHistory', coin: 'ETH', startTime: oneDayAgo })
    ]);
    
    return {
      btc: btcData,
      eth: ethData,
      btcFundingHistory: btcFundingHistory || [],
      ethFundingHistory: ethFundingHistory || []
    };
  } catch (error) {
    console.error('  ❌ Hyperliquid error:', error.message);
    return { btc: null, eth: null, btcFundingHistory: [], ethFundingHistory: [] };
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

    // Fetch Hyperliquid first (no rate limit concerns)
    const hyperliquid = await fetchHyperliquidData();
    await sleep(500);

    // Fetch Coinalyze data with delays
    console.log('  📈 Fetching Coinalyze BTC Open Interest...');
    const coinalyzeBtcOI = await coinalyzeRequest('/open-interest', { 
      symbols: btcSymbolsStr, 
      convert_to_usd: 'true' 
    });
    await sleep(1500);

    console.log('  📈 Fetching Coinalyze ETH Open Interest...');
    const coinalyzeEthOI = await coinalyzeRequest('/open-interest', { 
      symbols: ethSymbolsStr, 
      convert_to_usd: 'true' 
    });
    await sleep(1500);

    console.log('  💰 Fetching Coinalyze BTC Funding Rate...');
    const coinalyzeBtcFR = await coinalyzeRequest('/funding-rate', { 
      symbols: btcSymbolsStr 
    });
    await sleep(1500);

    console.log('  💰 Fetching Coinalyze ETH Funding Rate...');
    const coinalyzeEthFR = await coinalyzeRequest('/funding-rate', { 
      symbols: ethSymbolsStr 
    });
    await sleep(1500);

    console.log('  📊 Fetching Coinalyze BTC OI History...');
    const coinalyzeBtcOIHistory = await coinalyzeRequest('/open-interest-history', {
      symbols: btcSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now,
      convert_to_usd: 'true'
    });
    await sleep(1500);

    console.log('  📊 Fetching Coinalyze ETH OI History...');
    const coinalyzeEthOIHistory = await coinalyzeRequest('/open-interest-history', {
      symbols: ethSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now,
      convert_to_usd: 'true'
    });
    await sleep(1500);

    console.log('  📊 Fetching Coinalyze BTC FR History...');
    const coinalyzeBtcFRHistory = await coinalyzeRequest('/funding-rate-history', {
      symbols: btcSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    console.log('  📊 Fetching Coinalyze ETH FR History...');
    const coinalyzeEthFRHistory = await coinalyzeRequest('/funding-rate-history', {
      symbols: ethSymbolsStr,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    // Long/Short ratio
    const btcLSSymbols = cache.btcSymbols.slice(0, 3).join(',');
    const ethLSSymbols = cache.ethSymbols.slice(0, 3).join(',');

    console.log('  ⚖️ Fetching Coinalyze BTC Long/Short...');
    const coinalyzeBtcLS = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: btcLSSymbols,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });
    await sleep(1500);

    console.log('  ⚖️ Fetching Coinalyze ETH Long/Short...');
    const coinalyzeEthLS = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: ethLSSymbols,
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });

    // ============================================
    // MERGE COINALYZE + HYPERLIQUID DATA
    // ============================================
    
    // Open Interest - add Hyperliquid to the array
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
    
    // Funding Rate - add Hyperliquid
    cache.data.btcFR = [...coinalyzeBtcFR];
    if (hyperliquid.btc) {
      cache.data.btcFR.push({
        symbol: 'BTC.HYPERLIQUID',
        value: hyperliquid.btc.fundingRate,
        update: Date.now()
      });
    }
    
    cache.data.ethFR = [...coinalyzeEthFR];
    if (hyperliquid.eth) {
      cache.data.ethFR.push({
        symbol: 'ETH.HYPERLIQUID',
        value: hyperliquid.eth.fundingRate,
        update: Date.now()
      });
    }
    
    // History data (Coinalyze only for now, Hyperliquid funding history is different format)
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
// HELPER FUNCTIONS
// ============================================
function getExchangeNameFromSymbol(symbol) {
  if (symbol.includes('HYPERLIQUID')) {
    return 'Hyperliquid';
  }
  const code = symbol.split('.')[1];
  return COINALYZE_EXCHANGES[code] || code;
}

function aggregateOI(data) {
  if (!data || !Array.isArray(data)) return { total: 0, byExchange: [] };
  
  const total = data.reduce((sum, item) => sum + (item.value || 0), 0);
  const byExchange = data
    .filter(item => item.value)
    .map(item => ({
      exchange: getExchangeNameFromSymbol(item.symbol),
      value: item.value
    }))
    .sort((a, b) => b.value - a.value);
  
  return { total, byExchange };
}

function aggregateFR(data) {
  if (!data || !Array.isArray(data)) return { average: 0, byExchange: [] };
  
  const valid = data.filter(item => item.value != null);
  const average = valid.length ? valid.reduce((sum, i) => sum + i.value, 0) / valid.length : 0;
  const byExchange = valid.map(item => ({
    exchange: getExchangeNameFromSymbol(item.symbol),
    value: item.value
  }));
  
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
        if (point.c != null) {
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
    coinalyzeExchanges: COINALYZE_EXCHANGES,
    hyperliquid: 'Direct API',
    btcSymbols: cache.btcSymbols,
    ethSymbols: cache.ethSymbols,
    lastUpdate: cache.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
    isRefreshing: cache.isRefreshing,
    dataSample: {
      btcOICount: cache.data.btcOI?.length || 0,
      ethOICount: cache.data.ethOI?.length || 0,
      btcFRCount: cache.data.btcFR?.length || 0,
      ethFRCount: cache.data.ethFR?.length || 0
    }
  });
});

// Serve the frontend
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
  console.log('⏳ Loading initial data (takes ~20s to respect rate limits)...');
  console.log('');
  
  await initializeSymbols();
  await sleep(2000);
  await refreshAllData();
  
  // Refresh every 60 seconds
  setInterval(async () => {
    console.log('🔄 Scheduled refresh starting...');
    await refreshAllData();
  }, CACHE_TTL);
});