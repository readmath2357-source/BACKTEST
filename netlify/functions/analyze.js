// netlify/functions/analyze.js v5.0
// Backtest: MACD(12,26,9) + Bollinger Bands(20,2) + VWAP + ATR(14)
// Three non-overlapping axes: Trend(MACD) + Volatility(BB) + FairValue(VWAP)

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const SYSTEM_BASE = `You are a technical analyst. Core: CUT LOSSES SHORT, LET WINNERS RUN.

## INDICATORS

### MACD (12,26,9) — PRIORITY 1: Direction
- MACD Line = EMA(12) - EMA(26)
- Signal Line = EMA(MACD, 9)
- Histogram = MACD - Signal
- MACD above Signal = BULLISH direction
- MACD below Signal = BEARISH direction
- Histogram sign flip = PRIMARY ENTRY TRIGGER
- MACD > 0 = bullish territory, < 0 = bearish territory (affects confidence)
- Divergence (price vs MACD histogram) = lowers confidence

### Bollinger Bands (20, 2) — PRIORITY 2: Volatility Filter (MANDATORY)
- Middle Band = SMA(20) — dynamic trend filter
- Upper Band = SMA(20) + 2×StdDev(20) — natural resistance
- Lower Band = SMA(20) - 2×StdDev(20) — natural support
- Price ABOVE BB Middle → only LONG allowed
- Price BELOW BB Middle → only SHORT allowed
- Band Width < 3% = squeeze (breakout imminent, raises confidence)
- BB provides natural TP/SL zone references

### VWAP — PRIORITY 3: Institutional Confirmation
- VWAP = cumulative(typical_price × volume) / cumulative(volume)
- Price above VWAP = confirms bullish (institutional buyers)
- Price below VWAP = confirms bearish (institutional sellers)
- VWAP confluence with BB middle = very strong S/R

### ENTRY RULES (3 conditions must align)
- MACD > Signal + price > BB Middle + price > VWAP → LONG
- MACD < Signal + price < BB Middle + price < VWAP → SHORT
- Any of the 3 disagree → HOLD
That is the ONLY entry/hold decision. Nothing else blocks entry.

### CONFIDENCE LEVEL (does NOT block entry, only adjusts confidence)
HIGH confidence (all favorable):
- MACD on correct side of zero (LONG: MACD>0, SHORT: MACD<0)
- MACD histogram slope confirms direction
- BB squeeze breakout or gap widening + no divergence + volume confirms

MODERATE confidence (mixed signals):
- MACD on wrong side of zero but crossover confirmed
- BB bands stable, no squeeze

LOW confidence (caution):
- Histogram slope contradicts direction
- Gap narrowing or divergence detected
- Volume declining or price near BB opposite band

### TP/SL PLACEMENT
- SL at BB band levels or recent swing structure (1-2 ATR from entry)
- TP at opposite BB band or structural target (≥2 ATR)
- LONG: SL near lower BB / swing low, TP near upper BB
- SHORT: SL near upper BB / swing high, TP near lower BB

### Volume — CONFIRMATION
- Rising with trend = continuation. Declining = exhaustion.

## RULES
1. R:R minimum 1:2 (prefer 1:3+). Below 1:2 → HOLD.
2. SL at structural level 1-2 ATR. TP1 ≥2 ATR, TP2 ≥3-4 ATR.
3. Entry: MACD direction + BB filter + VWAP confirmation must align. Otherwise HOLD.
4. Slope/gap/divergence adjust confidence only, never block entry.

## OUTPUT RULES
- Entry = current price. No entry zone. Above entry = 저항, below = 지지.
- All user text in Korean. NEVER mention MACD/BB/Bollinger/VWAP/EMA/SMA/ATR.
- Use: 추세, 변동성, 거래기준선, 수요존/공급존, 지지선/저항선
- Summary: MACD→"trend", BB→"volatility", VWAP→"fairValue", Overall→"confluence"`;

const SIMPLE_PROMPT_SUFFIX = `

## SIMPLE MODE — JSON only, no markdown:
{"mode":"simple","direction":"LONG"/"SHORT"/"HOLD","confidence":"HIGH"/"MODERATE"/"LOW",
"slZone":{"low":N,"high":N},"tpZone":{"low":N,"high":N},"riskReward":"1:X",
"idealScenario":"<Korean>","comment":"<Korean, <80 chars, no indicator names>",
"summary":{"trend":{"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>"},
"volatility":{"signal":"...","detail":"..."},"fairValue":{"signal":"...","detail":"..."},
"confluence":{"signal":"...","detail":"..."}}}

SL at BB/structural level (1-2 ATR). TP at structural level (≥2x SL). R:R<1:2→HOLD. Zones as low/high.`;

const STRATEGIC_PROMPT_SUFFIX = `

## COMPLEX MODE — JSON only, no markdown:
{"mode":"strategic","direction":"LONG"/"SHORT"/"HOLD","confidence":"HIGH"/"MODERATE"/"LOW",
"idealScenario":"<Korean>",
"levels":{"tp1Zone":{"low":N,"high":N},"tp2Zone":{"low":N,"high":N},"sl1Zone":{"low":N,"high":N},"sl2Zone":{"low":N,"high":N}},
"scenarios":{
  "profitPath":{"name":"익절 경로","probability":"X%",
    "trigger":{"label":"1차 익절","price":N,"pct":"(50%)"},
    "outcomes":[
      {"name":"1차 손절","probability":"X%","type":"sl","step":{"label":"1차 손절","price":N,"pct":"(50%)"},"description":"<Korean>"},
      {"name":"2차 익절","probability":"X%","type":"tp","step":{"label":"2차 익절","price":N,"pct":"(50%)"},"description":"<Korean>"}]},
  "lossPath":{"name":"손절 경로","probability":"X%",
    "trigger":{"label":"1차 손절","price":N,"pct":"(50%)"},
    "outcomes":[
      {"name":"2차 익절 회복","probability":"X%","type":"tp","step":{"label":"2차 익절","price":N,"pct":"(50%)"},"description":"<Korean>"},
      {"name":"2차 손절","probability":"X%","type":"sl","step":{"label":"2차 손절","price":N,"pct":"(50%)"},"description":"<Korean>"}]}},
"exitStrategy":{"partialExit":"<Korean>","fullExit":"<Korean>","trailingStop":"<Korean>"},
"comment":"<Korean, <120 chars>",
"summary":{"trend":{...},"volatility":{...},"fairValue":{...},"confluence":{...}}}

TREE: PATH1: Entry→TP1(50%)→SL1 or TP2. PATH2: Entry→SL1(50%)→TP2 or SL2.
Probs: paths sum 100%, all 4 outcomes sum≈100%.
SL1≈1-1.5ATR, SL2≈2-3ATR, TP1≥2ATR, TP2≥3-4ATR. BB-guided placement. No SL→HOLD. HOLD→null.
LONG: tp1<tp2 above, sl1>sl2 below. SHORT: opposite. Labels: above=저항, below=지지.`;

// ── Calculations ──

function calcSMA(vals, len) {
  return vals.map((_, i) => {
    if (i < len - 1 || vals[i] === null) return null;
    let s = 0, c = 0;
    for (let j = i - len + 1; j <= i; j++) if (vals[j] !== null) { s += vals[j]; c++; }
    return c > 0 ? s / c : null;
  });
}

function calcEMA(vals, len) {
  const r = [], k = 2 / (len + 1);
  let prev = null;
  for (const v of vals) {
    if (v === null) { r.push(null); continue; }
    if (prev === null) { prev = v; r.push(v); continue; }
    prev = v * k + prev * (1 - k);
    r.push(prev);
  }
  return r;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macd = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? v - ema26[i] : null);
  const signal = calcEMA(macd, 9);
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

function calcVWAP(candles, period = 20) {
  const vwap = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    let sumTPV = 0, sumVol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      sumTPV += tp * (candles[j].volume || 0);
      sumVol += (candles[j].volume || 0);
    }
    vwap.push(sumVol > 0 ? sumTPV / sumVol : null);
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

// ── Handler ──

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
      return { statusCode: 200, headers, body: JSON.stringify({ error: `캔들 부족: ${candles ? candles.length : 0}개 수신 (최소 30개 필요). bodySize=${rawBody.length}` }) };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    // Indicators
    const macdData = calcMACD(closes);
    const bbData = calcBB(closes, 20, 2);
    const vwapData = calcVWAP(candles);
    const atrValues = calcATR(candles, 14);

    const currentATR = atrValues[last];
    const atrPct = currentATR ? (currentATR / currentPrice * 100).toFixed(2) : null;

    const macdVal = macdData.macd[last];
    const macdSig = macdData.signal[last];
    const macdHist = macdData.histogram[last];
    const prevHist = macdData.histogram[last - 1];
    const bbMid = bbData.middle[last];
    const bbUp = bbData.upper[last];
    const bbLow = bbData.lower[last];
    const bbW = bbData.width[last];
    const vwapVal = vwapData[last];

    // BB filter
    const bbFilter = bbMid
      ? (currentPrice > bbMid ? 'ABOVE BB Middle → LONG only' : 'BELOW BB Middle → SHORT only')
      : 'N/A';
    const bbMidPct = bbMid ? ((currentPrice - bbMid) / bbMid * 100).toFixed(2) : null;
    const bbPosition = (bbUp && bbLow) ? ((currentPrice - bbLow) / (bbUp - bbLow) * 100).toFixed(1) : null;

    // VWAP
    const vwapPct = vwapVal ? ((currentPrice - vwapVal) / vwapVal * 100).toFixed(2) : null;

    // Health metrics
    const macdSlope = calcSlope(macdData.histogram, 5);
    const bbMidSlope = calcSlope(bbData.middle, 5);
    const macdGap = calcGapTrend(macdData.macd, macdData.signal, 5);
    const macdDiv = detectDivergence(closes, macdData.histogram, 30);

    const sl = (s) => s === null ? 'N/A' : s > 0.001 ? 'rising' : s < -0.001 ? 'falling' : 'flat';

    const recentCandles = candles.slice(-50).map((c, i) => ({
      idx: candles.length - 50 + i, t: c.time,
      o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume
    }));

    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

    const prompt = `Analyze ${symbol} ${timeframe}. Mode: ${isStrategic ? 'COMPLEX' : 'SIMPLE'}.

PRICE: ${currentPrice}
ATR(14): ${currentATR?.toFixed(2) || 'N/A'} (${atrPct || 'N/A'}%)

BB FILTER (MANDATORY):
- BB Middle: ${bbMid?.toFixed(2) || 'N/A'}
- BB Upper: ${bbUp?.toFixed(2) || 'N/A'}
- BB Lower: ${bbLow?.toFixed(2) || 'N/A'}
- BB Width: ${bbW?.toFixed(2) || 'N/A'}% ${bbW && bbW < 3 ? '⚠ SQUEEZE — breakout imminent' : ''}
- ${bbFilter} (${bbMidPct ? bbMidPct + '% from BB Mid' : 'N/A'})
- Band Position: ${bbPosition || 'N/A'}% (0=lower, 100=upper)
- ABOVE BB Mid = only LONG. BELOW BB Mid = only SHORT. Violation = HOLD.

MACD(12,26,9): ${macdVal?.toFixed(4) || 'N/A'} | Signal: ${macdSig?.toFixed(4) || 'N/A'} | ${macdVal && macdSig ? (macdVal > macdSig ? 'ABOVE Signal' : 'BELOW Signal') : 'N/A'} | Zero: ${macdVal ? (macdVal > 0 ? 'ABOVE(bull)' : 'BELOW(bear)') : 'N/A'}
Histogram: ${macdHist?.toFixed(4) || 'N/A'} | Prev: ${prevHist?.toFixed(4) || 'N/A'} | Flip: ${macdHist && prevHist ? (Math.sign(macdHist) !== Math.sign(prevHist) ? 'YES — ENTRY TRIGGER' : 'NO') : 'N/A'}
MACD health: hist slope ${sl(macdSlope)}(${macdSlope?.toFixed(4)}), gap ${macdGap.direction}, div: ${macdDiv.bearish ? 'BEARISH' : macdDiv.bullish ? 'BULLISH' : 'none'}

VWAP: ${vwapVal?.toFixed(2) || 'N/A'} | ${vwapVal ? (currentPrice > vwapVal ? 'ABOVE (Buyers)' : 'BELOW (Sellers)') : 'N/A'} | ${vwapPct ? vwapPct + '% from VWAP' : 'N/A'}

Vol: avg20=${avgVol.toFixed(0)} rec5=${recVol.toFixed(0)} ${recVol > avgVol * 1.2 ? 'UP' : recVol < avgVol * 0.8 ? 'DOWN' : 'STABLE'}

CANDLES(50):
${JSON.stringify(recentCandles)}

MACD Hist(10): ${macdData.histogram.slice(-10).map(v => v?.toFixed(4)).join(',')}
BB Mid(5): ${bbData.middle.slice(-5).map(v => v?.toFixed(2)).join(',')}
BB Up(5): ${bbData.upper.slice(-5).map(v => v?.toFixed(2)).join(',')}
BB Low(5): ${bbData.lower.slice(-5).map(v => v?.toFixed(2)).join(',')}

RULES: Entry=${currentPrice}. No indicator names in text. Above=저항,below=지지. R:R<1:2→HOLD. Entry: MACD+BB+VWAP 3가지 방향 일치→진입, 불일치→HOLD. Slope/gap/divergence는 신뢰도만 조절. SL at BB/structural levels.
JSON only.`;

    const systemPrompt = SYSTEM_BASE + (isStrategic ? STRATEGIC_PROMPT_SUFFIX : SIMPLE_PROMPT_SUFFIX);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: `AI 분석 오류: ${response.status}`, detail: errText.substring(0, 300) }) };
    }

    const aiData = await response.json();
    const textContent = aiData.content?.find(c => c.type === 'text')?.text || '';

    let analysis;
    try {
      const cleaned = textContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'AI 응답 파싱 실패', raw: textContent.substring(0, 500) }) };
    }

    analysis.currentPrice = currentPrice;
    analysis.calculatedIndicators = {
      macd: macdVal, macdSignal: macdSig, macdHistogram: macdHist,
      bbUpper: bbUp, bbMiddle: bbMid, bbLower: bbLow, bbWidth: bbW ? parseFloat(bbW.toFixed(2)) : null,
      vwap: vwapVal, atr: currentATR, atrPct: atrPct ? parseFloat(atrPct) : null,
      avgVolume: avgVol, recentVolume: recVol,
      trendHealth: { macdSlope, bbMidSlope, macdGap, macdDiv }
    };

    return { statusCode: 200, headers, body: JSON.stringify(analysis) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
