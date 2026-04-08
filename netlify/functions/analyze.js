// netlify/functions/analyze.js v7.0
// Deterministic backtest engine: HMA(100) + TSI(21,21,21) → direction, ATR(21) → TP/SL
// Entry: price > HMA100 + TSI bullish = LONG / price < HMA100 + TSI bearish = SHORT
// Exit: ATR(21) × 2.5 TP, ATR(21) × 2.0 SL
// AI (Claude) provides Korean commentary ONLY

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// INDICATOR CALCULATIONS
// ══════════════════════════════════════════════

function calcWMA(vals, len) {
  const r = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < len - 1 || vals[i] === null) { r.push(null); continue; }
    let num = 0, den = 0;
    for (let j = 0; j < len; j++) {
      const v = vals[i - len + 1 + j];
      if (v === null) { r.push(null); num = -1; break; }
      const w = j + 1;
      num += v * w;
      den += w;
    }
    if (num === -1) continue;
    r.push(num / den);
  }
  return r;
}

function calcHMA(vals, len) {
  // HMA = WMA(2*WMA(n/2) - WMA(n), sqrt(n))
  const halfLen = Math.floor(len / 2);
  const sqrtLen = Math.round(Math.sqrt(len));
  const wmaHalf = calcWMA(vals, halfLen);
  const wmaFull = calcWMA(vals, len);
  // 2*WMA(n/2) - WMA(n)
  const diff = [];
  for (let i = 0; i < vals.length; i++) {
    if (wmaHalf[i] !== null && wmaFull[i] !== null) {
      diff.push(2 * wmaHalf[i] - wmaFull[i]);
    } else {
      diff.push(null);
    }
  }
  return calcWMA(diff, sqrtLen);
}

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

function calcTSI(closes, longLen = 21, shortLen = 21, sigLen = 21) {
  // TSI = 100 * EMA(EMA(momentum, longLen), shortLen) / EMA(EMA(|momentum|, longLen), shortLen)
  // Signal = EMA(TSI, sigLen)
  const mom = [null];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] === null || closes[i - 1] === null) { mom.push(null); continue; }
    mom.push(closes[i] - closes[i - 1]);
  }
  const absMom = mom.map(v => v !== null ? Math.abs(v) : null);

  const emaLong = calcEMA(mom, longLen);
  const doubleSmooth = calcEMA(emaLong, shortLen);

  const emaLongAbs = calcEMA(absMom, longLen);
  const doubleSmoothAbs = calcEMA(emaLongAbs, shortLen);

  const tsi = [];
  for (let i = 0; i < closes.length; i++) {
    if (doubleSmooth[i] !== null && doubleSmoothAbs[i] !== null && doubleSmoothAbs[i] !== 0) {
      tsi.push(100 * doubleSmooth[i] / doubleSmoothAbs[i]);
    } else {
      tsi.push(null);
    }
  }

  const signal = calcEMA(tsi, sigLen);
  return { tsi, signal };
}

function calcATR(candles, period = 21) {
  if (candles.length < period + 1) return [];
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
// DIRECTION: HMA(100) + TSI(21,21,21)
// ══════════════════════════════════════════════

function determineDirection(currentPrice, hmaVal, tsiVal, tsiSig) {
  if (hmaVal === null || tsiVal === null || tsiSig === null) {
    return { direction: 'HOLD', confidence: 'LOW', hmaVote: 'N/A', tsiVote: 'N/A' };
  }

  const aboveHMA = currentPrice > hmaVal;
  const tsiBullish = tsiVal > tsiSig;

  let direction, confidence;

  if (aboveHMA && tsiBullish) {
    direction = 'LONG';
    confidence = tsiVal > 0 ? 'HIGH' : 'MODERATE';
  } else if (!aboveHMA && !tsiBullish) {
    direction = 'SHORT';
    confidence = tsiVal < 0 ? 'HIGH' : 'MODERATE';
  } else {
    direction = 'HOLD';
    confidence = 'LOW';
  }

  return {
    direction,
    confidence,
    hmaVote: aboveHMA ? 'LONG' : 'SHORT',
    tsiVote: tsiBullish ? 'LONG' : 'SHORT'
  };
}

// ══════════════════════════════════════════════
// TP/SL: ATR(21) × 2.5 TP, × 2.0 SL
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
- All Korean. Use: 추세, 모멘텀, 이동평균, 지지선/저항선
- Do NOT provide prices or override direction. Keep concise.
Respond in valid JSON only:
{"comment":"<Korean, <80 chars>","idealScenario":"<Korean, 1-2 sentences>","summary":{"trend":{"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>"},"momentum":{"signal":"...","detail":"..."},"confluence":{"signal":"...","detail":"..."}}}`;

// ══════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { candles, symbol, timeframe } = body;

    if (!candles || candles.length < 120) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `캔들 부족: ${candles ? candles.length : 0}개 (최소 120개 필요 — HMA100)` }) };
    }

    const closes = candles.map(c => c.close);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    // ── Indicators ──
    const hmaData = calcHMA(closes, 100);
    const tsiData = calcTSI(closes, 21, 21, 21);
    const atrValues = calcATR(candles, 21);

    const hmaVal = hmaData[last];
    const tsiVal = tsiData.tsi[last];
    const tsiSigVal = tsiData.signal[last];
    const atrVal = atrValues[last];

    // ── Direction ──
    const decision = determineDirection(currentPrice, hmaVal, tsiVal, tsiSigVal);

    // ── TP/SL ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal);

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence})
HMA100: ${hmaVal?.toFixed(2)} (가격 ${currentPrice > hmaVal ? '위' : '아래'})
TSI(21,21,21): ${tsiVal?.toFixed(2)} / 시그널: ${tsiSigVal?.toFixed(2)} (${tsiVal > tsiSigVal ? '매수' : '매도'})
ATR(21): ${atrVal?.toFixed(4)}
${decision.direction !== 'HOLD' && levels ? `TP: ${((levels.tpZone.low + levels.tpZone.high) / 2).toFixed(2)} (ATR×2.5) SL: ${((levels.slZone.low + levels.slZone.high) / 2).toFixed(2)} (ATR×2.0)` : 'HOLD'}
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
    const result = {
      mode: 'simple',
      direction: decision.direction,
      confidence: decision.confidence,
      currentPrice,
      tpZone: levels?.tpZone || null,
      slZone: levels?.slZone || null,
      riskReward: levels?.riskReward || '—',
      idealScenario: ai.idealScenario || '',
      comment: ai.comment || '',
      summary: ai.summary || null,
      calculatedIndicators: {
        hma100: hmaVal,
        tsi: tsiVal,
        tsiSignal: tsiSigVal,
        atr21: atrVal,
        votes: { hma: decision.hmaVote, tsi: decision.tsiVote }
      }
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
