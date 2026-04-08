// netlify/functions/yahoo.js
// Yahoo Finance data proxy + symbol search autocomplete
// Always fetches 2 years of data, returns last 500 candles

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function getYahooInterval(timeframe) {
  const map = {
    '1m': '1m', '5m': '5m', '15m': '15m',
    '1h': '60m', '4h': '60m', '1d': '1d', '1wk': '1wk'
  };
  return map[timeframe] || '1d';
}

function normalizeSymbol(symbol, market) {
  symbol = symbol.trim().toUpperCase();
  if (market === 'kr_stock') {
    if (!symbol.includes('.')) symbol += '.KS';
  } else if (market === 'crypto') {
    if (!symbol.includes('-')) symbol += '-USD';
  } else if (market === 'forex') {
    if (!symbol.includes('=')) symbol += '=X';
  }
  return symbol;
}

function aggregateTo4H(candles) {
  if (!candles || candles.length === 0) return candles;
  const result = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length === 0) continue;
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + (c.volume || 0), 0)
    });
  }
  return result;
}

// Detect market type from Yahoo search result
function detectMarket(quoteType, exchange, symbol) {
  if (quoteType === 'CRYPTOCURRENCY') return 'crypto';
  if (quoteType === 'CURRENCY' || quoteType === 'FOREX') return 'forex';
  if (quoteType === 'FUTURE') return 'futures';
  if (exchange && (exchange.includes('KSE') || exchange.includes('KOS') || exchange.includes('KRX'))) return 'kr_stock';
  if (symbol && (symbol.endsWith('.KS') || symbol.endsWith('.KQ'))) return 'kr_stock';
  return 'us_stock';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ── SYMBOL SEARCH (autocomplete) ──
    if (action === 'search') {
      const query = (body.query || '').trim();
      if (!query || query.length < 1) {
        return { statusCode: 200, headers, body: JSON.stringify({ results: [] }) };
      }

      const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=true&quotesQueryId=tss_match_phrase_query`;

      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (!res.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ results: [] }) };
      }

      const data = await res.json();
      const quotes = data.quotes || [];

      const results = quotes
        .filter(q => q.symbol && q.quoteType !== 'OPTION' && q.quoteType !== 'MUTUALFUND')
        .map(q => ({
          symbol: q.symbol,
          name: q.shortname || q.longname || q.symbol,
          exchange: q.exchDisp || q.exchange || '',
          type: q.quoteType || '',
          market: detectMarket(q.quoteType, q.exchange, q.symbol)
        }))
        .slice(0, 6);

      return { statusCode: 200, headers, body: JSON.stringify({ results }) };
    }

    // ── CHART DATA ──
    let { symbol, market, timeframe, endDate } = body;

    if (!symbol) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '심볼을 입력해주세요.' }) };
    }

    symbol = normalizeSymbol(symbol, market);
    const is4H = timeframe === '4h';
    const interval = is4H ? '60m' : getYahooInterval(timeframe || '1d');

    // Lookback days per timeframe (to ensure ~500 candles)
    const lookbackDays = {
      '1m': 7, '5m': 60, '15m': 60,
      '1h': 120, '4h': 500,
      '1d': 730, '1wk': 3650
    };

    let url;
    const isBacktest = !!endDate;
    if (isBacktest) {
      // Backtesting: fetch candles ending at endDate
      const endUnix = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);
      const days = lookbackDays[timeframe] || 730;
      const startUnix = endUnix - (days * 86400);
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${startUnix}&period2=${endUnix}&includePrePost=false`;
    } else {
      // Normal: latest data
      const rangeMap = {
        '1m': '7d', '5m': '60d', '15m': '60d',
        '1h': '730d', '4h': '730d',
        '1d': '2y', '1wk': '2y'
      };
      const range = rangeMap[timeframe] || '2y';
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    }

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      const text = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: `Yahoo Finance 오류: ${response.status}. 심볼을 확인해주세요.`, detail: text.substring(0, 200) }) };
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: '데이터를 찾을 수 없습니다. 심볼을 확인해주세요.' }) };
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    let candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] != null && closes[i] != null && highs[i] != null && lows[i] != null) {
        candles.push({
          time: timestamps[i],
          open: parseFloat(opens[i].toFixed(6)),
          high: parseFloat(highs[i].toFixed(6)),
          low: parseFloat(lows[i].toFixed(6)),
          close: parseFloat(closes[i].toFixed(6)),
          volume: volumes[i] || 0
        });
      }
    }

    if (is4H) candles = aggregateTo4H(candles);

    // Total fetched count before slicing
    const totalFetched = candles.length;

    // Return only last 500 candles
    const MAX_CANDLES = 500;
    if (candles.length > MAX_CANDLES) {
      candles = candles.slice(-MAX_CANDLES);
    }

    const meta = result.meta || {};
    const firstDate = candles.length > 0 ? new Date(candles[0].time * 1000).toISOString().split('T')[0] : '';
    const lastDate = candles.length > 0 ? new Date(candles[candles.length - 1].time * 1000).toISOString().split('T')[0] : '';

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        symbol: meta.symbol || symbol,
        name: meta.shortName || meta.longName || '',
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || '',
        candles,
        totalCandles: candles.length,
        totalFetched,
        period: { start: firstDate, end: lastDate },
        isBacktest,
        backtestEndDate: isBacktest ? endDate : null
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};