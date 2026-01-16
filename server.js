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

// Coinalyze API configuration
const COINALYZE_API = 'https://api.coinalyze.net/v1';
const API_KEY = process.env.COINALYZE_API_KEY;

// Cache for exchange codes and symbols
let exchangeMap = {};
let btcSymbols = [];
let ethSymbols = [];
let symbolsInitialized = false;

// Helper function to make API calls
async function coinalyzeRequest(endpoint, params = {}) {
  const queryParams = new URLSearchParams({ ...params, api_key: API_KEY });
  const url = `${COINALYZE_API}${endpoint}?${queryParams}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error: ${response.status} - ${text}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching ${endpoint}:`, error.message);
    throw error;
  }
}

// Initialize: fetch exchanges and available symbols
async function initializeSymbols() {
  try {
    console.log('🔍 Fetching available exchanges...');
    const exchanges = await coinalyzeRequest('/exchanges');
    
    // Build exchange code -> name mapping
    exchanges.forEach(ex => {
      exchangeMap[ex.code] = ex.name;
    });
    console.log('📊 Available exchanges:', Object.values(exchangeMap).join(', '));

    console.log('🔍 Fetching available futures markets...');
    const markets = await coinalyzeRequest('/future-markets');
    
    // Filter for BTC and ETH USDT perpetuals
    const btcMarkets = markets.filter(m => 
      m.base_asset === 'BTC' && 
      m.is_perpetual && 
      m.quote_asset === 'USDT'
    );
    
    const ethMarkets = markets.filter(m => 
      m.base_asset === 'ETH' && 
      m.is_perpetual && 
      m.quote_asset === 'USDT'
    );

    btcSymbols = btcMarkets.map(m => m.symbol);
    ethSymbols = ethMarkets.map(m => m.symbol);

    console.log(`✅ Found ${btcSymbols.length} BTC perpetual markets:`, btcSymbols.slice(0, 10).join(', '), btcSymbols.length > 10 ? '...' : '');
    console.log(`✅ Found ${ethSymbols.length} ETH perpetual markets:`, ethSymbols.slice(0, 10).join(', '), ethSymbols.length > 10 ? '...' : '');

    symbolsInitialized = true;
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize symbols:', error.message);
    
    // Fallback to known working symbols
    console.log('⚠️ Using fallback symbols...');
    exchangeMap = {
      'A': 'Binance',
      '6': 'Bybit', 
      '5': 'OKX',
      'B': 'Bitget',
      '0': 'BitMEX',
      '4': 'Deribit'
    };
    btcSymbols = ['BTCUSDT_PERP.A'];
    ethSymbols = ['ETHUSDT_PERP.A'];
    symbolsInitialized = true;
    return false;
  }
}

// Get exchange name from symbol
function getExchangeName(symbol) {
  const code = symbol.split('.')[1];
  return exchangeMap[code] || code;
}

// Limit symbols to avoid rate limiting (max 20 per request)
function limitSymbols(symbols, max = 8) {
  // Prioritize major exchanges
  const priority = ['A', '6', '5', 'B', '0', '4']; // Binance, Bybit, OKX, Bitget, BitMEX, Deribit
  
  const sorted = [...symbols].sort((a, b) => {
    const codeA = a.split('.')[1];
    const codeB = b.split('.')[1];
    const indexA = priority.indexOf(codeA);
    const indexB = priority.indexOf(codeB);
    
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });
  
  return sorted.slice(0, max);
}

// Get current open interest for a coin
app.get('/api/open-interest/:coin', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const coin = req.params.coin.toUpperCase();
    const symbols = coin === 'BTC' ? btcSymbols : coin === 'ETH' ? ethSymbols : null;
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const limitedSymbols = limitSymbols(symbols);
    console.log(`Fetching OI for ${coin}:`, limitedSymbols.join(', '));

    const data = await coinalyzeRequest('/open-interest', {
      symbols: limitedSymbols.join(','),
      convert_to_usd: 'true'
    });

    // Aggregate values from all exchanges
    const totalOI = data.reduce((sum, item) => sum + (item.value || 0), 0);
    const byExchange = data
      .filter(item => item.value)
      .map(item => ({
        exchange: getExchangeName(item.symbol),
        value: item.value,
        symbol: item.symbol
      }))
      .sort((a, b) => b.value - a.value);

    res.json({
      coin,
      total: totalOI,
      byExchange,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('OI Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current funding rate for a coin
app.get('/api/funding-rate/:coin', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const coin = req.params.coin.toUpperCase();
    const symbols = coin === 'BTC' ? btcSymbols : coin === 'ETH' ? ethSymbols : null;
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const limitedSymbols = limitSymbols(symbols);
    
    const data = await coinalyzeRequest('/funding-rate', {
      symbols: limitedSymbols.join(',')
    });

    // Calculate weighted average (simple average for now)
    const validRates = data.filter(item => item.value !== null && item.value !== undefined);
    const avgRate = validRates.length > 0 
      ? validRates.reduce((sum, item) => sum + item.value, 0) / validRates.length 
      : 0;

    const byExchange = data
      .filter(item => item.value !== null && item.value !== undefined)
      .map(item => ({
        exchange: getExchangeName(item.symbol),
        value: item.value,
        symbol: item.symbol
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    res.json({
      coin,
      average: avgRate,
      byExchange,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('FR Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get open interest history (24h)
app.get('/api/open-interest-history/:coin', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const coin = req.params.coin.toUpperCase();
    const symbols = coin === 'BTC' ? btcSymbols : coin === 'ETH' ? ethSymbols : null;
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const limitedSymbols = limitSymbols(symbols, 5); // Fewer for history to save API calls
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/open-interest-history', {
      symbols: limitedSymbols.join(','),
      interval: '1hour',
      from: oneDayAgo,
      to: now,
      convert_to_usd: 'true'
    });

    // Aggregate by timestamp
    const aggregated = aggregateHistoryData(data);

    res.json({
      coin,
      history: aggregated,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('OI History Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get funding rate history (24h)
app.get('/api/funding-rate-history/:coin', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const coin = req.params.coin.toUpperCase();
    const symbols = coin === 'BTC' ? btcSymbols : coin === 'ETH' ? ethSymbols : null;
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const limitedSymbols = limitSymbols(symbols, 5);
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/funding-rate-history', {
      symbols: limitedSymbols.join(','),
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });

    // Average by timestamp
    const aggregated = averageHistoryData(data);

    res.json({
      coin,
      history: aggregated,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('FR History Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get long/short ratio history (24h)
app.get('/api/long-short-history/:coin', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const coin = req.params.coin.toUpperCase();
    const allSymbols = coin === 'BTC' ? btcSymbols : coin === 'ETH' ? ethSymbols : null;
    
    if (!allSymbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    // Long/short ratio - try major exchanges first
    const limitedSymbols = limitSymbols(allSymbols, 4);
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: limitedSymbols.join(','),
      interval: '1hour',
      from: oneDayAgo,
      to: now
    });

    // Average the ratios by timestamp
    const aggregated = averageLongShortData(data);

    res.json({
      coin,
      history: aggregated,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('LS History Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - show what symbols are being used
app.get('/api/debug', async (req, res) => {
  if (!symbolsInitialized) await initializeSymbols();
  
  res.json({
    exchanges: exchangeMap,
    btcSymbols: btcSymbols,
    ethSymbols: ethSymbols,
    btcLimited: limitSymbols(btcSymbols),
    ethLimited: limitSymbols(ethSymbols)
  });
});

// Get all current data for dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    if (!symbolsInitialized) await initializeSymbols();
    
    const btcLimited = limitSymbols(btcSymbols);
    const ethLimited = limitSymbols(ethSymbols);

    // Fetch current data in parallel
    const [btcOI, ethOI, btcFR, ethFR] = await Promise.all([
      coinalyzeRequest('/open-interest', { symbols: btcLimited.join(','), convert_to_usd: 'true' }),
      coinalyzeRequest('/open-interest', { symbols: ethLimited.join(','), convert_to_usd: 'true' }),
      coinalyzeRequest('/funding-rate', { symbols: btcLimited.join(',') }),
      coinalyzeRequest('/funding-rate', { symbols: ethLimited.join(',') })
    ]);

    // Aggregate
    const btcTotalOI = btcOI.reduce((sum, item) => sum + (item.value || 0), 0);
    const ethTotalOI = ethOI.reduce((sum, item) => sum + (item.value || 0), 0);
    
    const btcValidFR = btcFR.filter(i => i.value != null);
    const ethValidFR = ethFR.filter(i => i.value != null);
    
    const btcAvgFR = btcValidFR.length ? btcValidFR.reduce((sum, i) => sum + i.value, 0) / btcValidFR.length : 0;
    const ethAvgFR = ethValidFR.length ? ethValidFR.reduce((sum, i) => sum + i.value, 0) / ethValidFR.length : 0;

    res.json({
      btc: {
        openInterest: { 
          total: btcTotalOI, 
          byExchange: btcOI
            .filter(i => i.value)
            .map(i => ({ exchange: getExchangeName(i.symbol), value: i.value }))
            .sort((a, b) => b.value - a.value)
        },
        fundingRate: { 
          average: btcAvgFR, 
          byExchange: btcFR
            .filter(i => i.value != null)
            .map(i => ({ exchange: getExchangeName(i.symbol), value: i.value }))
        }
      },
      eth: {
        openInterest: { 
          total: ethTotalOI, 
          byExchange: ethOI
            .filter(i => i.value)
            .map(i => ({ exchange: getExchangeName(i.symbol), value: i.value }))
            .sort((a, b) => b.value - a.value)
        },
        fundingRate: { 
          average: ethAvgFR, 
          byExchange: ethFR
            .filter(i => i.value != null)
            .map(i => ({ exchange: getExchangeName(i.symbol), value: i.value }))
        }
      },
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Dashboard Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Aggregate history data (sum values at each timestamp)
function aggregateHistoryData(data) {
  const byTime = {};
  
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) {
          byTime[point.t] = 0;
        }
        byTime[point.t] += point.c || 0; // Use close value
      });
    }
  });

  return Object.entries(byTime)
    .map(([t, value]) => ({ t: parseInt(t), value }))
    .sort((a, b) => a.t - b.t);
}

// Helper: Average history data (average values at each timestamp)
function averageHistoryData(data) {
  const byTime = {};
  
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) {
          byTime[point.t] = { sum: 0, count: 0 };
        }
        if (point.c !== null && point.c !== undefined) {
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

// Helper: Average long/short ratio data
function averageLongShortData(data) {
  const byTime = {};
  
  data.forEach(item => {
    if (item.history) {
      item.history.forEach(point => {
        if (!byTime[point.t]) {
          byTime[point.t] = { ratioSum: 0, longSum: 0, shortSum: 0, count: 0 };
        }
        if (point.r !== null && point.r !== undefined) {
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

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Crypto Dashboard server running on port ${PORT}`);
  console.log(`📊 Open http://localhost:${PORT} in your browser`);
  
  // Initialize symbols on startup
  await initializeSymbols();
});