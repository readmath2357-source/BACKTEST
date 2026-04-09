// netlify/functions/analyze.js v7.0
// TSI(13,13,13) + TSI(8,8,8) + Fisher(8) + ATR strategy
// Entry LONG: TSI13 sig < TSI8 sig, then (both>0 + fisher<0) or (any<0 → ignore fisher)
// Entry SHORT: TSI13 sig > TSI8 sig, then (both<0 + fisher>0) or (any>0 → ignore fisher)
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

function determineDirection(tsiSlowSig, tsiFastSig, fisherVal) {
  // tsiSlowSig = TSI(13,13,13) signal, tsiFastSig = TSI(8,8,8) signal
  if (tsiSlowSig === null || tsiFastSig === null) {
    return { direction: 'HOLD', confidence: 'LOW', reason: 'insufficient_data' };
  }

  const slowBelowFast = tsiSlowSig < tsiFastSig; // LONG candidate
  const slowAboveFast = tsiSlowSig > tsiFastSig; // SHORT candidate

  // LONG: TSI13 sig < TSI8 sig
  if (slowBelowFast) {
    const bothAbove0 = tsiSlowSig > 0 && tsiFastSig > 0;
    const anyBelow0 = tsiSlowSig < 0 || tsiFastSig < 0;
    if (bothAbove0 && fisherVal !== null && fisherVal < 0) {
      return { direction: 'LONG', confidence: 'HIGH', reason: 'both_above0_fisher_below0', tpMult: 2.5, slMult: 2.0 };
    }
    if (anyBelow0) {
      return { direction: 'LONG', confidence: 'MODERATE', reason: 'any_below0_fisher_ignored', tpMult: 2.5, slMult: 2.0 };
    }
    // Gap: both above 0 but fisher >= 0
    if (bothAbove0) {
      return { direction: 'LONG', confidence: 'LOW', reason: 'both_above0_fisher_same', tpMult: 1.5, slMult: 1.5 };
    }
  }

  // SHORT: TSI13 sig > TSI8 sig
  if (slowAboveFast) {
    const bothBelow0 = tsiSlowSig < 0 && tsiFastSig < 0;
    const anyAbove0 = tsiSlowSig > 0 || tsiFastSig > 0;
    if (bothBelow0 && fisherVal !== null && fisherVal > 0) {
      return { direction: 'SHORT', confidence: 'HIGH', reason: 'both_below0_fisher_above0', tpMult: 2.5, slMult: 2.0 };
    }
    if (anyAbove0) {
      return { direction: 'SHORT', confidence: 'MODERATE', reason: 'any_above0_fisher_ignored', tpMult: 2.5, slMult: 2.0 };
    }
    // Gap: both below 0 but fisher <= 0
    if (bothBelow0) {
      return { direction: 'SHORT', confidence: 'LOW', reason: 'both_below0_fisher_same', tpMult: 1.5, slMult: 1.5 };
    }
  }

  return { direction: 'HOLD', confidence: 'LOW', reason: 'no_signal' };
}

// ══════════════════════════════════════════════
// TP/SL (ATR-based)
// ══════════════════════════════════════════════

function calculateLevels(direction, currentPrice, atr, tpMult = 2.5, slMult = 2.0) {
  if (direction === 'HOLD' || !atr) return null;
  const zw = currentPrice * 0.005;
  const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });

  let tp, sl;
  if (direction === 'LONG') {
    tp = currentPrice + atr * tpMult;
    sl = currentPrice - atr * slMult;
  } else {
    tp = currentPrice - atr * tpMult;
    sl = currentPrice + atr * slMult;
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
    const tsiSlow = calcTSI(closes, 13, 13, 13);
    const tsiFast = calcTSI(closes, 8, 8, 8);
    const fisher = calcFisher(candles, 8);
    const atrValues = calcATR(candles, 21);

    const tsiSlowVal = tsiSlow.tsi[last];
    const tsiSlowSig = tsiSlow.signal[last];
    const tsiFastVal = tsiFast.tsi[last];
    const tsiFastSig = tsiFast.signal[last];
    const fisherVal = fisher.fish1[last];
    const fisherTrigger = fisher.fish2[last];
    const atrVal = atrValues[last];

    // ── Direction ──
    const decision = determineDirection(tsiSlowSig, tsiFastSig, fisherVal);

    // ── TP/SL ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal, decision.tpMult, decision.slMult);

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence}, ${decision.reason})
TSI(13,13,13): ${tsiSlowVal?.toFixed(2)} sig:${tsiSlowSig?.toFixed(2)} | TSI(8,8,8): ${tsiFastVal?.toFixed(2)} sig:${tsiFastSig?.toFixed(2)}
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
