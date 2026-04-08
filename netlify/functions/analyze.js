// netlify/functions/analyze.js v6.0
// Deterministic backtest engine: MACD + BB + VWAP → direction, ATR + BB → TP/SL
// AI (Claude) provides Korean commentary ONLY — no price generation
// TF-adaptive parameters: 1h / 4h / 1d / 1wk
// Direction: 2/3 majority vote (MACD direction, BB position, VWAP position)

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ══════════════════════════════════════════════
// TF-ADAPTIVE PARAMETERS
// ══════════════════════════════════════════════

const TF_PARAMS = {
  '1h':  { macdFast:8,  macdSlow:17, macdSig:9, bbLen:14, bbMult:2.0, atrLen:10, vwapMode:'session', squeezePct:4.0, slopeLook:5, divLook:20 },
  '4h':  { macdFast:12, macdSlow:26, macdSig:9, bbLen:20, bbMult:2.0, atrLen:14, vwapMode:'cumulative', squeezePct:3.0, slopeLook:5, divLook:30 },
  '1d':  { macdFast:8,  macdSlow:17, macdSig:9, bbLen:14, bbMult:2.0, atrLen:14, vwapMode:'rolling50', squeezePct:2.5, slopeLook:5, divLook:30 },
  '1wk': { macdFast:12, macdSlow:26, macdSig:9, bbLen:20, bbMult:2.5, atrLen:10, vwapMode:'cumulative', squeezePct:2.0, slopeLook:8, divLook:40 }
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

function calcSMA(vals, len) {
  return vals.map((_, i) => {
    if (i < len - 1 || vals[i] === null) return null;
    let s = 0, c = 0;
    for (let j = i - len + 1; j <= i; j++) if (vals[j] !== null) { s += vals[j]; c++; }
    return c > 0 ? s / c : null;
  });
}

function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macd = emaFast.map((v, i) => (v !== null && emaSlow[i] !== null) ? v - emaSlow[i] : null);
  const signal = calcEMA(macd, sig);
  const histogram = macd.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null);
  return { macd, signal, histogram };
}

function calcBB(closes, len = 20, mult = 2) {
  const middle = calcSMA(closes, len);
  const upper = [], lower = [], width = [];
  for (let i = 0; i < closes.length; i++) {
    if (middle[i] === null) { upper.push(null); lower.push(null); width.push(null); continue; }
    let sumSq = 0;
    for (let j = i - len + 1; j <= i; j++) sumSq += (closes[j] - middle[i]) ** 2;
    const std = Math.sqrt(sumSq / len);
    upper.push(middle[i] + mult * std);
    lower.push(middle[i] - mult * std);
    width.push(mult * 2 * std / middle[i] * 100);
  }
  return { middle, upper, lower, width };
}

function calcVWAP(candles) {
  const vwap = [];
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * (c.volume || 0);
    cumVol += (c.volume || 0);
    vwap.push(cumVol > 0 ? cumTPV / cumVol : null);
  }
  return vwap;
}

function calcVWAPAdaptive(candles, mode = 'cumulative') {
  if (mode === 'cumulative') return calcVWAP(candles);
  const window = mode === 'session' ? 6 : 50;
  const vwap = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - window + 1);
    let tpv = 0, vol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      tpv += tp * (candles[j].volume || 0);
      vol += (candles[j].volume || 0);
    }
    vwap.push(vol > 0 ? tpv / vol : null);
  }
  return vwap;
}

function calcATR(candles, period = 14) {
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

// ══════════════════════════════════════════════
// TREND HEALTH (slope, gap, divergence)
// ══════════════════════════════════════════════

function calcSlope(values, lookback = 5) {
  const recent = values.slice(-lookback).filter(v => v !== null);
  if (recent.length < 3) return null;
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += recent[i]; sumXY += i * recent[i]; sumX2 += i * i; }
  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

function calcGapTrend(primary, secondary, lookback = 5) {
  const gaps = [];
  const start = Math.max(primary.length - lookback, 0);
  for (let i = start; i < primary.length; i++) {
    if (primary[i] !== null && secondary[i] !== null) gaps.push(primary[i] - secondary[i]);
  }
  if (gaps.length < 3) return { direction: 'unknown', consecutive: 0 };
  let narrowing = 0, widening = 0;
  for (let i = 1; i < gaps.length; i++) {
    if (Math.abs(gaps[i]) < Math.abs(gaps[i-1])) narrowing++; else widening++;
  }
  if (narrowing > widening) return { direction: 'narrowing', consecutive: narrowing };
  if (widening > narrowing) return { direction: 'widening', consecutive: widening };
  return { direction: 'stable', consecutive: 0 };
}

function detectDivergence(closes, indicator, lookback = 30) {
  const len = closes.length, start = Math.max(len - lookback, 2);
  let pH = [], pL = [], iH = [], iL = [];
  for (let i = start; i < len - 1; i++) {
    if (closes[i] === null || indicator[i] === null) continue;
    if (closes[i] > closes[i-1] && closes[i] > closes[i+1]) pH.push({ v: closes[i] });
    if (indicator[i] > indicator[i-1] && indicator[i] > indicator[i+1]) iH.push({ v: indicator[i] });
    if (closes[i] < closes[i-1] && closes[i] < closes[i+1]) pL.push({ v: closes[i] });
    if (indicator[i] < indicator[i-1] && indicator[i] < indicator[i+1]) iL.push({ v: indicator[i] });
  }
  let bearish = false, bullish = false;
  if (pH.length >= 2 && iH.length >= 2) {
    const a = pH.slice(-2), b = iH.slice(-2);
    if (a[1].v > a[0].v && b[1].v < b[0].v) bearish = true;
  }
  if (pL.length >= 2 && iL.length >= 2) {
    const a = pL.slice(-2), b = iL.slice(-2);
    if (a[1].v < a[0].v && b[1].v > b[0].v) bullish = true;
  }
  return { bearish, bullish };
}

// ══════════════════════════════════════════════
// DETERMINISTIC DIRECTION (2/3 majority vote)
// ══════════════════════════════════════════════

function determineDirection(macdVal, macdSig, currentPrice, bbMid, vwapVal, health) {
  if (macdVal === null || macdSig === null || bbMid === null) {
    return { direction: 'HOLD', votes: {}, confidence: 'LOW' };
  }

  const macdVote = macdVal > macdSig ? 'LONG' : 'SHORT';
  const bbVote = currentPrice > bbMid ? 'LONG' : 'SHORT';
  const vwapVote = vwapVal !== null ? (currentPrice > vwapVal ? 'LONG' : 'SHORT') : null;
  const votes = { macd: macdVote, bb: bbVote, vwap: vwapVote || 'N/A' };

  let longCount = 0, shortCount = 0;
  [macdVote, bbVote, vwapVote].forEach(v => {
    if (v === 'LONG') longCount++; else if (v === 'SHORT') shortCount++;
  });

  let direction, confidence;
  if (longCount >= 2) { direction = 'LONG'; confidence = longCount === 3 ? 'HIGH' : 'MODERATE'; }
  else if (shortCount >= 2) { direction = 'SHORT'; confidence = shortCount === 3 ? 'HIGH' : 'MODERATE'; }
  else { direction = 'HOLD'; confidence = 'LOW'; }

  // Confidence modifiers
  if (direction !== 'HOLD' && health) {
    if (direction === 'LONG' && health.macdDiv?.bearish) confidence = 'LOW';
    if (direction === 'SHORT' && health.macdDiv?.bullish) confidence = 'LOW';
    if (direction === 'LONG' && health.macdSlope !== null && health.macdSlope < -0.001 && confidence === 'HIGH') confidence = 'MODERATE';
    if (direction === 'SHORT' && health.macdSlope !== null && health.macdSlope > 0.001 && confidence === 'HIGH') confidence = 'MODERATE';
    if (health.macdGap?.direction === 'narrowing' && confidence === 'HIGH') confidence = 'MODERATE';
  }

  return { direction, votes, confidence, longCount, shortCount };
}

// ══════════════════════════════════════════════
// DETERMINISTIC TP/SL (ATR + BB reference)
// ══════════════════════════════════════════════

function calculateLevels(direction, currentPrice, atr, bbUp, bbLow, bbMid, isStrategic) {
  if (direction === 'HOLD' || !atr) return null;
  const zw = currentPrice * 0.005;
  const zone = (p) => ({ low: +(p - zw / 2).toFixed(6), high: +(p + zw / 2).toFixed(6) });

  if (!isStrategic) {
    let tp, sl;
    if (direction === 'LONG') {
      tp = bbUp ? Math.max(currentPrice + atr * 2.5, bbUp) : currentPrice + atr * 2.5;
      sl = bbLow ? Math.max(currentPrice - atr * 1.5, bbLow) : currentPrice - atr * 1.5;
      sl = Math.min(sl, currentPrice * 0.995);
    } else {
      tp = bbLow ? Math.min(currentPrice - atr * 2.5, bbLow) : currentPrice - atr * 2.5;
      sl = bbUp ? Math.min(currentPrice + atr * 1.5, bbUp) : currentPrice + atr * 1.5;
      sl = Math.max(sl, currentPrice * 1.005);
    }
    const reward = Math.abs(tp - currentPrice), risk = Math.abs(sl - currentPrice);
    return { mode: 'simple', tpZone: zone(tp), slZone: zone(sl), riskReward: `1:${risk > 0 ? (reward / risk).toFixed(1) : '0'}` };
  }

  let tp1, tp2, sl1, sl2;
  if (direction === 'LONG') {
    tp1 = currentPrice + atr * 2.0;
    tp2 = currentPrice + atr * 3.5;
    sl1 = currentPrice - atr * 1.5;
    sl2 = currentPrice - atr * 2.5;
    if (bbUp) { tp1 = Math.max(tp1, (currentPrice + bbUp) / 2); tp2 = Math.max(tp2, bbUp); }
    if (bbLow) sl2 = Math.min(sl2, bbLow);
  } else {
    tp1 = currentPrice - atr * 2.0;
    tp2 = currentPrice - atr * 3.5;
    sl1 = currentPrice + atr * 1.5;
    sl2 = currentPrice + atr * 2.5;
    if (bbLow) { tp1 = Math.min(tp1, (currentPrice + bbLow) / 2); tp2 = Math.min(tp2, bbLow); }
    if (bbUp) sl2 = Math.max(sl2, bbUp);
  }

  return { mode: 'strategic', tp1Zone: zone(tp1), tp2Zone: zone(tp2), sl1Zone: zone(sl1), sl2Zone: zone(sl2), tp1, tp2, sl1, sl2 };
}

// ══════════════════════════════════════════════
// AI COMMENTARY (minimal — no price generation)
// ══════════════════════════════════════════════

const COMMENTARY_SYSTEM = `You are a Korean chart commentator. You receive pre-calculated indicators and a deterministic signal. Provide brief Korean commentary ONLY.
RULES:
- All Korean. NEVER mention MACD, Bollinger, VWAP, BB, EMA, SMA, ATR.
- Use: 추세, 변동성, 거래기준선, 모멘텀, 지지선/저항선
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
    const rawBody = event.body || '{}';
    const body = JSON.parse(rawBody);
    const { candles, symbol, timeframe, mode } = body;
    const isStrategic = mode === 'strategic';

    if (!candles || candles.length < 30) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `캔들 부족: ${candles ? candles.length : 0}개 (최소 30개)` }) };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const last = closes.length - 1;
    const currentPrice = closes[last];
    const P = TF_PARAMS[timeframe] || TF_PARAMS['1d'];

    // ── Indicators ──
    const macdData = calcMACD(closes, P.macdFast, P.macdSlow, P.macdSig);
    const bbData = calcBB(closes, P.bbLen, P.bbMult);
    const vwapData = calcVWAPAdaptive(candles, P.vwapMode);
    const atrValues = calcATR(candles, P.atrLen);

    const macdVal = macdData.macd[last], macdSig = macdData.signal[last], macdHist = macdData.histogram[last];
    const prevHist = macdData.histogram[last - 1];
    const bbMid = bbData.middle[last], bbUp = bbData.upper[last], bbLow = bbData.lower[last], bbW = bbData.width[last];
    const vwapVal = vwapData[last], atrVal = atrValues[last];

    // ── Health ──
    const macdSlope = calcSlope(macdData.histogram, P.slopeLook);
    const macdGap = calcGapTrend(macdData.macd, macdData.signal, P.slopeLook);
    const macdDiv = detectDivergence(closes, macdData.histogram, P.divLook);
    const bbSqueeze = bbW !== null && bbW < P.squeezePct;
    const health = { macdSlope, macdGap, macdDiv, bbSqueeze };

    // ── Direction (deterministic) ──
    const decision = determineDirection(macdVal, macdSig, currentPrice, bbMid, vwapVal, health);

    // ── TP/SL (deterministic) ──
    const levels = calculateLevels(decision.direction, currentPrice, atrVal, bbUp, bbLow, bbMid, isStrategic);

    // ── Volume ──
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volTrend = recVol > avgVol * 1.2 ? 'UP' : recVol < avgVol * 0.8 ? 'DOWN' : 'STABLE';

    // ── AI commentary ──
    let ai = { comment: '', idealScenario: '', summary: null };
    try {
      const histFlip = macdHist && prevHist ? Math.sign(macdHist) !== Math.sign(prevHist) : false;
      const slopeStr = (s) => s === null ? 'flat' : s > 0.001 ? 'rising' : s < -0.001 ? 'falling' : 'flat';
      const bp = bbUp && bbLow ? ((currentPrice - bbLow) / (bbUp - bbLow) * 100).toFixed(0) : '?';

      const prompt = `${symbol} ${timeframe}: ${decision.direction} (${decision.confidence})
투표: 추세=${decision.votes.macd} 밴드=${decision.votes.bb} 기준=${decision.votes.vwap}
가격: ${currentPrice} | 히스토그램: ${slopeStr(macdSlope)}, 전환:${histFlip?'Y':'N'} | 밴드폭:${bbW?.toFixed(1)}%${bbSqueeze?' 스퀴즈':''} 위치:${bp}% | 기준선:${vwapVal?(currentPrice>vwapVal?'위':'아래'):'?'} | 거래량:${volTrend} | 다이버전스:${macdDiv.bearish?'하락':macdDiv.bullish?'상승':'없음'}
${decision.direction!=='HOLD'&&levels?`TP:${isStrategic?levels.tp1?.toFixed(2)+'/'+levels.tp2?.toFixed(2):((levels.tpZone.low+levels.tpZone.high)/2).toFixed(2)} SL:${isStrategic?levels.sl1?.toFixed(2)+'/'+levels.sl2?.toFixed(2):((levels.slZone.low+levels.slZone.high)/2).toFixed(2)}`:'HOLD'}
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
      macd: macdVal, macdSignal: macdSig, macdHistogram: macdHist,
      bbUpper: bbUp, bbMiddle: bbMid, bbLower: bbLow, bbWidth: bbW,
      vwap: vwapVal, atr: atrVal, avgVolume: avgVol, recentVolume: recVol,
      votes: decision.votes, params: P, health
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
              { name: '1차 손절', probability: decision.confidence === 'HIGH' ? '25%' : '25%', type: 'sl', step: { label: '1차 손절', price: levels.sl1, pct: '(50%)' }, description: `${t1} 도달 후 반전 시 ${s1}에서 잔여 청산` },
              { name: '2차 익절', probability: decision.confidence === 'HIGH' ? '40%' : '30%', type: 'tp', step: { label: '2차 익절', price: levels.tp2, pct: '(50%)' }, description: `추세 지속 시 ${t2}까지 잔여 보유` }
            ] },
          lossPath: { name: '손절 경로', probability: decision.confidence === 'HIGH' ? '35%' : '45%',
            trigger: { label: '1차 손절', price: levels.sl1, pct: '(50%)' },
            outcomes: [
              { name: '2차 익절 회복', probability: decision.confidence === 'HIGH' ? '20%' : '20%', type: 'tp', step: { label: '2차 익절', price: levels.tp2, pct: '(50%)' }, description: `${s1} 이탈 후 반등 시 ${t2}까지 회복` },
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
