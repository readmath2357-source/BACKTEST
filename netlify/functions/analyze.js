// netlify/functions/analyze.js v7.0
// Fisher Transform(9) + TSI(21,21,21) → direction
// ATR(13) × 1.0 → TP/SL
// AI (Claude) provides Korean commentary ONLY

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// PARAMETERS
// ══════════════════════════════════════════════

const PARAMS = {
  fisherLen: 9,
  tsiLong: 21,
  tsiShort: 21,
  tsiSignalLen: 21,
  atrLen: 13,
  atrMult: 1.0,
  lookback: 3
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

function calcATR(candles, period = 13) {
  if (candles.length < period + 1) return [];
  const trs = [null];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  const atr = new Array(period).fill(null);
  atr.push(sum / period);
  for (let i = period + 1; i < trs.length; i++) {
    atr.push((atr[i-1] * (period - 1) + trs[i]) / period);
  }
  return atr;
}

// ── Fisher Transform (9) ──
function calcFisher(candles, len = 9) {
  const hl2 = candles.map(c => (c.high + c.low) / 2);
  const fisher = [];
  let value = 0, fish1 = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < len - 1) { fisher.push(null); continue; }

    let high_ = -Infinity, low_ = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      if (hl2[j] > high_) high_ = hl2[j];
      if (hl2[j] < low_) low_ = hl2[j];
    }

    const range = high_ - low_;
    let raw = range > 0 ? 0.66 * ((hl2[i] - low_) / range - 0.5) + 0.67 * value : 0;
    // clamp
    if (raw > 0.999) raw = 0.999;
    if (raw < -0.999) raw = -0.999;
    value = raw;

    const newFish = 0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * fish1;
    fisher.push(newFish);
    fish1 = newFish;
  }
  return fisher;
}

// ── TSI (True Strength Index) ──
function calcTSI(closes, longLen = 21, shortLen = 21, signalLen = 21) {
  // pc = change(close)
  const pc = [null];
  for (let i = 1; i < closes.length; i++) {
    pc.push(closes[i] - closes[i-1]);
  }
  const abspc = pc.map(v => v === null ? null : Math.abs(v));

  // double smooth
  const ds = calcEMA(calcEMA(pc, longLen), shortLen);
  const dsAbs = calcEMA(calcEMA(abspc, longLen), shortLen);

  const tsiValue = ds.map((v, i) => {
    if (v === null || dsAbs[i] === null || dsAbs[i] === 0) return null;
    return 100 * (v / dsAbs[i]);
  });

  const tsiSignal = calcEMA(tsiValue, signalLen);

  return { tsiValue, tsiSignal };
}

// ══════════════════════════════════════════════
// DIRECTION: Fisher rising + TSI signal rising → LONG
//            Fisher falling + TSI signal falling → SHORT
//            With duplicate entry prevention
// ══════════════════════════════════════════════

function determineDirection(fisher, tsiSignal, last, lookback = 3) {
  if (last < lookback + 1) return { direction: 'HOLD', confidence: 'LOW' };

  const fNow = fisher[last], fPrev = fisher[last - lookback];
  const tNow = tsiSignal[last], tPrev = tsiSignal[last - lookback];

  if (fNow === null || fPrev === null || tNow === null || tPrev === null) {
    return { direction: 'HOLD', confidence: 'LOW' };
  }

  const fRising = fNow > fPrev;
  const fFalling = fNow < fPrev;
  const tRising = tNow > tPrev;
  const tFalling = tNow < tPrev;

  let longEntry = fRising && tRising;
  let shortEntry = fFalling && tFalling;

  // Duplicate prevention: check if previous bar also had same signal
  if (last >= lookback + 2) {
    const fPrevBar = fisher[last - 1], fPrevLook = fisher[last - 1 - lookback];
    const tPrevBar = tsiSignal[last - 1], tPrevLook = tsiSignal[last - 1 - lookback];
    if (fPrevBar !== null && fPrevLook !== null && tPrevBar !== null && tPrevLook !== null) {
      const prevLong = fPrevBar > fPrevLook && tPrevBar > tPrevLook;
      const prevShort = fPrevBar < fPrevLook && tPrevBar < tPrevLook;
      if (longEntry && prevLong) longEntry = false;
      if (shortEntry && prevShort) shortEntry = false;
    }
  }

  if (longEntry) {
    // Confidence based on strength
    const fStrength = Math.abs(fNow - fPrev);
    const tStrength = Math.abs(tNow - tPrev);
    const confidence = (fStrength > 0.5 && tStrength > 3) ? 'HIGH' : 'MODERATE';
    return { direction: 'LONG', confidence, fisher: fNow, tsiSignal: tNow };
  }
  if (shortEntry) {
    const fStrength = Math.abs(fNow - fPrev);
    const tStrength = Math.abs(tNow - tPrev);
    const confidence = (fStrength > 0.5 && tStrength > 3) ? 'HIGH' : 'MODERATE';
    return { direction: 'SHORT', confidence, fisher: fNow, tsiSignal: tNow };
  }

  return { direction: 'HOLD', confidence: 'LOW', fisher: fNow, tsiSignal: tNow };
}

// ══════════════════════════════════════════════
// TP/SL: ATR(13) × 1.0
// ══════════════════════════════════════════════

function calculateLevels(direction, currentPrice, atr, isStrategic) {
  if (direction === 'HOLD' || !atr) return null;
  const mult = PARAMS.atrMult; // 1.0
  const zw = currentPrice * 0.003;
  const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });

  if (!isStrategic) {
    let tp, sl;
    if (direction === 'LONG') {
      tp = currentPrice + atr * mult;
      sl = currentPrice - atr * mult;
    } else {
      tp = currentPrice - atr * mult;
      sl = currentPrice + atr * mult;
    }
    const reward = Math.abs(tp - currentPrice), risk = Math.abs(sl - currentPrice);
    return { mode: 'simple', tpZone: zone(tp), slZone: zone(sl), riskReward: `1:${risk > 0 ? (reward / risk).toFixed(1) : '0'}` };
  }

  // Strategic: 2-level TP/SL
  let tp1, tp2, sl1, sl2;
  if (direction === 'LONG') {
    tp1 = currentPrice + atr * mult;
    tp2 = currentPrice + atr * mult * 1.8;
    sl1 = currentPrice - atr * mult;
    sl2 = currentPrice - atr * mult * 1.5;
  } else {
    tp1 = currentPrice - atr * mult;
    tp2 = currentPrice - atr * mult * 1.8;
    sl1 = currentPrice + atr * mult;
    sl2 = currentPrice + atr * mult * 1.5;
  }

  return { mode: 'strategic', tp1Zone: zone(tp1), tp2Zone: zone(tp2), sl1Zone: zone(sl1), sl2Zone: zone(sl2), tp1, tp2, sl1, sl2 };
}

// ══════════════════════════════════════════════
// AI COMMENTARY
// ══════════════════════════════════════════════

const COMMENTARY_SYSTEM = `You are a Korean chart commentator. You receive pre-calculated indicators and a deterministic signal. Provide brief Korean commentary ONLY.
RULES:
- All Korean. Use: 추세 전환, 모멘텀, 변동성, 지지선/저항선
- Do NOT provide prices or override direction. Keep concise.
Respond in valid JSON only:
{"comment":"<Korean, <80 chars>","idealScenario":"<Korean, 1-2 sentences>","summary":{"trend":{"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>"},"volatility":{"signal":"...","detail":"..."},"fairValue":{"signal":"...","detail":"..."},"confluence":{"signal":"...","detail":"..."}}}`;

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
    const isStrategic = mode === 'strategic';

    if (!candles || candles.length < 30) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `캔들 부족: ${candles ? candles.length : 0}개 (최소 30개)` }) };
    }

    const closes = candles.map(c => c.close);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    // ── Indicators ──
    const fisher = calcFisher(candles, PARAMS.fisherLen);
    const { tsiValue, tsiSignal } = calcTSI(closes, PARAMS.tsiLong, PARAMS.tsiShort, PARAMS.tsiSignalLen);
    const atrValues = calcATR(candles, PARAMS.atrLen);
    const atrVal = atrValues[last];

    // ── Direction ──
    const decision = determineDirection(fisher, tsiSignal, last, PARAMS.lookback);

    // ── TP/SL ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal, isStrategic);

    // ── Volume ──
    const volumes = candles.map(c => c.volume);
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volTrend = recVol > avgVol * 1.2 ? 'UP' : recVol < avgVol * 0.8 ? 'DOWN' : 'STABLE';

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const fVal = fisher[last]?.toFixed(3) || '?';
      const tVal = tsiSignal[last]?.toFixed(2) || '?';

      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence})
Fisher(9): ${fVal} | TSI Signal(21): ${tVal} | ATR(13): ${atrVal?.toFixed(4) || '?'}
가격: ${currentPrice} | 거래량: ${volTrend}
${decision.direction !== 'HOLD' && levels ? `TP:${isStrategic ? levels.tp1?.toFixed(2) + '/' + levels.tp2?.toFixed(2) : ((levels.tpZone.low + levels.tpZone.high) / 2).toFixed(2)} SL:${isStrategic ? levels.sl1?.toFixed(2) + '/' + levels.sl2?.toFixed(2) : ((levels.slZone.low + levels.slZone.high) / 2).toFixed(2)}` : 'HOLD'}
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
      fisher: fisher[last], tsiValue: tsiValue[last], tsiSignal: tsiSignal[last],
      atr: atrVal, avgVolume: avgVol, recentVolume: recVol, params: PARAMS
    };

    let result;
    if (isStrategic && decision.direction !== 'HOLD' && levels) {
      const dir = decision.direction;
      const [t1, t2, s1, s2] = dir === 'LONG'
        ? ['1차 저항', '2차 저항', '1차 지지', '2차 지지']
        : ['1차 지지', '2차 지지', '1차 저항', '2차 저항'];

      result = {
        mode: 'strategic', direction: dir, confidence: decision.confidence, currentPrice,
        idealScenario: ai.idealScenario || '',
        levels: { tp1Zone: levels.tp1Zone, tp2Zone: levels.tp2Zone, sl1Zone: levels.sl1Zone, sl2Zone: levels.sl2Zone },
        scenarios: {
          profitPath: { name: '익절 경로', probability: decision.confidence === 'HIGH' ? '65%' : '55%',
            trigger: { label: '1차 익절', price: levels.tp1, pct: '(50%)' },
            outcomes: [
              { name: '1차 손절', probability: '25%', type: 'sl', step: { label: '1차 손절', price: levels.sl1, pct: '(50%)' }, description: `${t1} 도달 후 반전 시 ${s1}에서 잔여 청산` },
              { name: '2차 익절', probability: decision.confidence === 'HIGH' ? '40%' : '30%', type: 'tp', step: { label: '2차 익절', price: levels.tp2, pct: '(50%)' }, description: `추세 지속 시 ${t2}까지 잔여 보유` }
            ] },
          lossPath: { name: '손절 경로', probability: decision.confidence === 'HIGH' ? '35%' : '45%',
            trigger: { label: '1차 손절', price: levels.sl1, pct: '(50%)' },
            outcomes: [
              { name: '2차 익절 회복', probability: '20%', type: 'tp', step: { label: '2차 익절', price: levels.tp2, pct: '(50%)' }, description: `${s1} 이탈 후 반등 시 ${t2}까지 회복` },
              { name: '2차 손절', probability: decision.confidence === 'HIGH' ? '15%' : '25%', type: 'sl', step: { label: '2차 손절', price: levels.sl2, pct: '(50%)' }, description: `추세 이탈 지속 시 ${s2}에서 전량 청산` }
            ] }
        },
        exitStrategy: { partialExit: `${t1} 도달 시 50% 청산`, fullExit: `${s2} 이탈 시 전량 청산`, trailingStop: `${t1} 도달 후 진입가를 트레일링 스탑으로 이동` },
        comment: ai.comment || '', summary: ai.summary || null, calculatedIndicators: indicators
      };
    } else {
      result = {
        mode: 'simple', direction: decision.direction, confidence: decision.confidence, currentPrice,
        tpZone: levels?.tpZone || null, slZone: levels?.slZone || null, riskReward: levels?.riskReward || '—',
        idealScenario: ai.idealScenario || '', comment: ai.comment || '', summary: ai.summary || null,
        calculatedIndicators: indicators
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
