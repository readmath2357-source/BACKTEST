// netlify/functions/analyze.js v9.0
// RSI(21) + SMA(21) + Fisher(8) + ATR(21)
// LONG: (SMA>55 + Fisher>-1.5 & Fisher>Trigger) OR (SMA 45~55 + Fisher golden cross below -1)
// SHORT: (SMA<55 + Fisher<1.5 & Fisher<Trigger) OR (SMA 45~55 + Fisher dead cross above +1)
// Exit: ATR(21) TP×2 / SL×1

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// INDICATORS
// ══════════════════════════════════════════════

function calcRMA(vals, len) {
  const r = [];
  let sum = 0, count = 0, prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === null || v === undefined) { r.push(null); continue; }
    if (prev === null) {
      sum += v; count++;
      if (count < len) { r.push(null); continue; }
      prev = sum / len; r.push(prev); continue;
    }
    prev = (prev * (len - 1) + v) / len;
    r.push(prev);
  }
  return r;
}

function calcSMA(vals, len) {
  return vals.map((_, i) => {
    if (i < len - 1) return null;
    let s = 0, c = 0;
    for (let j = i - len + 1; j <= i; j++) {
      if (vals[j] !== null && vals[j] !== undefined) { s += vals[j]; c++; }
    }
    return c > 0 ? s / c : null;
  });
}

function calcRSI(closes, len) {
  const changes = [null];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const gains = changes.map(v => v === null ? null : Math.max(v, 0));
  const losses = changes.map(v => v === null ? null : -Math.min(v, 0));
  const avgGain = calcRMA(gains, len);
  const avgLoss = calcRMA(losses, len);
  return avgGain.map((up, i) => {
    const down = avgLoss[i];
    if (up === null || down === null) return null;
    if (down === 0) return 100;
    if (up === 0) return 0;
    return 100 - (100 / (1 + up / down));
  });
}

function calcFisher(candles, len) {
  const fish1 = new Array(candles.length).fill(null);
  const fish2 = new Array(candles.length).fill(null);
  const values = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let high_ = -Infinity, low_ = Infinity;
    const start = Math.max(0, i - len + 1);
    for (let j = start; j <= i; j++) {
      const h2 = (candles[j].high + candles[j].low) / 2;
      if (h2 > high_) high_ = h2;
      if (h2 < low_) low_ = h2;
    }
    const range = high_ - low_;
    let rawVal = range > 0 ? 0.66 * ((hl2 - low_) / range - 0.5) + 0.67 * (i > 0 ? values[i - 1] : 0) : 0;
    if (rawVal > 0.999) rawVal = 0.999;
    if (rawVal < -0.999) rawVal = -0.999;
    values[i] = rawVal;
    const f = 0.5 * Math.log((1 + rawVal) / (1 - rawVal)) + 0.5 * (i > 0 && fish1[i - 1] !== null ? fish1[i - 1] : 0);
    fish1[i] = f;
    fish2[i] = i > 0 ? fish1[i - 1] : null;
  }
  return { fish1, fish2 };
}

function calcATR(candles, period = 21) {
  if (candles.length < period + 1) return new Array(candles.length).fill(null);
  const trs = [null];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  const atr = new Array(period).fill(null);
  atr.push(sum / period);
  for (let i = period + 1; i < trs.length; i++) {
    atr.push((atr[i - 1] * (period - 1) + trs[i]) / period);
  }
  return atr;
}

// ══════════════════════════════════════════════
// DIRECTION
// ══════════════════════════════════════════════

function determineDirection(rsiSMA, fisherVal, fisherTrigger, prevFisher, prevTrigger) {
  if (rsiSMA === null || fisherVal === null || fisherTrigger === null) {
    return { direction: 'HOLD', confidence: 'LOW', reason: 'insufficient_data' };
  }

  // ── LONG ──
  // 1) SMA > 55 + Fisher > -1.5 & Fisher > Trigger
  if (rsiSMA > 55 && fisherVal > -1.5 && fisherVal > fisherTrigger) {
    return { direction: 'LONG', confidence: 'HIGH', reason: 'sma_above55_fisher_above_trigger' };
  }
  // 2) SMA 45~55 + Fisher golden cross below -1
  if (rsiSMA >= 45 && rsiSMA <= 55 && prevFisher !== null && prevTrigger !== null) {
    const goldenCross = fisherVal > fisherTrigger && prevFisher <= prevTrigger;
    if (goldenCross && fisherVal < -1) {
      return { direction: 'LONG', confidence: 'MODERATE', reason: 'sma_neutral_fisher_golden_cross' };
    }
  }

  // ── SHORT ──
  // 1) SMA < 55 + Fisher < 1.5 & Fisher < Trigger
  if (rsiSMA < 55 && fisherVal < 1.5 && fisherVal < fisherTrigger) {
    return { direction: 'SHORT', confidence: 'HIGH', reason: 'sma_below55_fisher_below_trigger' };
  }
  // 2) SMA 45~55 + Fisher dead cross above +1
  if (rsiSMA >= 45 && rsiSMA <= 55 && prevFisher !== null && prevTrigger !== null) {
    const deadCross = fisherVal < fisherTrigger && prevFisher >= prevTrigger;
    if (deadCross && fisherVal > 1) {
      return { direction: 'SHORT', confidence: 'MODERATE', reason: 'sma_neutral_fisher_dead_cross' };
    }
  }

  return { direction: 'HOLD', confidence: 'LOW', reason: 'no_signal' };
}

// ══════════════════════════════════════════════
// TP/SL
// ══════════════════════════════════════════════

function calculateLevels(direction, currentPrice, atr) {
  if (direction === 'HOLD' || !atr) return null;
  const zw = currentPrice * 0.005;
  const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });
  let tp, sl;
  if (direction === 'LONG') {
    tp = currentPrice + atr * 2.0;
    sl = currentPrice - atr * 1.0;
  } else {
    tp = currentPrice - atr * 2.0;
    sl = currentPrice + atr * 1.0;
  }
  const reward = Math.abs(tp - currentPrice), risk = Math.abs(sl - currentPrice);
  return { tpZone: zone(tp), slZone: zone(sl), riskReward: `1:${risk > 0 ? (reward / risk).toFixed(1) : '0'}` };
}

// ══════════════════════════════════════════════
// AI COMMENTARY
// ══════════════════════════════════════════════

const COMMENTARY_SYSTEM = `You are a Korean chart commentator. You receive pre-calculated indicators and a deterministic signal. Provide brief Korean commentary ONLY.
RULES:
- All Korean. Use: 추세강도, 모멘텀, 과매수/과매도, 피셔전환, 지지선/저항선
- Do NOT provide prices or override direction. Keep concise.
Respond in valid JSON only:
{"comment":"<Korean, <80 chars>","idealScenario":"<Korean, 1-2 sentences>","summary":{"trend":{"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>"},"momentum":{"signal":"...","detail":"..."},"fisher":{"signal":"...","detail":"..."},"confluence":{"signal":"...","detail":"..."}}}`;

// ══════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { candles, symbol, timeframe, mode } = body;

    if (!candles || candles.length < 50) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `캔들 부족: ${candles ? candles.length : 0}개 (최소 50개)` }) };
    }

    const closes = candles.map(c => c.close);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    // ── Indicators ──
    const rsi = calcRSI(closes, 21);
    const rsiSMA = calcSMA(rsi, 21);
    const fisher = calcFisher(candles, 8);
    const atrValues = calcATR(candles, 21);

    const rsiVal = rsi[last];
    const rsiSMAVal = rsiSMA[last];
    const fisherVal = fisher.fish1[last];
    const fisherTrigger = fisher.fish2[last];
    const prevFisher = last > 0 ? fisher.fish1[last - 1] : null;
    const prevTrigger = last > 0 ? fisher.fish2[last - 1] : null;
    const atrVal = atrValues[last];

    // ── Direction ──
    const decision = determineDirection(rsiSMAVal, fisherVal, fisherTrigger, prevFisher, prevTrigger);

    // ── TP/SL ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal);

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence}, ${decision.reason})
RSI(21): ${rsiVal?.toFixed(2)} SMA(21): ${rsiSMAVal?.toFixed(2)}
Fisher(8): ${fisherVal?.toFixed(2)} trigger:${fisherTrigger?.toFixed(2)} | ATR(21): ${atrVal?.toFixed(4)}
가격: ${currentPrice}${levels ? ` | TP:${((levels.tpZone.low + levels.tpZone.high) / 2).toFixed(2)} SL:${((levels.slZone.low + levels.slZone.high) / 2).toFixed(2)}` : ' | HOLD'}
한국어 코멘터리 JSON.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, system: COMMENTARY_SYSTEM, messages: [{ role: 'user', content: prompt }] })
      });
      if (r.ok) {
        const d = await r.json();
        const t = d.content?.find(c => c.type === 'text')?.text || '';
        ai = JSON.parse(t.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
      }
    } catch (e) { console.error('[analyze] AI error:', e.message); }

    // ── Response ──
    const indicators = { rsi: rsiVal, rsiSMA: rsiSMAVal, fisher: fisherVal, fisherTrigger, atr: atrVal };

    const result = {
      mode: 'simple', direction: decision.direction, confidence: decision.confidence,
      reason: decision.reason, currentPrice,
      tpZone: levels?.tpZone || null, slZone: levels?.slZone || null,
      riskReward: levels?.riskReward || '—',
      idealScenario: ai.idealScenario || '', comment: ai.comment || '',
      summary: ai.summary || null, calculatedIndicators: indicators
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
