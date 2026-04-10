// netlify/functions/analyze.js v7.0
// TSI + Fisher Transform Entry | ATR Swing Snap TP/SL
// Based on Pine Script: "TSI+Fisher Entry | ATR Swing Snap TP/SL"

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// PARAMETERS (from Pine Script defaults + user screenshot)
// ══════════════════════════════════════════════

const PARAMS = {
  tsiLong: 21,
  tsiShort: 21,
  tsiSignal: 21,
  fisherLen: 9,
  atrLen: 21,
  tpAtrMult: 1.5,
  slAtrMult: 1.5,
  swingLeft: 5,
  swingRight: 5,
  snapAtrMult: 0.5,
  slPadMult: 0.1,
  minRR: 1.5,
};

// ══════════════════════════════════════════════
// INDICATOR CALCULATIONS
// ══════════════════════════════════════════════

function calcEMA(vals, len) {
  const r = [], k = 2 / (len + 1);
  let prev = null, seedCount = 0, seedSum = 0, seeded = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === null || v === undefined || isNaN(v)) { r.push(null); continue; }
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

// ── TSI (True Strength Index) ──
function calcTSI(closes, longLen, shortLen, sigLen) {
  // pc = change(close)
  const pc = [null];
  for (let i = 1; i < closes.length; i++) {
    pc.push(closes[i] - closes[i - 1]);
  }

  // double_smooth(src, longLen, shortLen) = ema(ema(src, longLen), shortLen)
  const dsPC = calcEMA(calcEMA(pc, longLen), shortLen);
  const dsAbsPC = calcEMA(calcEMA(pc.map(v => v !== null ? Math.abs(v) : null), longLen), shortLen);

  // tsi = 100 * dsPC / dsAbsPC
  const tsi = dsPC.map((v, i) => {
    if (v === null || dsAbsPC[i] === null || dsAbsPC[i] === 0) return null;
    return 100 * v / dsAbsPC[i];
  });

  // signal = ema(tsi, sigLen)
  const signal = calcEMA(tsi, sigLen);

  return { tsi, signal };
}

// ── Fisher Transform ──
function calcFisher(candles, len) {
  const hl2 = candles.map(c => (c.high + c.low) / 2);
  const fish1 = new Array(candles.length).fill(null);
  const fish2 = new Array(candles.length).fill(null);
  let fishVal = 0;
  let prevFish1 = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < len - 1) continue;

    // highest/lowest of hl2 over len
    let hi = -Infinity, lo = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      if (hl2[j] > hi) hi = hl2[j];
      if (hl2[j] < lo) lo = hl2[j];
    }

    let rawF = 0;
    if (hi !== lo) {
      rawF = 0.66 * ((hl2[i] - lo) / (hi - lo) - 0.5) + 0.67 * fishVal;
    }
    fishVal = Math.max(Math.min(rawF, 0.999), -0.999);

    const f1 = 0.5 * Math.log((1.0 + fishVal) / (1.0 - fishVal)) + 0.5 * prevFish1;
    fish1[i] = f1;
    fish2[i] = prevFish1;
    prevFish1 = f1;
  }

  return { fish1, fish2 };
}

// ── ATR ──
function calcATR(candles, period) {
  const atr = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return atr;

  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < trs.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── Swing Point Detection ──
function detectSwings(candles, leftBars, rightBars) {
  const swingHighs = []; // { index, price }
  const swingLows = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    // Swing High
    let isHigh = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) { isHigh = false; break; }
    }
    if (isHigh) swingHighs.push({ index: i, price: candles[i].high });

    // Swing Low
    let isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) { isLow = false; break; }
    }
    if (isLow) swingLows.push({ index: i, price: candles[i].low });
  }

  return { swingHighs, swingLows };
}

// ── Snap to nearest swing point ──
function snapToNearest(basePrice, candidates, snapRange) {
  let best = null;
  let bestDist = snapRange;
  for (const c of candidates) {
    const dist = Math.abs(c.price - basePrice);
    if (dist <= snapRange && dist < bestDist) {
      best = c.price;
      bestDist = dist;
    }
  }
  return best !== null ? best : basePrice;
}

// ── Crossover / Crossunder ──
function crossover(a, b, i) {
  if (i < 1 || a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) return false;
  return a[i] > b[i] && a[i - 1] <= b[i - 1];
}

function crossunder(a, b, i) {
  if (i < 1 || a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) return false;
  return a[i] < b[i] && a[i - 1] >= b[i - 1];
}

// ══════════════════════════════════════════════
// AI COMMENTARY
// ══════════════════════════════════════════════

const COMMENTARY_SYSTEM = `You are a Korean chart commentator. You receive pre-calculated TSI+Fisher signals and ATR Swing Snap levels. Provide brief Korean commentary ONLY.
RULES:
- All Korean. Use: 추세강도(TSI), 전환시그널(Fisher), 변동성(ATR), 스윙포인트, 지지/저항
- Do NOT provide prices or override direction. Keep concise.
Respond in valid JSON only:
{"comment":"<Korean, <80 chars>","idealScenario":"<Korean, 1-2 sentences>"}`;

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

    const P = PARAMS;
    const closes = candles.map(c => c.close);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    // ── Indicators ──
    const tsiData = calcTSI(closes, P.tsiLong, P.tsiShort, P.tsiSignal);
    const fisherData = calcFisher(candles, P.fisherLen);
    const atrValues = calcATR(candles, P.atrLen);

    const tsiVal = tsiData.tsi[last];
    const tsiSig = tsiData.signal[last];
    const fish1 = fisherData.fish1[last];
    const fish2 = fisherData.fish2[last];
    const atrVal = atrValues[last];

    // ── Entry Conditions (exact Pine Script logic) ──
    // Long:  TSI signal > 0  AND  Fisher golden cross  AND  fish2 < 1
    // Short: TSI signal < 0  AND  Fisher dead cross    AND  fish2 > -1
    const fisherGoldenX = crossover(fisherData.fish1, fisherData.fish2, last);
    const fisherDeadX = crossunder(fisherData.fish1, fisherData.fish2, last);

    const longEntry = tsiSig !== null && tsiSig > 0 && fisherGoldenX && fish2 !== null && fish2 < 1.0;
    const shortEntry = tsiSig !== null && tsiSig < 0 && fisherDeadX && fish2 !== null && fish2 > -1.0;

    let direction = 'HOLD';
    let confidence = 'LOW';

    if (longEntry) {
      direction = 'LONG';
      confidence = tsiSig > 5 ? 'HIGH' : tsiSig > 2 ? 'MODERATE' : 'LOW';
    } else if (shortEntry) {
      direction = 'SHORT';
      confidence = tsiSig < -5 ? 'HIGH' : tsiSig < -2 ? 'MODERATE' : 'LOW';
    }

    // ── TP/SL with ATR Swing Snap ──
    let levels = null;
    if (direction !== 'HOLD' && atrVal) {
      // Get recent swing points (last 20)
      const swings = detectSwings(candles, P.swingLeft, P.swingRight);
      const recentHighs = swings.swingHighs.slice(-20);
      const recentLows = swings.swingLows.slice(-20);
      const snapRange = atrVal * P.snapAtrMult;
      const pad = atrVal * P.slPadMult;

      let tp, sl;
      if (direction === 'LONG') {
        const baseTP = currentPrice + atrVal * P.tpAtrMult;
        const baseSL = currentPrice - atrVal * P.slAtrMult;
        tp = snapToNearest(baseTP, recentHighs, snapRange);
        sl = snapToNearest(baseSL, recentLows, snapRange) - pad;
        // Min R:R check
        const reward = tp - currentPrice;
        const risk = currentPrice - sl;
        if (risk > 0 && reward / risk < P.minRR) {
          tp = currentPrice + risk * P.minRR;
        }
      } else {
        const baseTP = currentPrice - atrVal * P.tpAtrMult;
        const baseSL = currentPrice + atrVal * P.slAtrMult;
        tp = snapToNearest(baseTP, recentLows, snapRange);
        sl = snapToNearest(baseSL, recentHighs, snapRange) + pad;
        const reward = currentPrice - tp;
        const risk = sl - currentPrice;
        if (risk > 0 && reward / risk < P.minRR) {
          tp = currentPrice - risk * P.minRR;
        }
      }

      const zw = currentPrice * 0.003;
      const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });
      const reward = Math.abs(tp - currentPrice);
      const risk = Math.abs(sl - currentPrice);

      levels = {
        tpZone: zone(tp),
        slZone: zone(sl),
        tp, sl,
        riskReward: `1:${risk > 0 ? (reward / risk).toFixed(1) : '0'}`,
        snappedTP: tp !== (direction === 'LONG' ? currentPrice + atrVal * P.tpAtrMult : currentPrice - atrVal * P.tpAtrMult),
        snappedSL: sl !== (direction === 'LONG' ? currentPrice - atrVal * P.slAtrMult - pad : currentPrice + atrVal * P.slAtrMult + pad),
      };
    }

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '' };
    try {
      const prompt = `${symbol} ${timeframe}: ${direction} (${confidence})
TSI: ${tsiVal?.toFixed(2)} / Signal: ${tsiSig?.toFixed(2)}
Fisher: ${fish1?.toFixed(3)} / ${fish2?.toFixed(3)} | Cross: ${fisherGoldenX ? 'Golden' : fisherDeadX ? 'Dead' : 'None'}
ATR(${P.atrLen}): ${atrVal?.toFixed(4)}
${levels ? `TP: ${levels.tp?.toFixed(2)} (snap:${levels.snappedTP}) SL: ${levels.sl?.toFixed(2)} (snap:${levels.snappedSL}) R:R=${levels.riskReward}` : 'HOLD'}
한국어 코멘터리 JSON.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, system: COMMENTARY_SYSTEM, messages: [{ role: 'user', content: prompt }] })
      });
      if (r.ok) {
        const d = await r.json();
        const t = d.content?.find(c => c.type === 'text')?.text || '';
        ai = JSON.parse(t.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
      }
    } catch (e) { console.error('[analyze] AI error:', e.message); }

    // ── Response ──
    const result = {
      direction,
      confidence,
      currentPrice,
      tpZone: levels?.tpZone || null,
      slZone: levels?.slZone || null,
      riskReward: levels?.riskReward || '—',
      comment: ai.comment || '',
      idealScenario: ai.idealScenario || '',
      indicators: {
        tsi: tsiVal,
        tsiSignal: tsiSig,
        fisher1: fish1,
        fisher2: fish2,
        atr: atrVal,
        fisherGoldenX,
        fisherDeadX,
      },
      params: P,
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
