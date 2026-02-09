// ============================================================
// TOKEN DATA SERVICE — Single fetch, shared data
// ============================================================
// 
// This service fetches ALL data for a token ONCE at the start
// of analysis, then provides it to all bots/services.
// No more rate limiting issues!

import type { Token } from '../../types/index.js';

// ============================================================
// TYPES
// ============================================================

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwapTrade {
  timestamp: number;
  type: 'buy' | 'sell';
  amountMon: number;
  amountToken: number;
  priceUsd: number;
  wallet: string;
  txHash: string;
}

export interface TokenMetrics {
  price: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume1h: number;
  volume24h: number;
  buys1h: number;
  sells1h: number;
  uniqueBuyers1h: number;
  uniqueSellers1h: number;
}

export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
}

export interface HolderInfo {
  count: number;
  top10Percent: number;
  distribution: 'concentrated' | 'distributed' | 'unknown';
}

export interface TokenFullData {
  // Basic info
  token: Token;
  
  // Price data
  candles: OHLCV[];
  metrics: TokenMetrics | null;
  
  // Trading activity
  recentSwaps: SwapTrade[];
  
  // Social
  socials: TokenSocials | null;
  
  // Holders
  holders: HolderInfo;
  
  // Metadata
  fetchedAt: number;
  fetchDuration: number;
}

// ============================================================
// CONFIG
// ============================================================

const NETWORK = (process.env.MONAD_NETWORK || 'testnet') as 'testnet' | 'mainnet';

const API_CONFIG = {
  testnet: {
    nadFun: 'https://dev-api.nad.fun',
    nadApp: 'https://dev-api.nadapp.net',
  },
  mainnet: {
    nadFun: 'https://api.nad.fun',
    nadApp: 'https://api.nadapp.net',
  },
}[NETWORK];

const API_KEY = process.env.NADFUN_API_KEY || '';
const headers: Record<string, string> = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ============================================================
// CACHE
// ============================================================

const dataCache = new Map<string, TokenFullData>();
const CACHE_TTL = 120_000; // 2 minutes cache

// ============================================================
// RATE LIMIT PROTECTION
// ============================================================

let lastFetchTime = 0;
const MIN_FETCH_INTERVAL = 2000; // 2s minimum between full fetches

async function rateLimitedFetch(url: string, timeout = 8000): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, { 
      headers,
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    
    if (response.status === 429) {
      console.log(`⚠️ Rate limited: ${url.slice(-60)}`);
      return null;
    }
    
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log(`⏱️ Timeout: ${url.slice(-60)}`);
    }
    return null;
  }
}

// ============================================================
// MAIN FETCH FUNCTION — Gets everything in parallel
// ============================================================

export async function fetchTokenFullData(token: Token): Promise<TokenFullData> {
  const startTime = Date.now();
  const cacheKey = token.address.toLowerCase();
  
  // Check cache first
  const cached = dataCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    console.log(`📦 Using cached data for $${token.symbol} (${Math.round((Date.now() - cached.fetchedAt) / 1000)}s old)`);
    return cached;
  }
  
  // Rate limit protection
  const timeSinceLastFetch = Date.now() - lastFetchTime;
  if (timeSinceLastFetch < MIN_FETCH_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_FETCH_INTERVAL - timeSinceLastFetch));
  }
  lastFetchTime = Date.now();
  
  console.log(`🔄 Fetching ALL data for $${token.symbol} in parallel...`);
  
  // Fetch everything in parallel - ONE burst of requests
  const [
    candlesRes,
    metricsRes,
    swapsRes,
    socialsRes,
  ] = await Promise.all([
    // Candles (OHLCV)
    rateLimitedFetch(`${API_CONFIG.nadApp}/agent/market/${token.address}`),
    // Metrics
    rateLimitedFetch(`${API_CONFIG.nadApp}/agent/metrics/${token.address}?timeframes=1,5,15,60,1440`),
    // Recent swaps
    rateLimitedFetch(`${API_CONFIG.nadApp}/agent/swap-history/${token.address}?limit=100`),
    // Socials from nad.fun
    rateLimitedFetch(`${API_CONFIG.nadFun}/token/${token.address}`),
  ]);
  
  // Parse responses
  let candles: OHLCV[] = [];
  let metrics: TokenMetrics | null = null;
  let recentSwaps: SwapTrade[] = [];
  let socials: TokenSocials | null = null;
  let holders: HolderInfo = { count: token.holders || 0, top10Percent: 0, distribution: 'unknown' };
  
  // Parse candles/market data
  if (candlesRes?.ok) {
    try {
      const data = await candlesRes.json();
      if (data.ohlcv && Array.isArray(data.ohlcv)) {
        candles = data.ohlcv.map((c: any) => ({
          time: c.time || c.timestamp || c.t,
          open: parseFloat(c.open || c.o) || 0,
          high: parseFloat(c.high || c.h) || 0,
          low: parseFloat(c.low || c.l) || 0,
          close: parseFloat(c.close || c.c) || 0,
          volume: parseFloat(c.volume || c.v) || 0,
        }));
      }
      // Also extract holder info if available
      if (data.holders) {
        holders.count = data.holders;
      }
    } catch (e) {
      console.log(`⚠️ Failed to parse candles for $${token.symbol}`);
    }
  }
  
  // Parse metrics
  if (metricsRes?.ok) {
    try {
      const data = await metricsRes.json();
      metrics = {
        price: parseFloat(data.price || data.priceUsd) || token.price,
        priceChange1m: parseFloat(data.priceChange1m || data['1m']?.priceChange) || 0,
        priceChange5m: parseFloat(data.priceChange5m || data['5m']?.priceChange) || 0,
        priceChange15m: parseFloat(data.priceChange15m || data['15m']?.priceChange) || 0,
        priceChange1h: parseFloat(data.priceChange1h || data['60m']?.priceChange) || 0,
        priceChange24h: parseFloat(data.priceChange24h || data['1440m']?.priceChange) || 0,
        volume1h: parseFloat(data.volume1h || data['60m']?.volume) || 0,
        volume24h: parseFloat(data.volume24h || data['1440m']?.volume) || 0,
        buys1h: parseInt(data.buys1h || data['60m']?.buys) || 0,
        sells1h: parseInt(data.sells1h || data['60m']?.sells) || 0,
        uniqueBuyers1h: parseInt(data.uniqueBuyers1h || data['60m']?.uniqueBuyers) || 0,
        uniqueSellers1h: parseInt(data.uniqueSellers1h || data['60m']?.uniqueSellers) || 0,
      };
    } catch (e) {
      console.log(`⚠️ Failed to parse metrics for $${token.symbol}`);
    }
  }
  
  // Parse swaps
  if (swapsRes?.ok) {
    try {
      const data = await swapsRes.json();
      const swapArray = data.swaps || data.trades || data || [];
      recentSwaps = swapArray.slice(0, 100).map((s: any) => ({
        timestamp: s.timestamp || s.time || Date.now(),
        type: (s.type || s.side || 'buy').toLowerCase() as 'buy' | 'sell',
        amountMon: parseFloat(s.amountMon || s.monAmount || s.amount0) || 0,
        amountToken: parseFloat(s.amountToken || s.tokenAmount || s.amount1) || 0,
        priceUsd: parseFloat(s.priceUsd || s.price) || 0,
        wallet: s.wallet || s.user || s.address || '',
        txHash: s.txHash || s.hash || '',
      }));
    } catch (e) {
      console.log(`⚠️ Failed to parse swaps for $${token.symbol}`);
    }
  }
  
  // Parse socials
  if (socialsRes?.ok) {
    try {
      const data = await socialsRes.json();
      const tokenInfo = data.token_info || data;
      socials = {
        twitter: tokenInfo.twitter || tokenInfo.twitter_url || undefined,
        telegram: tokenInfo.telegram || tokenInfo.telegram_url || undefined,
        website: tokenInfo.website || tokenInfo.website_url || undefined,
        discord: tokenInfo.discord || tokenInfo.discord_url || undefined,
      };
      // Also update holders if available
      if (data.market_info?.holder_count) {
        holders.count = parseInt(data.market_info.holder_count);
      }
    } catch (e) {
      console.log(`⚠️ Failed to parse socials for $${token.symbol}`);
    }
  }
  
  const fetchDuration = Date.now() - startTime;
  
  const fullData: TokenFullData = {
    token,
    candles,
    metrics,
    recentSwaps,
    socials,
    holders,
    fetchedAt: Date.now(),
    fetchDuration,
  };
  
  // Cache it
  dataCache.set(cacheKey, fullData);
  
  console.log(`✅ Fetched $${token.symbol} data in ${fetchDuration}ms: ${candles.length} candles, ${recentSwaps.length} swaps`);
  
  return fullData;
}

// ============================================================
// HELPER FUNCTIONS — Extract specific data from cached fullData
// ============================================================

export function getCandles(data: TokenFullData): OHLCV[] {
  return data.candles;
}

export function getMetrics(data: TokenFullData): TokenMetrics | null {
  return data.metrics;
}

export function getRecentSwaps(data: TokenFullData): SwapTrade[] {
  return data.recentSwaps;
}

export function getSocials(data: TokenFullData): TokenSocials | null {
  return data.socials;
}

export function getHolders(data: TokenFullData): HolderInfo {
  return data.holders;
}

// ============================================================
// ANALYSIS HELPERS — Compute indicators from cached data
// ============================================================

export function calculateRSI(data: TokenFullData, period = 14): number {
  const candles = data.candles;
  if (candles.length < period + 1) return 50;
  
  const changes = candles.slice(-period - 1).map((c, i, arr) => 
    i === 0 ? 0 : c.close - arr[i - 1].close
  ).slice(1);
  
  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
  
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateVolumeSpike(data: TokenFullData): { isSpike: boolean; ratio: number } {
  const candles = data.candles;
  if (candles.length < 20) return { isSpike: false, ratio: 1 };
  
  const recent = candles.slice(-5);
  const historical = candles.slice(-25, -5);
  
  const recentAvgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const historicalAvgVol = historical.reduce((s, c) => s + c.volume, 0) / historical.length;
  
  const ratio = historicalAvgVol > 0 ? recentAvgVol / historicalAvgVol : 1;
  
  return { isSpike: ratio > 2, ratio };
}

export function detectTrend(data: TokenFullData): 'uptrend' | 'downtrend' | 'sideways' {
  const candles = data.candles;
  if (candles.length < 10) return 'sideways';
  
  const recent = candles.slice(-10);
  const firstPrice = recent[0].close;
  const lastPrice = recent[recent.length - 1].close;
  const change = (lastPrice - firstPrice) / firstPrice;
  
  if (change > 0.05) return 'uptrend';
  if (change < -0.05) return 'downtrend';
  return 'sideways';
}

export function detectWhaleActivity(data: TokenFullData): 'buying' | 'selling' | 'neutral' {
  const swaps = data.recentSwaps.slice(0, 20);
  if (swaps.length < 5) return 'neutral';
  
  // Find large trades (top 10% by size)
  const sortedBySize = [...swaps].sort((a, b) => b.amountMon - a.amountMon);
  const whaleThreshold = sortedBySize[Math.floor(sortedBySize.length * 0.1)]?.amountMon || 0;
  
  const whaleTrades = swaps.filter(s => s.amountMon >= whaleThreshold);
  const whaleBuys = whaleTrades.filter(s => s.type === 'buy').length;
  const whaleSells = whaleTrades.filter(s => s.type === 'sell').length;
  
  if (whaleBuys > whaleSells * 1.5) return 'buying';
  if (whaleSells > whaleBuys * 1.5) return 'selling';
  return 'neutral';
}

export function getBuyPressure(data: TokenFullData): number {
  const swaps = data.recentSwaps.slice(0, 50);
  if (swaps.length === 0) return 50;
  
  const buys = swaps.filter(s => s.type === 'buy');
  const buyVolume = buys.reduce((s, t) => s + t.amountMon, 0);
  const totalVolume = swaps.reduce((s, t) => s + t.amountMon, 0);
  
  return totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
}

// ============================================================
// CLEAR CACHE (for testing)
// ============================================================

export function clearCache(): void {
  dataCache.clear();
  console.log('🗑️ Token data cache cleared');
}