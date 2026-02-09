// ============================================================
// TECHNICAL ANALYSIS — With cache to avoid rate limiting
// ============================================================

const API_URL = process.env.NAD_API_URL || 'https://api.nadapp.net';
const API_KEY = process.env.NAD_API_KEY || '';
const headers: Record<string, string> = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ============================================================
// CACHE
// ============================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const taCache = {
  ohlcv: new Map<string, CacheEntry<OHLCV[]>>(),
  metrics: new Map<string, CacheEntry<any[]>>(),
  swaps: new Map<string, CacheEntry<any[]>>(),
};

const CACHE_TTL = 30_000; // 30 seconds for TA data (fresher than market data)

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    map.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCache<T>(map: Map<string, CacheEntry<T>>, key: string, data: T): void {
  map.set(key, { data, timestamp: Date.now() });
}

// ============================================================
// RATE LIMITING
// ============================================================

let lastApiCall = 0;
const MIN_API_INTERVAL = 500; // 500ms between calls

async function rateLimitedFetch<T>(url: string): Promise<T | null> {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCall;
  
  if (timeSinceLastCall < MIN_API_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_API_INTERVAL - timeSinceLastCall));
  }
  
  lastApiCall = Date.now();
  
  try {
    const res = await fetch(url, { headers });
    
    if (res.status === 429) {
      console.error(`Rate limited: ${url}`);
      return null;
    }
    
    if (!res.ok) {
      return null;
    }
    
    return await res.json() as T;
  } catch (e) {
    console.error(`Fetch error:`, e);
    return null;
  }
}

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

export interface PatternResult {
  name: string;
  type: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  description: string;
}

export interface ChannelResult {
  type: 'ascending' | 'descending' | 'horizontal' | 'none';
  breakout: 'above' | 'below' | 'none';
  upper: number;
  lower: number;
}

export interface TechnicalIndicators {
  price: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  
  rsi: number;
  rsiSignal: 'overbought' | 'oversold' | 'neutral';
  rsiTrend: 'rising' | 'falling' | 'flat';
  
  ma5: number;
  ma10: number;
  ma20: number;
  maSignal: 'bullish' | 'bearish' | 'neutral';
  maCrossover: 'golden_cross' | 'death_cross' | 'none';
  priceVsMa: 'above_all' | 'below_all' | 'mixed';
  
  volumeAvg: number;
  volumeLatest: number;
  volumeRatio: number;
  volumeSpike: boolean;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  obv: number;
  obvTrend: 'accumulation' | 'distribution' | 'neutral';
  
  whaleActivity: 'buying' | 'selling' | 'none';
  
  trend: 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';
  trendStrength: number;
  momentum: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish';
  
  patterns: PatternResult[];
  channel: ChannelResult;
  patternSummary: string;
  patternSignal: 'bullish' | 'bearish' | 'neutral';
  
  signal: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  confidence: number;
  
  bullishFactors: string[];
  bearishFactors: string[];
  keyInsight: string;
}

// ============================================================
// DATA FETCHING — WITH CACHE
// ============================================================

async function fetchOHLCV(tokenAddress: string, resolution: string = '5', countback: number = 100): Promise<OHLCV[]> {
  const cacheKey = `${tokenAddress}-${resolution}-${countback}`;
  const cached = getCached(taCache.ohlcv, cacheKey);
  if (cached) return cached;

  try {
    const now = Math.floor(Date.now() / 1000);
    const resSeconds = getResolutionSeconds(resolution);
    const from = now - (countback * resSeconds);
    
    const url = `${API_URL}/agent/chart/${tokenAddress}?resolution=${resolution}&from=${from}&to=${now}&countback=${countback}`;
    const data = await rateLimitedFetch<any>(url);
    
    if (!data || data.s !== 'ok' || !data.t) {
      setCache(taCache.ohlcv, cacheKey, []);
      return [];
    }
    
    const result = data.t.map((t: number, i: number) => ({
      timestamp: t,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i] || 0,
    }));
    
    setCache(taCache.ohlcv, cacheKey, result);
    return result;
  } catch { 
    return []; 
  }
}

async function fetchMetrics(tokenAddress: string): Promise<any[]> {
  const cached = getCached(taCache.metrics, tokenAddress);
  if (cached) return cached;

  try {
    const url = `${API_URL}/agent/metrics/${tokenAddress}?timeframes=1,5,15,60,1440`;
    const data = await rateLimitedFetch<any>(url);
    
    const result = data?.metrics || [];
    setCache(taCache.metrics, tokenAddress, result);
    return result;
  } catch { 
    return []; 
  }
}

async function fetchRecentSwaps(tokenAddress: string, limit: number = 100): Promise<any[]> {
  const cacheKey = `${tokenAddress}-${limit}`;
  const cached = getCached(taCache.swaps, cacheKey);
  if (cached) return cached;

  try {
    const url = `${API_URL}/agent/swap-history/${tokenAddress}?limit=${limit}`;
    const data = await rateLimitedFetch<any>(url);
    
    const result = (data?.swaps || []).map((s: any) => ({
      type: s.swap_info?.event_type === 'BUY' ? 'BUY' : 'SELL',
      nativeAmount: parseFloat(s.swap_info?.native_amount || '0'),
      maker: s.swap_info?.maker || '',
    }));
    
    setCache(taCache.swaps, cacheKey, result);
    return result;
  } catch { 
    return []; 
  }
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
  
  const recent = closes.slice(-5);
  let trend: 'rising' | 'falling' | 'flat' = 'flat';
  if (recent.length >= 3) {
    const diff = recent[recent.length - 1] - recent[0];
    const avgPrice = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (diff / avgPrice > 0.02) trend = 'rising';
    else if (diff / avgPrice < -0.02) trend = 'falling';
  }
  
  return { rsi, trend };
}

function calculateMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
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

function analyzeOrderFlow(swaps: any[]): { whaleActivity: 'buying' | 'selling' | 'none' } {
  const buys = swaps.filter(s => s.type === 'BUY');
  const sells = swaps.filter(s => s.type === 'SELL');
  
  const WHALE = 1;
  const largeBuys = buys.filter(s => s.nativeAmount > WHALE);
  const largeSells = sells.filter(s => s.nativeAmount > WHALE);
  
  const largeBuyVol = largeBuys.reduce((sum: number, s: any) => sum + s.nativeAmount, 0);
  const largeSellVol = largeSells.reduce((sum: number, s: any) => sum + s.nativeAmount, 0);
  
  if (largeBuyVol > largeSellVol * 1.5) return { whaleActivity: 'buying' };
  if (largeSellVol > largeBuyVol * 1.5) return { whaleActivity: 'selling' };
  return { whaleActivity: 'none' };
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

export async function analyzeTechnicals(tokenAddress: string): Promise<TechnicalIndicators | null> {
  try {
    console.log(`📊 Running TA for ${tokenAddress.slice(0, 10)}...`);
    
    // Sequential fetches to avoid rate limiting
    const candles = await fetchOHLCV(tokenAddress, '5', 100);
    
    if (candles.length < 15) {
      console.log(`   Not enough data: ${candles.length} candles`);
      return null;
    }
    
    const metrics = await fetchMetrics(tokenAddress);
    const swaps = await fetchRecentSwaps(tokenAddress, 100);
    
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const currentPrice = closes[closes.length - 1];
    
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
    
    // === Order Flow ===
    const { whaleActivity } = analyzeOrderFlow(swaps);
    
    // === Trend ===
    const recentCloses = closes.slice(-10);
    const olderCloses = closes.slice(-20, -10);
    const recentAvg = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    const olderAvg = olderCloses.length > 0 ? olderCloses.reduce((a, b) => a + b, 0) / olderCloses.length : recentAvg;
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
      (whaleActivity === 'buying' ? 1 : whaleActivity === 'selling' ? -1 : 0);
    
    const momentum: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish' =
      momentumScore >= 3 ? 'strong_bullish' : momentumScore >= 1 ? 'bullish' :
      momentumScore <= -3 ? 'strong_bearish' : momentumScore <= -1 ? 'bearish' : 'neutral';
    
    // === Price changes from metrics ===
    const m5 = metrics.find((m: any) => m.timeframe === '5');
    const m60 = metrics.find((m: any) => m.timeframe === '60');
    const m1440 = metrics.find((m: any) => m.timeframe === '1440');
    
    // === Build factors ===
    const bullishFactors: string[] = [];
    const bearishFactors: string[] = [];
    
    if (rsiSignal === 'oversold') bullishFactors.push(`RSI ${rsi.toFixed(0)} oversold`);
    if (rsiSignal === 'overbought') bearishFactors.push(`RSI ${rsi.toFixed(0)} overbought`);
    if (maCrossover === 'golden_cross') bullishFactors.push('Golden cross');
    if (maCrossover === 'death_cross') bearishFactors.push('Death cross');
    if (volumeSpike && (m60?.percent || 0) > 0) bullishFactors.push(`Volume spike ${volumeRatio.toFixed(1)}x`);
    if (volumeSpike && (m60?.percent || 0) < 0) bearishFactors.push('Volume spike on dump');
    if (obvTrend === 'accumulation') bullishFactors.push('OBV accumulation');
    if (obvTrend === 'distribution') bearishFactors.push('OBV distribution');
    if (whaleActivity === 'buying') bullishFactors.push('Whales buying');
    if (whaleActivity === 'selling') bearishFactors.push('Whales selling');
    
    // === Final signal ===
    const netScore = bullishFactors.length - bearishFactors.length;
    let signal: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    let confidence: number;
    
    if (netScore >= 4) { signal = 'strong_buy'; confidence = Math.min(90, 60 + netScore * 4); }
    else if (netScore >= 2) { signal = 'buy'; confidence = Math.min(75, 50 + netScore * 4); }
    else if (netScore <= -4) { signal = 'strong_sell'; confidence = Math.min(90, 60 + Math.abs(netScore) * 4); }
    else if (netScore <= -2) { signal = 'sell'; confidence = Math.min(75, 50 + Math.abs(netScore) * 4); }
    else { signal = 'hold'; confidence = 40; }
    
    // === Key insight ===
    let keyInsight = '';
    if (netScore > 0 && bullishFactors[0]) {
      keyInsight = bullishFactors[0];
    } else if (netScore < 0 && bearishFactors[0]) {
      keyInsight = bearishFactors[0];
    } else {
      keyInsight = 'Mixed signals - wait for confirmation';
    }
    
    console.log(`   TA complete: ${signal} (${confidence}%), RSI ${rsi.toFixed(0)}`);
    
    return {
      price: currentPrice,
      priceChange5m: m5?.percent || 0,
      priceChange1h: m60?.percent || 0,
      priceChange24h: m1440?.percent || 0,
      
      rsi, rsiSignal, rsiTrend,
      ma5, ma10, ma20, maSignal, maCrossover, priceVsMa,
      
      volumeAvg, volumeLatest, volumeRatio, volumeSpike, volumeTrend, obv, obvTrend,
      whaleActivity,
      
      trend, trendStrength, momentum,
      
      patterns: [],
      channel: { type: 'none', breakout: 'none', upper: 0, lower: 0 },
      patternSummary: 'No patterns detected',
      patternSignal: 'neutral',
      
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

export function clearTACache(): void {
  taCache.ohlcv.clear();
  taCache.metrics.clear();
  taCache.swaps.clear();
}