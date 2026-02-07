// ============================================================
// PATTERN RECOGNITION — Chart patterns for trading bots
// FIXED: NaN protection + better price formatting
// ============================================================

import type { OHLCV } from './technicalAnalysis.js';

// ============================================================
// TYPES
// ============================================================

export interface PatternResult {
  name: string;
  type: 'reversal' | 'continuation' | 'candlestick';
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  description: string;
  priceTarget?: number;
  stopLoss?: number;
}

export interface ChannelResult {
  type: 'ascending' | 'descending' | 'horizontal' | 'none';
  upperLine: { slope: number; intercept: number };
  lowerLine: { slope: number; intercept: number };
  strength: number;
  breakout: 'above' | 'below' | 'none';
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Safe number formatting - prevents NaN in output
function safeFormat(value: number | undefined | null, decimals: number = 8): string {
  if (value === undefined || value === null || !isFinite(value) || isNaN(value)) {
    return '---';
  }
  // For very small numbers, use scientific notation
  if (Math.abs(value) < 0.0000001 && value !== 0) {
    return value.toExponential(2);
  }
  // For normal numbers
  return value.toFixed(decimals);
}

// Safe percentage formatting
function safePercent(value: number | undefined | null): string {
  if (value === undefined || value === null || !isFinite(value) || isNaN(value)) {
    return '---';
  }
  return value.toFixed(1) + '%';
}

function findLocalMaxima(data: number[], order: number = 3): number[] {
  const maxima: number[] = [];
  for (let i = order; i < data.length - order; i++) {
    let isMax = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] <= data[i - j] || data[i] <= data[i + j]) {
        isMax = false;
        break;
      }
    }
    if (isMax) maxima.push(i);
  }
  return maxima;
}

function findLocalMinima(data: number[], order: number = 3): number[] {
  const minima: number[] = [];
  for (let i = order; i < data.length - order; i++) {
    let isMin = true;
    for (let j = 1; j <= order; j++) {
      if (data[i] >= data[i - j] || data[i] >= data[i + j]) {
        isMin = false;
        break;
      }
    }
    if (isMin) minima.push(i);
  }
  return minima;
}

function linearRegression(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] || 0, r2: 0 };
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };
  
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  
  const yMean = sumY / n;
  const ssTotal = y.reduce((acc, yi) => acc + (yi - yMean) ** 2, 0);
  const ssResidual = y.reduce((acc, yi, i) => acc + (yi - (slope * x[i] + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? Math.max(0, 1 - ssResidual / ssTotal) : 0;
  
  return { slope, intercept, r2 };
}

function percentDiff(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const avg = (a + b) / 2;
  if (avg === 0) return 100;
  return Math.abs(a - b) / avg * 100;
}

// ============================================================
// REVERSAL PATTERNS
// ============================================================

export function detectHeadAndShoulders(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 30) return null;
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  
  const maxima = findLocalMaxima(highs, 4);
  if (maxima.length < 3) return null;
  
  for (let i = maxima.length - 1; i >= 2; i--) {
    const rightShoulder = maxima[i];
    const head = maxima[i - 1];
    const leftShoulder = maxima[i - 2];
    
    if (highs[head] <= highs[leftShoulder] || highs[head] <= highs[rightShoulder]) continue;
    if (percentDiff(highs[leftShoulder], highs[rightShoulder]) > 5) continue;
    
    const avgShoulders = (highs[leftShoulder] + highs[rightShoulder]) / 2;
    if (avgShoulders === 0) continue;
    if ((highs[head] - avgShoulders) / avgShoulders * 100 < 3) continue;
    
    const necklineLeft = Math.min(...lows.slice(leftShoulder, head));
    const necklineRight = Math.min(...lows.slice(head, rightShoulder));
    const neckline = (necklineLeft + necklineRight) / 2;
    
    if (!isFinite(neckline) || neckline === 0) continue;
    
    const currentPrice = closes[closes.length - 1];
    const breakdown = currentPrice < neckline;
    
    if (rightShoulder > candles.length - 10) {
      const patternHeight = highs[head] - neckline;
      const priceTarget = neckline - patternHeight;
      
      return {
        name: 'Head & Shoulders',
        type: 'reversal',
        direction: 'bearish',
        confidence: breakdown ? 85 : 65,
        description: breakdown 
          ? `H&S confirmed, neckline broken`
          : `H&S forming, watch neckline`,
        priceTarget: isFinite(priceTarget) ? priceTarget : undefined,
        stopLoss: isFinite(highs[head]) ? highs[head] : undefined,
      };
    }
  }
  
  return null;
}

export function detectInverseHeadAndShoulders(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 30) return null;
  
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  
  const minima = findLocalMinima(lows, 4);
  if (minima.length < 3) return null;
  
  for (let i = minima.length - 1; i >= 2; i--) {
    const rightShoulder = minima[i];
    const head = minima[i - 1];
    const leftShoulder = minima[i - 2];
    
    if (lows[head] >= lows[leftShoulder] || lows[head] >= lows[rightShoulder]) continue;
    if (percentDiff(lows[leftShoulder], lows[rightShoulder]) > 5) continue;
    
    const avgShoulders = (lows[leftShoulder] + lows[rightShoulder]) / 2;
    if (lows[head] === 0) continue;
    if ((avgShoulders - lows[head]) / lows[head] * 100 < 3) continue;
    
    const necklineLeft = Math.max(...highs.slice(leftShoulder, head));
    const necklineRight = Math.max(...highs.slice(head, rightShoulder));
    const neckline = (necklineLeft + necklineRight) / 2;
    
    if (!isFinite(neckline)) continue;
    
    const currentPrice = closes[closes.length - 1];
    const breakout = currentPrice > neckline;
    
    if (rightShoulder > candles.length - 10) {
      const patternHeight = neckline - lows[head];
      const priceTarget = neckline + patternHeight;
      
      return {
        name: 'Inverse Head & Shoulders',
        type: 'reversal',
        direction: 'bullish',
        confidence: breakout ? 85 : 65,
        description: breakout
          ? `Inv H&S confirmed, breakout`
          : `Inv H&S forming, watch for breakout`,
        priceTarget: isFinite(priceTarget) ? priceTarget : undefined,
        stopLoss: isFinite(lows[head]) ? lows[head] : undefined,
      };
    }
  }
  
  return null;
}

export function detectDoubleTop(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 20) return null;
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  
  const maxima = findLocalMaxima(highs, 3);
  if (maxima.length < 2) return null;
  
  const peak2 = maxima[maxima.length - 1];
  const peak1 = maxima[maxima.length - 2];
  
  if (percentDiff(highs[peak1], highs[peak2]) > 3) return null;
  
  const valleySlice = lows.slice(peak1, peak2 + 1);
  if (valleySlice.length === 0) return null;
  
  const valley = Math.min(...valleySlice);
  const peakAvg = (highs[peak1] + highs[peak2]) / 2;
  
  if (!isFinite(valley) || !isFinite(peakAvg) || peakAvg === 0) return null;
  if ((peakAvg - valley) / peakAvg * 100 < 5) return null;
  if (peak2 < candles.length - 8) return null;
  
  const currentPrice = closes[closes.length - 1];
  const breakdown = currentPrice < valley;
  
  const patternHeight = peakAvg - valley;
  const priceTarget = valley - patternHeight;
  
  return {
    name: 'Double Top',
    type: 'reversal',
    direction: 'bearish',
    confidence: breakdown ? 80 : 60,
    description: breakdown
      ? `Double top confirmed, support broken`
      : `Double top forming, watch support level`,
    priceTarget: isFinite(priceTarget) ? priceTarget : undefined,
    stopLoss: isFinite(peakAvg) ? peakAvg : undefined,
  };
}

export function detectDoubleBottom(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 20) return null;
  
  const lows = candles.map(c => c.low);
  const highs = candles.map(c => c.high);
  const closes = candles.map(c => c.close);
  
  const minima = findLocalMinima(lows, 3);
  if (minima.length < 2) return null;
  
  const bottom2 = minima[minima.length - 1];
  const bottom1 = minima[minima.length - 2];
  
  if (percentDiff(lows[bottom1], lows[bottom2]) > 3) return null;
  
  const peakSlice = highs.slice(bottom1, bottom2 + 1);
  if (peakSlice.length === 0) return null;
  
  const peak = Math.max(...peakSlice);
  const bottomAvg = (lows[bottom1] + lows[bottom2]) / 2;
  
  if (!isFinite(peak) || !isFinite(bottomAvg) || bottomAvg === 0) return null;
  if ((peak - bottomAvg) / bottomAvg * 100 < 5) return null;
  if (bottom2 < candles.length - 8) return null;
  
  const currentPrice = closes[closes.length - 1];
  const breakout = currentPrice > peak;
  
  const patternHeight = peak - bottomAvg;
  const priceTarget = peak + patternHeight;
  
  return {
    name: 'Double Bottom',
    type: 'reversal',
    direction: 'bullish',
    confidence: breakout ? 80 : 60,
    description: breakout
      ? `Double bottom confirmed, breakout above resistance`
      : `Double bottom forming, watch resistance level`,
    priceTarget: isFinite(priceTarget) ? priceTarget : undefined,
    stopLoss: isFinite(bottomAvg) ? bottomAvg : undefined,
  };
}

// ============================================================
// CHANNEL DETECTION
// ============================================================

export function detectChannel(candles: OHLCV[]): ChannelResult {
  const noChannel: ChannelResult = {
    type: 'none',
    upperLine: { slope: 0, intercept: 0 },
    lowerLine: { slope: 0, intercept: 0 },
    strength: 0,
    breakout: 'none'
  };
  
  if (candles.length < 15) return noChannel;
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const x = candles.map((_, i) => i);
  
  const upperReg = linearRegression(x, highs);
  const lowerReg = linearRegression(x, lows);
  
  const slopeRatio = Math.abs(upperReg.slope) > 0.0000001 
    ? lowerReg.slope / upperReg.slope 
    : 0;
  
  const isParallel = slopeRatio > 0.5 && slopeRatio < 2;
  
  let channelType: 'ascending' | 'descending' | 'horizontal' | 'none' = 'none';
  const avgSlope = (upperReg.slope + lowerReg.slope) / 2;
  const priceRange = Math.max(...highs) - Math.min(...lows);
  
  if (priceRange === 0) return noChannel;
  
  const slopePercent = (avgSlope * candles.length) / priceRange * 100;
  
  if (!isParallel) {
    channelType = 'none';
  } else if (Math.abs(slopePercent) < 10) {
    channelType = 'horizontal';
  } else if (avgSlope > 0) {
    channelType = 'ascending';
  } else {
    channelType = 'descending';
  }
  
  let touches = 0;
  const tolerance = priceRange * 0.02;
  
  for (let i = 0; i < candles.length; i++) {
    const upperExpected = upperReg.slope * i + upperReg.intercept;
    const lowerExpected = lowerReg.slope * i + lowerReg.intercept;
    
    if (Math.abs(highs[i] - upperExpected) < tolerance) touches++;
    if (Math.abs(lows[i] - lowerExpected) < tolerance) touches++;
  }
  
  const strength = Math.min(100, (touches / candles.length) * 100);
  
  const lastPrice = closes[closes.length - 1];
  const lastUpper = upperReg.slope * (candles.length - 1) + upperReg.intercept;
  const lastLower = lowerReg.slope * (candles.length - 1) + lowerReg.intercept;
  
  let breakout: 'above' | 'below' | 'none' = 'none';
  if (lastPrice > lastUpper * 1.01) breakout = 'above';
  else if (lastPrice < lastLower * 0.99) breakout = 'below';
  
  return {
    type: channelType,
    upperLine: { slope: upperReg.slope, intercept: upperReg.intercept },
    lowerLine: { slope: lowerReg.slope, intercept: lowerReg.intercept },
    strength: isFinite(strength) ? strength : 0,
    breakout,
  };
}

// ============================================================
// TRIANGLE PATTERNS
// ============================================================

export function detectTriangle(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 15) return null;
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  
  const maxima = findLocalMaxima(highs, 2);
  const minima = findLocalMinima(lows, 2);
  
  if (maxima.length < 2 || minima.length < 2) return null;
  
  const recentMaxima = maxima.slice(-4);
  const recentMinima = minima.slice(-4);
  
  const upperY = recentMaxima.map(i => highs[i]);
  const lowerY = recentMinima.map(i => lows[i]);
  
  if (recentMaxima.length < 2 || recentMinima.length < 2) return null;
  
  const upperReg = linearRegression(recentMaxima, upperY);
  const lowerReg = linearRegression(recentMinima, lowerY);
  
  const upperSlope = upperReg.slope;
  const lowerSlope = lowerReg.slope;
  
  let triangleType: 'ascending' | 'descending' | 'symmetrical' | null = null;
  
  if (Math.abs(upperSlope) < Math.abs(lowerSlope) * 0.3 && lowerSlope > 0) {
    triangleType = 'ascending';
  } else if (Math.abs(lowerSlope) < Math.abs(upperSlope) * 0.3 && upperSlope < 0) {
    triangleType = 'descending';
  } else if (upperSlope < 0 && lowerSlope > 0) {
    triangleType = 'symmetrical';
  }
  
  if (!triangleType) return null;
  
  const slopeDiff = upperReg.slope - lowerReg.slope;
  if (slopeDiff === 0) return null;
  
  const apex = (lowerReg.intercept - upperReg.intercept) / slopeDiff;
  if (!isFinite(apex) || apex < candles.length) return null;
  
  const currentPrice = closes[closes.length - 1];
  const lastUpper = upperReg.slope * (candles.length - 1) + upperReg.intercept;
  const lastLower = lowerReg.slope * (candles.length - 1) + lowerReg.intercept;
  
  let breakout: 'above' | 'below' | 'none' = 'none';
  if (currentPrice > lastUpper) breakout = 'above';
  else if (currentPrice < lastLower) breakout = 'below';
  
  const direction = triangleType === 'ascending' ? 'bullish' 
    : triangleType === 'descending' ? 'bearish' 
    : 'neutral';
  
  const patternHeight = Math.max(...highs.slice(-15)) - Math.min(...lows.slice(-15));
  
  return {
    name: `${triangleType.charAt(0).toUpperCase() + triangleType.slice(1)} Triangle`,
    type: 'continuation',
    direction: breakout === 'above' ? 'bullish' : breakout === 'below' ? 'bearish' : direction,
    confidence: breakout !== 'none' ? 75 : 55,
    description: breakout !== 'none'
      ? `${triangleType} triangle breakout ${breakout}`
      : `${triangleType} triangle forming, apex in ~${Math.floor(apex - candles.length)} candles`,
    priceTarget: breakout === 'above' && isFinite(patternHeight) ? currentPrice + patternHeight 
      : breakout === 'below' && isFinite(patternHeight) ? currentPrice - patternHeight 
      : undefined,
  };
}

// ============================================================
// WEDGE PATTERNS
// ============================================================

export function detectWedge(candles: OHLCV[]): PatternResult | null {
  if (candles.length < 20) return null;
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const x = candles.map((_, i) => i);
  
  const upperReg = linearRegression(x, highs);
  const lowerReg = linearRegression(x, lows);
  
  if (Math.sign(upperReg.slope) !== Math.sign(lowerReg.slope)) return null;
  
  const upperEnd = upperReg.slope * candles.length + upperReg.intercept;
  const lowerEnd = lowerReg.slope * candles.length + lowerReg.intercept;
  const upperStart = upperReg.intercept;
  const lowerStart = lowerReg.intercept;
  
  const startWidth = upperStart - lowerStart;
  const endWidth = upperEnd - lowerEnd;
  
  if (!isFinite(startWidth) || !isFinite(endWidth)) return null;
  if (endWidth >= startWidth * 0.9) return null;
  
  const isRising = upperReg.slope > 0;
  const wedgeType = isRising ? 'Rising Wedge' : 'Falling Wedge';
  const direction = isRising ? 'bearish' : 'bullish';
  
  const currentPrice = closes[closes.length - 1];
  let breakout: 'above' | 'below' | 'none' = 'none';
  if (currentPrice > upperEnd * 1.01) breakout = 'above';
  else if (currentPrice < lowerEnd * 0.99) breakout = 'below';
  
  const confirmed = (isRising && breakout === 'below') || (!isRising && breakout === 'above');
  
  return {
    name: wedgeType,
    type: 'reversal',
    direction,
    confidence: confirmed ? 80 : breakout !== 'none' ? 60 : 50,
    description: confirmed
      ? `${wedgeType} breakdown confirmed, reversal in progress`
      : breakout !== 'none'
      ? `${wedgeType} broken ${breakout}, watch for continuation`
      : `${wedgeType} forming, expect ${direction} breakout`,
  };
}

// ============================================================
// CANDLESTICK PATTERNS
// ============================================================

export function detectCandlestickPatterns(candles: OHLCV[]): PatternResult[] {
  const patterns: PatternResult[] = [];
  
  if (candles.length < 3) return patterns;
  
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  
  const bodySize = (c: OHLCV) => Math.abs(c.close - c.open);
  const wickUpper = (c: OHLCV) => c.high - Math.max(c.open, c.close);
  const wickLower = (c: OHLCV) => Math.min(c.open, c.close) - c.low;
  const isBullish = (c: OHLCV) => c.close > c.open;
  const range = (c: OHLCV) => c.high - c.low;
  
  // DOJI
  const lastRange = range(last);
  if (lastRange > 0 && bodySize(last) < lastRange * 0.1) {
    patterns.push({
      name: 'Doji',
      type: 'candlestick',
      direction: 'neutral',
      confidence: 60,
      description: 'Doji - market indecision, potential reversal',
    });
  }
  
  // HAMMER
  const lastBody = bodySize(last);
  if (lastBody > 0 && wickLower(last) > lastBody * 2 && wickUpper(last) < lastBody * 0.5) {
    const recentLows = candles.slice(-10).map(c => c.low);
    const minLow = Math.min(...recentLows);
    if (isFinite(minLow) && last.low <= minLow * 1.02) {
      patterns.push({
        name: 'Hammer',
        type: 'candlestick',
        direction: 'bullish',
        confidence: 70,
        description: 'Hammer at support - bullish reversal signal',
      });
    }
  }
  
  // SHOOTING STAR
  if (lastBody > 0 && wickUpper(last) > lastBody * 2 && wickLower(last) < lastBody * 0.5) {
    const recentHighs = candles.slice(-10).map(c => c.high);
    const maxHigh = Math.max(...recentHighs);
    if (isFinite(maxHigh) && last.high >= maxHigh * 0.98) {
      patterns.push({
        name: 'Shooting Star',
        type: 'candlestick',
        direction: 'bearish',
        confidence: 70,
        description: 'Shooting star at resistance - bearish reversal',
      });
    }
  }
  
  // BULLISH ENGULFING
  const prevBody = bodySize(prev);
  if (prevBody > 0 && !isBullish(prev) && isBullish(last) && 
      last.open < prev.close && last.close > prev.open &&
      lastBody > prevBody * 1.5) {
    patterns.push({
      name: 'Bullish Engulfing',
      type: 'candlestick',
      direction: 'bullish',
      confidence: 75,
      description: 'Bullish engulfing - strong reversal signal',
    });
  }
  
  // BEARISH ENGULFING
  if (prevBody > 0 && isBullish(prev) && !isBullish(last) && 
      last.open > prev.close && last.close < prev.open &&
      lastBody > prevBody * 1.5) {
    patterns.push({
      name: 'Bearish Engulfing',
      type: 'candlestick',
      direction: 'bearish',
      confidence: 75,
      description: 'Bearish engulfing - strong sell signal',
    });
  }
  
  // MORNING STAR
  const prev2Range = range(prev2);
  const prevRange = range(prev);
  const lastRangeCheck = range(last);
  
  if (prev2Range > 0 && prevRange > 0 && lastRangeCheck > 0 &&
      !isBullish(prev2) && bodySize(prev2) > prev2Range * 0.6 &&
      bodySize(prev) < prevRange * 0.3 &&
      isBullish(last) && bodySize(last) > lastRangeCheck * 0.6 &&
      last.close > (prev2.open + prev2.close) / 2) {
    patterns.push({
      name: 'Morning Star',
      type: 'candlestick',
      direction: 'bullish',
      confidence: 80,
      description: 'Morning star - strong bullish reversal',
    });
  }
  
  // EVENING STAR
  if (prev2Range > 0 && prevRange > 0 && lastRangeCheck > 0 &&
      isBullish(prev2) && bodySize(prev2) > prev2Range * 0.6 &&
      bodySize(prev) < prevRange * 0.3 &&
      !isBullish(last) && bodySize(last) > lastRangeCheck * 0.6 &&
      last.close < (prev2.open + prev2.close) / 2) {
    patterns.push({
      name: 'Evening Star',
      type: 'candlestick',
      direction: 'bearish',
      confidence: 80,
      description: 'Evening star - strong bearish reversal',
    });
  }
  
  // THREE WHITE SOLDIERS
  if (candles.length >= 3) {
    const last3 = candles.slice(-3);
    const allBullish = last3.every(c => {
      const r = range(c);
      return r > 0 && isBullish(c) && bodySize(c) > r * 0.6;
    });
    if (allBullish) {
      const increasing = last3[0].close < last3[1].close && last3[1].close < last3[2].close;
      if (increasing) {
        patterns.push({
          name: 'Three White Soldiers',
          type: 'candlestick',
          direction: 'bullish',
          confidence: 75,
          description: 'Three white soldiers - strong bullish momentum',
        });
      }
    }
  }
  
  // THREE BLACK CROWS
  if (candles.length >= 3) {
    const last3 = candles.slice(-3);
    const allBearish = last3.every(c => {
      const r = range(c);
      return r > 0 && !isBullish(c) && bodySize(c) > r * 0.6;
    });
    if (allBearish) {
      const decreasing = last3[0].close > last3[1].close && last3[1].close > last3[2].close;
      if (decreasing) {
        patterns.push({
          name: 'Three Black Crows',
          type: 'candlestick',
          direction: 'bearish',
          confidence: 75,
          description: 'Three black crows - strong bearish pressure',
        });
      }
    }
  }
  
  return patterns;
}

// ============================================================
// MAIN PATTERN DETECTION
// ============================================================

export function detectAllPatterns(candles: OHLCV[]): {
  patterns: PatternResult[];
  channel: ChannelResult;
  summary: string;
  dominantSignal: 'bullish' | 'bearish' | 'neutral';
} {
  const patterns: PatternResult[] = [];
  
  const hs = detectHeadAndShoulders(candles);
  if (hs) patterns.push(hs);
  
  const ihs = detectInverseHeadAndShoulders(candles);
  if (ihs) patterns.push(ihs);
  
  const dt = detectDoubleTop(candles);
  if (dt) patterns.push(dt);
  
  const db = detectDoubleBottom(candles);
  if (db) patterns.push(db);
  
  const triangle = detectTriangle(candles);
  if (triangle) patterns.push(triangle);
  
  const wedge = detectWedge(candles);
  if (wedge) patterns.push(wedge);
  
  const candlesticks = detectCandlestickPatterns(candles);
  patterns.push(...candlesticks);
  
  const channel = detectChannel(candles);
  
  let bullishScore = 0;
  let bearishScore = 0;
  
  for (const p of patterns) {
    const weight = p.confidence / 100;
    if (p.direction === 'bullish') bullishScore += weight;
    else if (p.direction === 'bearish') bearishScore += weight;
  }
  
  if (channel.type !== 'none') {
    if (channel.breakout === 'above') bullishScore += 0.5;
    else if (channel.breakout === 'below') bearishScore += 0.5;
    else if (channel.type === 'ascending') bullishScore += 0.3;
    else if (channel.type === 'descending') bearishScore += 0.3;
  }
  
  let dominantSignal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (bullishScore > bearishScore + 0.5) dominantSignal = 'bullish';
  else if (bearishScore > bullishScore + 0.5) dominantSignal = 'bearish';
  
  const summaryParts: string[] = [];
  
  if (channel.type !== 'none') {
    summaryParts.push(`${channel.type} channel${channel.breakout !== 'none' ? ` (breakout ${channel.breakout})` : ''}`);
  }
  
  const mainPatterns = patterns.filter(p => p.type !== 'candlestick').slice(0, 2);
  for (const p of mainPatterns) {
    summaryParts.push(p.name);
  }
  
  const strongCandlesticks = patterns.filter(p => p.type === 'candlestick' && p.confidence >= 70);
  if (strongCandlesticks.length > 0) {
    summaryParts.push(strongCandlesticks[0].name);
  }
  
  const summary = summaryParts.length > 0 ? summaryParts.join(' + ') : 'No clear patterns';
  
  return {
    patterns,
    channel,
    summary,
    dominantSignal,
  };
}