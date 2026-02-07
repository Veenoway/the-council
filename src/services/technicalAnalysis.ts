// ============================================================
// TECHNICAL ANALYSIS — Full analysis with patterns
// ============================================================

import { detectAllPatterns, type PatternResult, type ChannelResult } from './patternRecognistion.js';

const API_URL = process.env.NAD_API_URL || 'https://api.nadapp.net';
const API_KEY = process.env.NAD_API_KEY || '';
const headers: Record<string, string> = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ============================================================
// TYPES
// ============================================================

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  // Price
  price: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  
  // RSI
  rsi: number;
  rsiSignal: 'overbought' | 'oversold' | 'neutral';
  rsiTrend: 'rising' | 'falling' | 'flat';
  
  // Moving Averages
  ma5: number;
  ma10: number;
  ma20: number;
  maSignal: 'bullish' | 'bearish' | 'neutral';
  maCrossover: 'golden_cross' | 'death_cross' | 'none';
  priceVsMa: 'above_all' | 'below_all' | 'mixed';
  
  // MACD
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdCrossover: 'bullish' | 'bearish' | 'none';
  
  // Bollinger Bands
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbWidth: number;
  bbPosition: 'above_upper' | 'below_lower' | 'middle';
  bbSqueeze: boolean;
  
  // Volume
  volumeAvg: number;
  volumeLatest: number;
  volumeRatio: number;
  volumeSpike: boolean;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  obv: number;
  obvTrend: 'accumulation' | 'distribution' | 'neutral';
  
  // VWAP
  vwap: number;
  priceVsVwap: 'above' | 'below' | 'at';
  vwapDistance: number;
  
  // Order Flow
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
  largeOrders: number;
  whaleActivity: 'buying' | 'selling' | 'none';
  
  // Volatility
  volatility: number;
  atr: number;
  volatilityState: 'high' | 'low' | 'normal';
  
  // Support/Resistance
  support: number;
  resistance: number;
  nearSupport: boolean;
  nearResistance: boolean;
  
  // Trend
  trend: 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';
  trendStrength: number;
  momentum: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  
  // === PATTERNS ===
  patterns: PatternResult[];
  channel: ChannelResult;
  patternSummary: string;
  patternSignal: 'bullish' | 'bearish' | 'neutral';
  
  // Signals
  signal: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  confidence: number;
  
  // Reasoning
  bullishFactors: string[];
  bearishFactors: string[];
  keyInsight: string;
}

// ============================================================
// DATA FETCHING
// ============================================================

export async function fetchOHLCV(tokenAddress: string, resolution: string = '5', countback: number = 100): Promise<OHLCV[]> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const resSeconds = getResolutionSeconds(resolution);
    const from = now - (countback * resSeconds);
    
    const url = `${API_URL}/agent/chart/${tokenAddress}?resolution=${resolution}&from=${from}&to=${now}&countback=${countback}`;
    const response = await fetch(url, { headers });
    
    if (!response.ok) return [];
    const data = await response.json();
    if (data.s !== 'ok' || !data.t) return [];
    
    return data.t.map((t: number, i: number) => ({
      timestamp: t,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i] || 0,
    }));
  } catch { return []; }
}

async function fetchMetrics(tokenAddress: string): Promise<any[]> {
  try {
    const url = `${API_URL}/agent/metrics/${tokenAddress}?timeframes=1,5,15,60,1440`;
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const data = await response.json();
    return data.metrics || [];
  } catch { return []; }
}

async function fetchRecentSwaps(tokenAddress: string, limit: number = 100): Promise<any[]> {
  try {
    const url = `${API_URL}/agent/swap-history/${tokenAddress}?limit=${limit}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.swaps || []).map((s: any) => ({
      type: s.swap_info?.event_type === 'BUY' ? 'BUY' : 'SELL',
      nativeAmount: parseFloat(s.swap_info?.native_amount || '0'),
      maker: s.swap_info?.maker || '',
    }));
  } catch { return []; }
}

// ============================================================
// INDICATOR CALCULATIONS
// ============================================================

function calculateRSI(closes: number[], period: number = 14): { rsi: number; trend: 'rising' | 'falling' | 'flat' } {
  if (closes.length < period + 1) return { rsi: 50, trend: 'flat' };
  
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = 0, avgLoss = 0;
  
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;
  
  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - changes[i]) / period;
    }
  }
  
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  // Trend
  const rsiHistory: number[] = [];
  let tAvgGain = 0, tAvgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) tAvgGain += changes[i];
    else tAvgLoss -= changes[i];
  }
  tAvgGain /= period;
  tAvgLoss /= period;
  
  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      tAvgGain = (tAvgGain * (period - 1) + changes[i]) / period;
      tAvgLoss = (tAvgLoss * (period - 1)) / period;
    } else {
      tAvgGain = (tAvgGain * (period - 1)) / period;
      tAvgLoss = (tAvgLoss * (period - 1) - changes[i]) / period;
    }
    const trs = tAvgLoss === 0 ? 100 : tAvgGain / tAvgLoss;
    rsiHistory.push(100 - (100 / (1 + trs)));
  }
  
  const recent = rsiHistory.slice(-5);
  let trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (recent.length >= 3) {
    const diff = recent[recent.length - 1] - recent[0];
    if (diff > 5) trend = 'rising';
    else if (diff < -5) trend = 'falling';
  }
  
  return { rsi, trend };
}

function calculateMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number; crossover: 'bullish' | 'bearish' | 'none' } {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0, crossover: 'none' };
  
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = ema12 - ema26;
  
  const macdHistory: number[] = [];
  for (let i = 26; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    macdHistory.push(calculateEMA(slice, 12) - calculateEMA(slice, 26));
  }
  
  const signal = macdHistory.length >= 9 ? calculateEMA(macdHistory, 9) : macd;
  const histogram = macd - signal;
  
  let crossover: 'bullish' | 'bearish' | 'none' = 'none';
  if (macdHistory.length >= 2) {
    const prevMacd = macdHistory[macdHistory.length - 2];
    const prevSignal = macdHistory.length >= 10 ? calculateEMA(macdHistory.slice(0, -1), 9) : prevMacd;
    if (prevMacd < prevSignal && macd > signal) crossover = 'bullish';
    else if (prevMacd > prevSignal && macd < signal) crossover = 'bearish';
  }
  
  return { macd, signal, histogram, crossover };
}

function calculateBollingerBands(closes: number[], period: number = 20): { upper: number; middle: number; lower: number; width: number; squeeze: boolean } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last, width: 0, squeeze: false };
  }
  
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + (val - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  
  const upper = middle + (2 * std);
  const lower = middle - (2 * std);
  const width = ((upper - lower) / middle) * 100;
  
  return { upper, middle, lower, width, squeeze: width < 4 };
}

function calculateVWAP(candles: OHLCV[]): number {
  if (candles.length === 0) return 0;
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : candles[candles.length - 1].close;
}

function calculateOBV(candles: OHLCV[]): { obv: number; trend: 'accumulation' | 'distribution' | 'neutral' } {
  if (candles.length < 2) return { obv: 0, trend: 'neutral' };
  
  let obv = 0;
  const obvHistory: number[] = [0];
  
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    obvHistory.push(obv);
  }
  
  const recent = obvHistory.slice(-10);
  let trend: 'accumulation' | 'distribution' | 'neutral' = 'neutral';
  if (recent.length >= 5) {
    const change = recent[recent.length - 1] - recent[0];
    const avgObv = Math.abs(obvHistory.reduce((a, b) => a + Math.abs(b), 0) / obvHistory.length) || 1;
    if (change > avgObv * 0.1) trend = 'accumulation';
    else if (change < -avgObv * 0.1) trend = 'distribution';
  }
  
  return { obv, trend };
}

function calculateATR(candles: OHLCV[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trueRanges.push(tr);
  }
  
  return trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function analyzeOrderFlow(swaps: any[]): { buyCount: number; sellCount: number; buyVolume: number; sellVolume: number; ratio: number; largeOrders: number; whaleActivity: 'buying' | 'selling' | 'none' } {
  const buys = swaps.filter(s => s.type === 'BUY');
  const sells = swaps.filter(s => s.type === 'SELL');
  
  const buyVolume = buys.reduce((sum, s) => sum + s.nativeAmount, 0);
  const sellVolume = sells.reduce((sum, s) => sum + s.nativeAmount, 0);
  
  const WHALE = 1;
  const largeBuys = buys.filter(s => s.nativeAmount > WHALE);
  const largeSells = sells.filter(s => s.nativeAmount > WHALE);
  
  const largeBuyVol = largeBuys.reduce((sum, s) => sum + s.nativeAmount, 0);
  const largeSellVol = largeSells.reduce((sum, s) => sum + s.nativeAmount, 0);
  
  let whaleActivity: 'buying' | 'selling' | 'none' = 'none';
  if (largeBuyVol > largeSellVol * 1.5) whaleActivity = 'buying';
  else if (largeSellVol > largeBuyVol * 1.5) whaleActivity = 'selling';
  
  return {
    buyCount: buys.length,
    sellCount: sells.length,
    buyVolume,
    sellVolume,
    ratio: sellVolume > 0 ? buyVolume / sellVolume : buys.length > 0 ? 10 : 1,
    largeOrders: largeBuys.length + largeSells.length,
    whaleActivity,
  };
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

export async function analyzeTechnicals(tokenAddress: string): Promise<TechnicalIndicators | null> {
  try {
    const [candles, metrics, swaps] = await Promise.all([
      fetchOHLCV(tokenAddress, '5', 100),
      fetchMetrics(tokenAddress),
      fetchRecentSwaps(tokenAddress, 100),
    ]);
    
    if (candles.length < 15) {
      console.log(`Not enough data: ${candles.length} candles`);
      return null;
    }
    
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const currentPrice = closes[closes.length - 1];
    
    // === PATTERNS ===
    const patternAnalysis = detectAllPatterns(candles);
    
    // === RSI ===
    const { rsi, trend: rsiTrend } = calculateRSI(closes, 14);
    const rsiSignal: 'overbought' | 'oversold' | 'neutral' = rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral';
    
    // === MAs ===
    const ma5 = calculateMA(closes, 5);
    const ma10 = calculateMA(closes, 10);
    const ma20 = calculateMA(closes, 20);
    
    const maSignal: 'bullish' | 'bearish' | 'neutral' = 
      currentPrice > ma5 && ma5 > ma20 ? 'bullish' :
      currentPrice < ma5 && ma5 < ma20 ? 'bearish' : 'neutral';
    
    const prevMa5 = calculateMA(closes.slice(0, -1), 5);
    const prevMa20 = calculateMA(closes.slice(0, -1), 20);
    const maCrossover: 'golden_cross' | 'death_cross' | 'none' = 
      prevMa5 < prevMa20 && ma5 > ma20 ? 'golden_cross' :
      prevMa5 > prevMa20 && ma5 < ma20 ? 'death_cross' : 'none';
    
    const priceVsMa: 'above_all' | 'below_all' | 'mixed' = 
      currentPrice > ma5 && currentPrice > ma10 && currentPrice > ma20 ? 'above_all' :
      currentPrice < ma5 && currentPrice < ma10 && currentPrice < ma20 ? 'below_all' : 'mixed';
    
    // === MACD ===
    const macdData = calculateMACD(closes);
    
    // === BB ===
    const bb = calculateBollingerBands(closes);
    const bbPosition: 'above_upper' | 'below_lower' | 'middle' = 
      currentPrice > bb.upper ? 'above_upper' : currentPrice < bb.lower ? 'below_lower' : 'middle';
    
    // === Volume ===
    const volumeAvg = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const volumeLatest = volumes[volumes.length - 1] || 0;
    const volumeRatio = volumeAvg > 0 ? volumeLatest / volumeAvg : 1;
    const volumeSpike = volumeRatio > 2;
    
    const recentVol = volumes.slice(-5);
    const olderVol = volumes.slice(-10, -5);
    const volumeTrend: 'increasing' | 'decreasing' | 'stable' = 
      recentVol.reduce((a, b) => a + b, 0) / 5 > (olderVol.reduce((a, b) => a + b, 0) / 5) * 1.3 ? 'increasing' :
      recentVol.reduce((a, b) => a + b, 0) / 5 < (olderVol.reduce((a, b) => a + b, 0) / 5) * 0.7 ? 'decreasing' : 'stable';
    
    // === OBV ===
    const { obv, trend: obvTrend } = calculateOBV(candles);
    
    // === VWAP ===
    const vwap = calculateVWAP(candles);
    const vwapDistance = ((currentPrice - vwap) / vwap) * 100;
    const priceVsVwap: 'above' | 'below' | 'at' = vwapDistance > 2 ? 'above' : vwapDistance < -2 ? 'below' : 'at';
    
    // === Order Flow ===
    const orderFlow = analyzeOrderFlow(swaps);
    
    // === Volatility ===
    const atr = calculateATR(candles);
    const volatility = (atr / currentPrice) * 100;
    const volatilityState: 'high' | 'low' | 'normal' = volatility > 10 ? 'high' : volatility < 3 ? 'low' : 'normal';
    
    // === Support/Resistance ===
    const lows = candles.slice(-30).map(c => c.low);
    const highs = candles.slice(-30).map(c => c.high);
    const support = Math.min(...lows);
    const resistance = Math.max(...highs);
    const nearSupport = currentPrice < support * 1.05;
    const nearResistance = currentPrice > resistance * 0.95;
    
    // === Trend ===
    const recentCloses = closes.slice(-10);
    const olderCloses = closes.slice(-20, -10);
    const recentAvg = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    const olderAvg = olderCloses.reduce((a, b) => a + b, 0) / olderCloses.length;
    const trendChange = ((recentAvg - olderAvg) / olderAvg) * 100;
    
    let trend: 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';
    let trendStrength: number;
    
    if (priceVsMa === 'above_all' && trendChange > 10) { trend = 'strong_uptrend'; trendStrength = 80; }
    else if (priceVsMa === 'above_all' && trendChange > 3) { trend = 'uptrend'; trendStrength = 60; }
    else if (priceVsMa === 'below_all' && trendChange < -10) { trend = 'strong_downtrend'; trendStrength = 80; }
    else if (priceVsMa === 'below_all' && trendChange < -3) { trend = 'downtrend'; trendStrength = 60; }
    else { trend = 'sideways'; trendStrength = 40; }
    
    // === Momentum ===
    const momentumScore = (rsi > 50 ? 1 : -1) + (maSignal === 'bullish' ? 1 : maSignal === 'bearish' ? -1 : 0) +
      (macdData.histogram > 0 ? 1 : -1) + (priceVsVwap === 'above' ? 1 : priceVsVwap === 'below' ? -1 : 0) +
      (orderFlow.ratio > 1.5 ? 1 : orderFlow.ratio < 0.67 ? -1 : 0);
    
    const momentum: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish' =
      momentumScore >= 4 ? 'strong_bullish' : momentumScore >= 2 ? 'bullish' :
      momentumScore <= -4 ? 'strong_bearish' : momentumScore <= -2 ? 'bearish' : 'neutral';
    
    // === Price changes ===
    const m5 = metrics.find((m: any) => m.timeframe === '5');
    const m60 = metrics.find((m: any) => m.timeframe === '60');
    const m1440 = metrics.find((m: any) => m.timeframe === '1440');
    
    // === Build factors ===
    const bullishFactors: string[] = [];
    const bearishFactors: string[] = [];
    
    // Indicator-based factors
    if (rsiSignal === 'oversold') bullishFactors.push(`RSI ${rsi.toFixed(0)} oversold`);
    if (rsiSignal === 'overbought') bearishFactors.push(`RSI ${rsi.toFixed(0)} overbought`);
    if (maCrossover === 'golden_cross') bullishFactors.push('Golden cross');
    if (maCrossover === 'death_cross') bearishFactors.push('Death cross');
    if (macdData.crossover === 'bullish') bullishFactors.push('MACD bullish cross');
    if (macdData.crossover === 'bearish') bearishFactors.push('MACD bearish cross');
    if (bbPosition === 'below_lower') bullishFactors.push('At lower BB');
    if (bbPosition === 'above_upper') bearishFactors.push('At upper BB');
    if (bb.squeeze) bullishFactors.push('BB squeeze forming');
    if (volumeSpike && (m60?.percent || 0) > 0) bullishFactors.push(`Volume spike ${volumeRatio.toFixed(1)}x`);
    if (volumeSpike && (m60?.percent || 0) < 0) bearishFactors.push(`Volume spike on dump`);
    if (obvTrend === 'accumulation') bullishFactors.push('OBV accumulation');
    if (obvTrend === 'distribution') bearishFactors.push('OBV distribution');
    if (orderFlow.whaleActivity === 'buying') bullishFactors.push('Whales buying');
    if (orderFlow.whaleActivity === 'selling') bearishFactors.push('Whales selling');
    if (nearSupport) bullishFactors.push('Near support');
    if (nearResistance) bearishFactors.push('Near resistance');
    
    // Pattern-based factors
    for (const p of patternAnalysis.patterns) {
      if (p.direction === 'bullish' && p.confidence >= 60) {
        bullishFactors.push(`${p.name} pattern`);
      } else if (p.direction === 'bearish' && p.confidence >= 60) {
        bearishFactors.push(`${p.name} pattern`);
      }
    }
    
    if (patternAnalysis.channel.type !== 'none') {
      if (patternAnalysis.channel.breakout === 'above') bullishFactors.push(`${patternAnalysis.channel.type} channel breakout`);
      else if (patternAnalysis.channel.breakout === 'below') bearishFactors.push(`${patternAnalysis.channel.type} channel breakdown`);
      else if (patternAnalysis.channel.type === 'ascending') bullishFactors.push('In ascending channel');
      else if (patternAnalysis.channel.type === 'descending') bearishFactors.push('In descending channel');
    }
    
    // === Final signal ===
    const netScore = bullishFactors.length - bearishFactors.length;
    let signal: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    let confidence: number;
    
    if (netScore >= 5) { signal = 'strong_buy'; confidence = Math.min(90, 60 + netScore * 4); }
    else if (netScore >= 2) { signal = 'buy'; confidence = Math.min(75, 50 + netScore * 4); }
    else if (netScore <= -5) { signal = 'strong_sell'; confidence = Math.min(90, 60 + Math.abs(netScore) * 4); }
    else if (netScore <= -2) { signal = 'sell'; confidence = Math.min(75, 50 + Math.abs(netScore) * 4); }
    else { signal = 'hold'; confidence = 40; }
    
    // === Key insight ===
    let keyInsight = '';
    const topBullish = bullishFactors[0];
    const topBearish = bearishFactors[0];
    
    if (patternAnalysis.patterns.length > 0) {
      const mainPattern = patternAnalysis.patterns.find(p => p.type !== 'candlestick') || patternAnalysis.patterns[0];
      keyInsight = `${mainPattern.name}: ${mainPattern.description}`;
    } else if (netScore > 0) {
      keyInsight = topBullish || 'Leaning bullish';
    } else if (netScore < 0) {
      keyInsight = topBearish || 'Leaning bearish';
    } else {
      keyInsight = 'Mixed signals - wait for confirmation';
    }
    
    return {
      price: currentPrice,
      priceChange5m: m5?.percent || 0,
      priceChange1h: m60?.percent || 0,
      priceChange24h: m1440?.percent || 0,
      
      rsi, rsiSignal, rsiTrend,
      ma5, ma10, ma20, maSignal, maCrossover, priceVsMa,
      macd: macdData.macd, macdSignal: macdData.signal, macdHistogram: macdData.histogram, macdCrossover: macdData.crossover,
      bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower, bbWidth: bb.width, bbPosition, bbSqueeze: bb.squeeze,
      volumeAvg, volumeLatest, volumeRatio, volumeSpike, volumeTrend, obv, obvTrend,
      vwap, priceVsVwap, vwapDistance,
      buyCount: orderFlow.buyCount, sellCount: orderFlow.sellCount, buyVolume: orderFlow.buyVolume,
      sellVolume: orderFlow.sellVolume, buySellRatio: orderFlow.ratio, largeOrders: orderFlow.largeOrders,
      whaleActivity: orderFlow.whaleActivity,
      volatility, atr, volatilityState,
      support, resistance, nearSupport, nearResistance,
      trend, trendStrength, momentum,
      
      patterns: patternAnalysis.patterns,
      channel: patternAnalysis.channel,
      patternSummary: patternAnalysis.summary,
      patternSignal: patternAnalysis.dominantSignal,
      
      signal, confidence,
      bullishFactors, bearishFactors, keyInsight,
    };
  } catch (error) {
    console.error('TA failed:', error);
    return null;
  }
}

function getResolutionSeconds(resolution: string): number {
  const map: Record<string, number> = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, '1D': 86400 };
  return map[resolution] || 300;
}

// ============================================================
// EXPORT HELPERS
// ============================================================

export function formatTAForDiscussion(ta: TechnicalIndicators): string {
  const parts: string[] = [];
  parts.push(`RSI ${ta.rsi.toFixed(0)}${ta.rsiSignal !== 'neutral' ? ` (${ta.rsiSignal})` : ''}`);
  if (ta.macdCrossover !== 'none') parts.push(`MACD ${ta.macdCrossover}`);
  parts.push(ta.trend.replace(/_/g, ' '));
  if (ta.volumeSpike) parts.push(`vol ${ta.volumeRatio.toFixed(1)}x`);
  if (ta.patternSummary !== 'No clear patterns') parts.push(ta.patternSummary);
  return parts.join(' | ');
}

export function getTAKeyPoints(ta: TechnicalIndicators): { bullish: string[]; bearish: string[] } {
  return { bullish: ta.bullishFactors.slice(0, 3), bearish: ta.bearishFactors.slice(0, 3) };
}

export { PatternResult, ChannelResult };