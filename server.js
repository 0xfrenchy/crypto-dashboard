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

// Symbol mappings for multiple exchanges
// Format: SYMBOL_PERP.EXCHANGE_CODE
// Exchange codes: A=Binance, 0=Bitmex, 6=Bybit, 5=OKX, 4=Deribit, B=Bitget
const SYMBOLS = {
  BTC: [
    'BTCUSDT_PERP.A',   // Binance
    'BTCUSDT_PERP.6',   // Bybit
    'BTCUSDT_PERP.5',   // OKX
    'BTCUSDT_PERP.B',   // Bitget
  ],
  ETH: [
    'ETHUSDT_PERP.A',   // Binance
    'ETHUSDT_PERP.6',   // Bybit
    'ETHUSDT_PERP.5',   // OKX
    'ETHUSDT_PERP.B',   // Bitget
  ]
};

// Helper function to make API calls
async function coinalyzeRequest(endpoint, params = {}) {
  const queryParams = new URLSearchParams({ ...params, api_key: API_KEY });
  const url = `${COINALYZE_API}${endpoint}?${queryParams}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching ${endpoint}:`, error.message);
    throw error;
  }
}

// Get current open interest for a coin
app.get('/api/open-interest/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const symbols = SYMBOLS[coin];
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const data = await coinalyzeRequest('/open-interest', {
      symbols: symbols.join(','),
      convert_to_usd: 'true'
    });

    // Aggregate values from all exchanges
    const totalOI = data.reduce((sum, item) => sum + (item.value || 0), 0);
    const byExchange = data.map(item => ({
      exchange: getExchangeName(item.symbol),
      value: item.value,
      symbol: item.symbol
    }));

    res.json({
      coin,
      total: totalOI,
      byExchange,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current funding rate for a coin
app.get('/api/funding-rate/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const symbols = SYMBOLS[coin];
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const data = await coinalyzeRequest('/funding-rate', {
      symbols: symbols.join(',')
    });

    // Calculate weighted average (simple average for now)
    const validRates = data.filter(item => item.value !== null && item.value !== undefined);
    const avgRate = validRates.length > 0 
      ? validRates.reduce((sum, item) => sum + item.value, 0) / validRates.length 
      : 0;

    const byExchange = data.map(item => ({
      exchange: getExchangeName(item.symbol),
      value: item.value,
      symbol: item.symbol
    }));

    res.json({
      coin,
      average: avgRate,
      byExchange,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get open interest history (24h)
app.get('/api/open-interest-history/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const symbols = SYMBOLS[coin];
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/open-interest-history', {
      symbols: symbols.join(','),
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
    res.status(500).json({ error: error.message });
  }
});

// Get funding rate history (24h)
app.get('/api/funding-rate-history/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const symbols = SYMBOLS[coin];
    
    if (!symbols) {
      return res.status(400).json({ error: 'Invalid coin. Use BTC or ETH.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/funding-rate-history', {
      symbols: symbols.join(','),
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
    res.status(500).json({ error: error.message });
  }
});

// Get long/short ratio history (24h)
app.get('/api/long-short-history/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    // Long/short ratio is only available on some exchanges
    const symbols = coin === 'BTC' 
      ? ['BTCUSDT_PERP.A', 'BTCUSDT_PERP.6'] 
      : ['ETHUSDT_PERP.A', 'ETHUSDT_PERP.6'];
    
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    const data = await coinalyzeRequest('/long-short-ratio-history', {
      symbols: symbols.join(','),
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
    res.status(500).json({ error: error.message });
  }
});

// Get all current data for dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const btcSymbols = SYMBOLS.BTC.join(',');
    const ethSymbols = SYMBOLS.ETH.join(',');
    const allSymbols = [...SYMBOLS.BTC, ...SYMBOLS.ETH].join(',');

    // Fetch current data in parallel
    const [btcOI, ethOI, btcFR, ethFR] = await Promise.all([
      coinalyzeRequest('/open-interest', { symbols: btcSymbols, convert_to_usd: 'true' }),
      coinalyzeRequest('/open-interest', { symbols: ethSymbols, convert_to_usd: 'true' }),
      coinalyzeRequest('/funding-rate', { symbols: btcSymbols }),
      coinalyzeRequest('/funding-rate', { symbols: ethSymbols })
    ]);

    // Aggregate
    const btcTotalOI = btcOI.reduce((sum, item) => sum + (item.value || 0), 0);
    const ethTotalOI = ethOI.reduce((sum, item) => sum + (item.value || 0), 0);
    
    const btcAvgFR = btcFR.filter(i => i.value != null).reduce((sum, i) => sum + i.value, 0) / btcFR.filter(i => i.value != null).length || 0;
    const ethAvgFR = ethFR.filter(i => i.value != null).reduce((sum, i) => sum + i.value, 0) / ethFR.filter(i => i.value != null).length || 0;

    res.json({
      btc: {
        openInterest: { total: btcTotalOI, byExchange: btcOI.map(i => ({ exchange: getExchangeName(i.symbol), value: i.value })) },
        fundingRate: { average: btcAvgFR, byExchange: btcFR.map(i => ({ exchange: getExchangeName(i.symbol), value: i.value })) }
      },
      eth: {
        openInterest: { total: ethTotalOI, byExchange: ethOI.map(i => ({ exchange: getExchangeName(i.symbol), value: i.value })) },
        fundingRate: { average: ethAvgFR, byExchange: ethFR.map(i => ({ exchange: getExchangeName(i.symbol), value: i.value })) }
      },
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper: Get exchange name from symbol
function getExchangeName(symbol) {
  const code = symbol.split('.')[1];
  const exchanges = {
    'A': 'Binance',
    '0': 'BitMEX',
    '6': 'Bybit',
    '5': 'OKX',
    '4': 'Deribit',
    'B': 'Bitget'
  };
  return exchanges[code] || code;
}

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
app.listen(PORT, () => {
  console.log(`🚀 Crypto Dashboard server running on port ${PORT}`);
  console.log(`📊 Open http://localhost:${PORT} in your browser`);
});
