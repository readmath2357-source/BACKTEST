// netlify/functions/analyze.js v7.0
// TSI + Fisher Transform + ATR strategy
// Entry LONG: both TSI signals > 0, OR opposite sides + Fisher < -1.5
// Entry SHORT: both TSI signals < 0, OR opposite sides + Fisher > +1.5
// Exit: ATR(21) TP×2.5 / SL×2

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// INDICATOR CALCULATIONS
// ══════════════════════════════════════════════

function calcEMA(vals, len) {
  const r = [], k = 2 / (len + 1);
  let prev = null, seedCount = 0, seedSum = 0, seeded = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === null || v === undefined) { r.push(null); continue; }
    if (!seeded) {
      seedSum += v; seedCount++;
      if (seedCount < len) { r.push(null); continue; }
      prev = seedSum / len; r.push(prev); seeded = true; continue;
    }
    prev = v * k + prev * (1 - k);
    r.push(prev);
  }
  return r;
}

// TSI = 100 * EMA(EMA(change, long), short) / EMA(EMA(abs(change), long), short)
// Signal = EMA(TSI, sigLen)
function calcTSI(closes, longLen, shortLen, sigLen) {
  const pc = [null];
  for (let i = 1; i < closes.length; i++) {
    pc.push(closes[i] - closes[i - 1]);
  }
  const absPC = pc.map(v => v === null ? null : Math.abs(v));

  const smoothPC = calcEMA(calcEMA(pc, longLen), shortLen);
  const smoothAbsPC = calcEMA(calcEMA(absPC, longLen), shortLen);

  const tsi = smoothPC.map((v, i) => {
    if (v === null || smoothAbsPC[i] === null || smoothAbsPC[i] === 0) return null;
    return 100 * (v / smoothAbsPC[i]);
  });

  const signal = calcEMA(tsi, sigLen);
  return { tsi, signal };
}

// Fisher Transform (matches Pine v6 code exactly)
function calcFisher(candles, len) {
  const fish1 = new Array(candles.length).fill(null);
  const fish2 = new Array(candles.length).fill(null);
  const values = new Array(candles.length).fill(0);

  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;

    // highest/lowest of hl2 over len
    let high_ = -Infinity, low_ = Infinity;
    const start = Math.max(0, i - len + 1);
    for (let j = start; j <= i; j++) {
      const h2 = (candles[j].high + candles[j].low) / 2;
      if (h2 > high_) high_ = h2;
      if (h2 < low_) low_ = h2;
    }

    const range = high_ - low_;
    let rawVal = range > 0 ? 0.66 * ((hl2 - low_) / range - 0.5) + 0.67 * (i > 0 ? values[i - 1] : 0) : 0;

    // clamp
    if (rawVal > 0.999) rawVal = 0.999;
    if (rawVal < -0.999) rawVal = -0.999;
    values[i] = rawVal;

    const f = 0.5 * Math.log((1 + rawVal) / (1 - rawVal)) + 0.5 * (i > 0 && fish1[i - 1] !== null ? fish1[i - 1] : 0);
    fish1[i] = f;
    fish2[i] = i > 0 ? fish1[i - 1] : null;
  }

  return { fish1, fish2 };
}

// ATR
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
// DIRECTION LOGIC
// ══════════════════════════════════════════════

function determineDirection(tsiSlow, tsiSlowSig, tsiFast, tsiFastSig, fisherVal) {
  if (tsiSlowSig === null || tsiFastSig === null) {
    return { direction: 'HOLD', confidence: 'LOW', reason: 'insufficient_data' };
  }

  const slowAbove0 = tsiSlowSig > 0;
  const fastAbove0 = tsiFastSig > 0;
  const bothAbove = slowAbove0 && fastAbove0;
  const bothBelow = !slowAbove0 && !fastAbove0;
  const opposite = slowAbove0 !== fastAbove0;

  // LONG conditions
  if (bothAbove) {
    return { direction: 'LONG', confidence: 'HIGH', reason: 'both_tsi_above_0' };
  }
  if (opposite && fisherVal !== null && fisherVal < -1.5) {
    return { direction: 'LONG', confidence: 'MODERATE', reason: 'fisher_oversold' };
  }

  // SHORT conditions
  if (bothBelow) {
    return { direction: 'SHORT', confidence: 'HIGH', reason: 'both_tsi_below_0' };
  }
  if (opposite && fisherVal !== null && fisherVal > 1.5) {
    return { direction: 'SHORT', confidence: 'MODERATE', reason: 'fisher_overbought' };
  }

  return { direction: 'HOLD', confidence: 'LOW', reason: 'no_signal' };
}

// ══════════════════════════════════════════════
// TP/SL (ATR-based)
// ══════════════════════════════════════════════

function calculateLevels(direction, currentPrice, atr) {
  if (direction === 'HOLD' || !atr) return null;
  const zw = currentPrice * 0.005;
  const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });

  let tp, sl;
  if (direction === 'LONG') {
    tp = currentPrice + atr * 2.5;
    sl = currentPrice - atr * 2.0;
  } else {
    tp = currentPrice - atr * 2.5;
    sl = currentPrice + atr * 2.0;
  }

  const reward = Math.abs(tp - currentPrice), risk = Math.abs(sl - currentPrice);
  return {
    tpZone: zone(tp),
    slZone: zone(sl),
    riskReward: `1:${risk > 0 ? (reward / risk).toFixed(1) : '0'}`
  };
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
    const tsiSlow = calcTSI(closes, 21, 21, 21);
    const tsiFast = calcTSI(closes, 13, 13, 13);
    const fisher = calcFisher(candles, 9);
    const atrValues = calcATR(candles, 21);

    const tsiSlowVal = tsiSlow.tsi[last];
    const tsiSlowSig = tsiSlow.signal[last];
    const tsiFastVal = tsiFast.tsi[last];
    const tsiFastSig = tsiFast.signal[last];
    const fisherVal = fisher.fish1[last];
    const fisherTrigger = fisher.fish2[last];
    const atrVal = atrValues[last];

    // ── Direction ──
    const decision = determineDirection(tsiSlowVal, tsiSlowSig, tsiFastVal, tsiFastSig, fisherVal);

    // ── TP/SL ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal);

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence}, ${decision.reason})
TSI(21,21,21): ${tsiSlowVal?.toFixed(2)} sig:${tsiSlowSig?.toFixed(2)} | TSI(13,13,13): ${tsiFastVal?.toFixed(2)} sig:${tsiFastSig?.toFixed(2)}
Fisher(9): ${fisherVal?.toFixed(2)} trigger:${fisherTrigger?.toFixed(2)} | ATR(21): ${atrVal?.toFixed(4)}
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
    const indicators = {
      tsiSlow: tsiSlowVal, tsiSlowSignal: tsiSlowSig,
      tsiFast: tsiFastVal, tsiFastSignal: tsiFastSig,
      fisher: fisherVal, fisherTrigger,
      atr: atrVal
    };

    const result = {
      mode: 'simple',
      direction: decision.direction,
      confidence: decision.confidence,
      reason: decision.reason,
      currentPrice,
      tpZone: levels?.tpZone || null,
      slZone: levels?.slZone || null,
      riskReward: levels?.riskReward || '—',
      idealScenario: ai.idealScenario || '',
      comment: ai.comment || '',
      summary: ai.summary || null,
      calculatedIndicators: indicators
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
