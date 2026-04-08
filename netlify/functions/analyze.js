// netlify/functions/analyze.js
// Dual-mode analysis: simple vs strategic
// Output order: direction → entry timing → exit strategy → comment → summary
// Entry = current price (즉시 진입)
// Labels: above entry = 저항(resistance), below entry = 지지(support)

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ── SYSTEM PROMPTS ──

const SYSTEM_BASE = `You are an expert technical analyst. You analyze price action using four indicators with CLEAR PRIORITY:

## PRIMARY INDICATORS (Entry Point Decision)

### 1. TSI (True Strength Index) — Parameters: (13, 8, 8) — PRIORITY 1
- TSI Line = 100 × EMA(EMA(price_change, 13), 8) / EMA(EMA(|price_change|, 13), 8)
- Signal Line = EMA(TSI, 8)
- TSI ABOVE signal → Bullish momentum | BELOW signal → Bearish
- TSI near +25 or above = strong bullish / near -25 or below = strong bearish
- TSI crossing zero = potential trend change
- TSI-Signal crossover is the PRIMARY entry trigger
- Divergence between TSI and price = high-probability reversal signal

### 2. RSI — Parameters: Length 21, SMA Length 21 — PRIORITY 2
- RSI(21) with SMA(RSI, 21) overlay
- RSI ABOVE SMA → Bullish | BELOW SMA → Bearish
- RSI > 70 = Overbought | RSI < 30 = Oversold
- RSI-SMA crossover confirms TSI signals
- RSI divergence adds conviction to entries

## SUPPLEMENTARY INDICATORS (Confirmation & Context)

### 3. VOLUME — SUPPLEMENTARY
- Rising volume with trend = continuation confirmation
- Declining volume = exhaustion warning
- Volume spikes at key levels = institutional activity

### 4. ICT CONCEPTS — SUPPLEMENTARY
- Order Blocks (OB): institutional supply/demand zones
- Fair Value Gaps (FVG): imbalance zones price tends to fill
- Liquidity zones: stop-loss clusters
- Break of Structure (BOS) / Change of Character (CHoCH)
- Premium/Discount zones (above/below 50% of swing range)

## CONFLUENCE SCORING
Primary indicators (TSI + RSI) determine direction.
Supplementary indicators (Volume + ICT) modify confidence.

IMPORTANT OUTPUT RULES:
- ENTRY IS ALWAYS AT CURRENT PRICE (즉시 진입). Do NOT provide an entry zone.
- For levels, label them relative to entry: above entry = 저항(resistance), below entry = 지지(support)
- For LONG: TP levels are above entry → 저항, SL levels are below entry → 지지
- For SHORT: TP levels are below entry → 지지, SL levels are above entry → 저항
- All text output must be in Korean
- Keep comments concise
- NEVER mention "TSI", "RSI", "ICT", "Order Block", "FVG", "BOS" in user-facing text
- Use abstract terms instead: 추세(trend), 모멘텀(momentum), 거래강도(strength), 수요존/공급존(demand/supply zone), 지지선/저항선
- In the "summary" section, map indicators to abstract labels:
  - TSI → "trend" (추세 방향)
  - RSI → "momentum" (모멘텀)  
  - Volume → "strength" (거래 강도)
  - ICT → "zone" (수요·공급 구간)`;

const SIMPLE_PROMPT_SUFFIX = `

## OUTPUT FORMAT — SIMPLE MODE (단순 전략)
Output price ZONES (ranges), NOT exact prices. Each zone has low and high.
ENTRY IS AT CURRENT PRICE — do NOT provide an entryZone.
Respond in valid JSON only, no markdown, no backticks:
{
  "mode": "simple",
  "direction": "LONG" or "SHORT" or "HOLD",
  "confidence": "HIGH" or "MODERATE" or "LOW",
  "slZone": {"low": <number>, "high": <number>},
  "tpZone": {"low": <number>, "high": <number>},
  "riskReward": "<string like 1:2.5>",
  "idealScenario": "<Korean: ideal scenario description — what the best outcome looks like from current price>",
  "comment": "<one-line Korean summary, under 80 chars, NO indicator names>",
  "summary": {
    "trend": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract, no indicator names>"},
    "momentum": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract>"},
    "strength": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract>"},
    "zone": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, describe demand/supply zones abstractly>"}
  }
}

ZONE RULES:
- Each zone width should be ~0.5~1.5% of price (e.g. price 68,300 → zone 67,900~68,700)
- For LONG: tpZone is ABOVE current price, slZone is BELOW current price
- For SHORT: tpZone is BELOW current price, slZone is ABOVE current price
- NEVER output a single exact price — always a low/high range
- In "detail" fields and "comment", use ONLY abstract Korean terms.
- Good: "상승 추세 전환 초기 단계", "과매도 구간에서 반등 기대"
- Bad: "TSI가 시그널 라인 위로 상승", "RSI 35.5로 과매도"`;

const STRATEGIC_PROMPT_SUFFIX = `

## OUTPUT FORMAT — COMPLEX MODE (복합 전략)
Provide 2 TPs + 2 SLs with BRANCHING scenarios (tree structure). ENTRY IS AT CURRENT PRICE (즉시 진입).
Label all levels relative to entry: above entry = 저항, below entry = 지지.
Respond in valid JSON only:
{
  "mode": "strategic",
  "direction": "LONG" or "SHORT" or "HOLD",
  "confidence": "HIGH" or "MODERATE" or "LOW",
  "idealScenario": "<Korean: ideal scenario description — what the best outcome looks like from current price. Be specific with key price levels.>",
  "levels": {
    "tp1Zone": {"low": <number>, "high": <number>},
    "tp2Zone": {"low": <number>, "high": <number>},
    "sl1Zone": {"low": <number>, "high": <number>},
    "sl2Zone": {"low": <number>, "high": <number>}
  },
  "scenarios": {
    "profitPath": {
      "name": "익절 경로",
      "probability": "<total probability for this path, e.g. 65%>",
      "trigger": {"label": "1차 익절", "price": <tp1Zone midpoint>, "pct": "(50%)"},
      "outcomes": [
        {
          "name": "본전 청산",
          "probability": "<e.g. 30%>",
          "type": "breakeven",
          "step": {"label": "본전", "price": <current price>, "pct": "(50%)"},
          "description": "<Korean: brief description of this outcome>"
        },
        {
          "name": "2차 익절",
          "probability": "<e.g. 35%>",
          "type": "tp",
          "step": {"label": "2차 익절", "price": <tp2Zone midpoint>, "pct": "(50%)"},
          "description": "<Korean: brief description>"
        }
      ]
    },
    "lossPath": {
      "name": "손절 경로",
      "probability": "<total probability for this path, e.g. 35%>",
      "trigger": {"label": "1차 손절", "price": <sl1Zone midpoint>, "pct": "(50%)"},
      "outcomes": [
        {
          "name": "1차 익절 회복",
          "probability": "<e.g. 20%>",
          "type": "tp",
          "step": {"label": "1차 익절", "price": <tp1Zone midpoint>, "pct": "(50%)"},
          "description": "<Korean: brief description>"
        },
        {
          "name": "2차 손절",
          "probability": "<e.g. 15%>",
          "type": "sl",
          "step": {"label": "2차 손절", "price": <sl2Zone midpoint>, "pct": "(50%)"},
          "description": "<Korean: brief description>"
        }
      ]
    }
  },
  "exitStrategy": {
    "partialExit": "<Korean: when to take partial profit>",
    "fullExit": "<Korean: when to close entire position>",
    "trailingStop": "<Korean: trailing stop description>"
  },
  "comment": "<Korean summary of strategy, under 120 chars, NO indicator names>",
  "summary": {
    "trend": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract>"},
    "momentum": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract>"},
    "strength": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, abstract>"},
    "zone": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean, describe demand/supply zones>"}
  }
}

## BRANCHING SCENARIO RULES:
The scenarios use a TREE structure with 2 main paths, each branching into 2 outcomes.

PATH 1 — 익절 경로 (Profit Path):
  Entry (100%) → price hits TP1 first → exit 50% at TP1 (1차 익절)
    ├→ price returns to entry → exit remaining 50% at break-even (본전)
    └→ price continues to TP2 → exit remaining 50% at TP2 (2차 익절)

PATH 2 — 손절 경로 (Loss Path):
  Entry (100%) → price hits SL1 first → exit 50% at SL1 (1차 손절)
    ├→ price recovers to TP1 → exit remaining 50% at TP1 (1차 익절 회복)
    └→ price continues to SL2 → exit remaining 50% at SL2 (2차 손절)

PROBABILITY RULES:
- profitPath.probability + lossPath.probability = 100%
- Within each path: the two outcome probabilities should sum to the path's total probability
- Example: profitPath 65% (breakeven 30% + tp2 35%), lossPath 35% (recovery 20% + sl2 15%)
- All 4 outcome probabilities should sum to ~100%

## LABEL RULES (CRITICAL):
- Levels ABOVE entry price → 저항 (resistance): 1차 저항, 2차 저항
- Levels BELOW entry price → 지지 (support): 1차 지지, 2차 지지
- For LONG: tp1/tp2 are above entry → "1차 저항", "2차 저항"; sl1/sl2 are below → "1차 지지", "2차 지지"
- For SHORT: tp1/tp2 are below entry → "1차 지지", "2차 지지"; sl1/sl2 are above → "1차 저항", "2차 저항"
- In the PRICE LEVELS section, use 저항/지지 labels
- In the SCENARIO FLOWS, use 익절/손절/본전 labels (these describe trading actions)

COMPLEX MODE RULES:
- ALL prices must be expressed as zones (low/high), NOT single numbers
- Zone width: ~0.5~1.5% of price for crypto, ~0.3~0.8% for stocks
- For LONG: tp1Zone < tp2Zone (both above current), sl1Zone > sl2Zone (both below current)
- For SHORT: tp1Zone > tp2Zone (both below current), sl1Zone < sl2Zone (both above current)
- Use midpoint of each zone for scenario flow prices.
- If direction is HOLD: set levels to null, scenarios to null.
- NEVER use TSI/RSI/ICT/OB/FVG/BOS in user-facing text — use abstract Korean terms only`;

// ── Indicator calculations ──
function calcRSI(closes, length = 21) {
  if (closes.length < length + 1) return [];
  const r = [];
  let gAvg = 0, lAvg = 0;
  for (let i = 1; i <= length; i++) {
    const ch = closes[i] - closes[i-1];
    if (ch > 0) gAvg += ch; else lAvg += Math.abs(ch);
  }
  gAvg /= length; lAvg /= length;
  for (let i = 0; i <= length; i++) r.push(null);
  r[length] = lAvg === 0 ? 100 : 100 - 100 / (1 + gAvg / lAvg);
  for (let i = length + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i-1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? Math.abs(ch) : 0;
    gAvg = (gAvg * (length-1) + g) / length;
    lAvg = (lAvg * (length-1) + l) / length;
    r.push(lAvg === 0 ? 100 : 100 - 100 / (1 + gAvg / lAvg));
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

function calcTSI(closes, long = 13, short = 8, sig = 8) {
  if (closes.length < long + short + 2) return { tsi: [], signal: [] };
  const ch = [null, ...closes.slice(1).map((c, i) => c - closes[i])];
  const absCh = ch.map(c => c === null ? null : Math.abs(c));
  const ds = calcEMA(calcEMA(ch, long), short);
  const ads = calcEMA(calcEMA(absCh, long), short);
  const tsi = ds.map((d, i) => d === null || ads[i] === null || ads[i] === 0 ? null : 100 * d / ads[i]);
  return { tsi, signal: calcEMA(tsi, sig) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { candles, symbol, timeframe, mode } = body;
    const isStrategic = mode === 'strategic';

    if (!candles || candles.length < 30) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '최소 30개 이상의 캔들이 필요합니다.' }) };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const rsiValues = calcRSI(closes, 21);
    const rsiSMA = calcSMA(rsiValues, 21);
    const tsiData = calcTSI(closes, 13, 8, 8);
    const last = closes.length - 1;
    const currentPrice = closes[last];

    const recentCandles = candles.slice(-50).map((c, i) => ({
      idx: candles.length - 50 + i, t: c.time,
      o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume
    }));

    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

    const prompt = `Analyze this ${symbol} ${timeframe} chart. Mode: ${isStrategic ? 'COMPLEX (복합 전략 — 4 scenarios with split positions)' : 'SIMPLE (단순 전략 — single TP/SL)'}.

CURRENT PRICE (즉시 진입 기준): ${currentPrice}

CURRENT PRIMARY INDICATORS:
- TSI(13,8,8): ${tsiData.tsi[last]?.toFixed(2) || 'N/A'}
- TSI Signal(8): ${tsiData.signal[last]?.toFixed(2) || 'N/A'}
- TSI vs Signal: ${tsiData.tsi[last] && tsiData.signal[last] ? (tsiData.tsi[last] > tsiData.signal[last] ? 'TSI ABOVE Signal (Bullish)' : 'TSI BELOW Signal (Bearish)') : 'N/A'}
- RSI(21): ${rsiValues[last]?.toFixed(2) || 'N/A'}
- RSI SMA(21): ${rsiSMA[last]?.toFixed(2) || 'N/A'}
- RSI vs SMA: ${rsiValues[last] && rsiSMA[last] ? (rsiValues[last] > rsiSMA[last] ? 'RSI ABOVE SMA (Bullish)' : 'RSI BELOW SMA (Bearish)') : 'N/A'}

SUPPLEMENTARY:
- Avg Volume(20): ${avgVol.toFixed(0)}
- Recent Volume(5): ${recVol.toFixed(0)}
- Volume Trend: ${recVol > avgVol * 1.2 ? 'INCREASING' : recVol < avgVol * 0.8 ? 'DECREASING' : 'STABLE'}

RECENT 50 CANDLES (OHLCV):
${JSON.stringify(recentCandles)}

Recent TSI (last 10): ${tsiData.tsi.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent TSI Signal (last 10): ${tsiData.signal.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent RSI (last 10): ${rsiValues.slice(-10).map(v => v?.toFixed(2)).join(', ')}

CRITICAL REMINDERS:
1. ENTRY IS AT CURRENT PRICE (${currentPrice}). Do NOT provide an entryZone. Entry is immediate.
2. In ALL user-facing text, NEVER use technical indicator names. Use abstract Korean terms only.
3. Label levels relative to entry: above entry = 저항, below entry = 지지.
4. For LONG: TP above → 저항, SL below → 지지. For SHORT: TP below → 지지, SL above → 저항.
5. Provide idealScenario describing the best expected outcome from current price.

Respond as JSON only.`;

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

    // Inject current price and calculated indicators
    analysis.currentPrice = currentPrice;
    analysis.calculatedIndicators = {
      rsi: rsiValues[last], rsiSMA: rsiSMA[last],
      tsi: tsiData.tsi[last], tsiSignal: tsiData.signal[last],
      avgVolume: avgVol, recentVolume: recVol
    };

    return { statusCode: 200, headers, body: JSON.stringify(analysis) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};