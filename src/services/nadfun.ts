// ============================================================
// NADFUN SERVICE — Token data and swaps using nad.fun API + viem
// ============================================================

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseEther, 
  formatEther,
  encodeFunctionData,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Token } from '../types/index.js';

// ============================================================
// CONFIG
// ============================================================

const NETWORK = (process.env.MONAD_NETWORK || 'testnet') as 'testnet' | 'mainnet';

const CONFIG = {
  testnet: {
    chainId: 10143,
    rpcUrl: 'https://monad-testnet.drpc.org',
    apiUrl: 'https://dev-api.nad.fun',
    BONDING_CURVE_ROUTER: '0x865054F0F6A288adaAc30261731361EA7E908003' as `0x${string}`,
    DEX_ROUTER: '0x5D4a4f430cA3B1b2dB86B9cFE48a5316800F5fb2' as `0x${string}`,
    LENS: '0xB056d79CA5257589692699a46623F901a3BB76f1' as `0x${string}`,
    CURVE: '0x1228b0dc9481C11D3071E7A924B794CfB038994e' as `0x${string}`,
    WMON: '0x5a4E0bFDeF88C9032CB4d24338C5EB3d3870BfDd' as `0x${string}`,
  },
  mainnet: {
    chainId: 143,
    rpcUrl: 'https://monad-mainnet.drpc.org',
    apiUrl: 'https://api.nadapp.net',
    BONDING_CURVE_ROUTER: '0x6F6B8F1a20703309951a5127c45B49b1CD981A22' as `0x${string}`,
    DEX_ROUTER: '0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137' as `0x${string}`,
    LENS: '0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea' as `0x${string}`,
    CURVE: '0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE' as `0x${string}`,
    WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as `0x${string}`,
  },
}[NETWORK];

export { CONFIG, NETWORK };

const API_KEY = process.env.NADFUN_API_KEY || '';
const headers: Record<string, string> = API_KEY ? { 'X-API-Key': API_KEY } : {};

// ============================================================
// CHAIN & CLIENTS
// ============================================================

export const chain: Chain = {
  id: CONFIG.chainId,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
};

export const publicClient: PublicClient = createPublicClient({
  chain,
  transport: http(CONFIG.rpcUrl),
});

// ============================================================
// ABIs (minimal)
// ============================================================

export const routerAbi = [
  {
    name: 'buy',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'sell',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const lensAbi = [
  {
    name: 'getAmountOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'isBuy', type: 'bool' },
    ],
    outputs: [
      { name: 'router', type: 'address' },
      { name: 'amountOut', type: 'uint256' },
    ],
  },
] as const;

// ============================================================
// API HELPERS
// ============================================================

async function apiGet<T>(endpoint: string): Promise<T | null> {
  try {
    const url = `${CONFIG.apiUrl}${endpoint}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`API error ${endpoint}: ${res.status}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`API error ${endpoint}:`, e);
    return null;
  }
}

// ============================================================
// TRADING ANALYSIS — Analyze token metrics
// ============================================================

export interface TradingAnalysis {
  liqRatio: number;
  liqHealth: 'healthy' | 'warning' | 'danger';
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  trend: 'bullish' | 'bearish' | 'neutral';
  momentum: 'strong' | 'moderate' | 'weak';
  volumeProfile: 'high' | 'medium' | 'low';
  buyPressure: number;
  bondingStatus: 'bonding' | 'graduated' | 'unknown';
}

export function analyzeTradingData(token: Token): TradingAnalysis {
  const liqRatio = token.mcap > 0 ? token.liquidity / token.mcap : 0;
  
  // Liquidity health
  let liqHealth: 'healthy' | 'warning' | 'danger' = 'warning';
  if (liqRatio > 0.15) liqHealth = 'healthy';
  else if (liqRatio < 0.05) liqHealth = 'danger';
  
  // Risk level
  let riskScore = 0;
  if (liqRatio < 0.05) riskScore += 3;
  else if (liqRatio < 0.1) riskScore += 1;
  if (token.holders < 30) riskScore += 2;
  else if (token.holders < 100) riskScore += 1;
  if (token.priceChange24h < -30) riskScore += 2;
  
  let riskLevel: 'low' | 'medium' | 'high' | 'extreme' = 'medium';
  if (riskScore <= 1) riskLevel = 'low';
  else if (riskScore <= 3) riskLevel = 'medium';
  else if (riskScore <= 5) riskLevel = 'high';
  else riskLevel = 'extreme';
  
  // Trend
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (token.priceChange24h > 10) trend = 'bullish';
  else if (token.priceChange24h < -10) trend = 'bearish';
  
  // Momentum
  let momentum: 'strong' | 'moderate' | 'weak' = 'moderate';
  if (Math.abs(token.priceChange24h) > 30) momentum = 'strong';
  else if (Math.abs(token.priceChange24h) < 5) momentum = 'weak';
  
  // Volume profile
  const totalTrades = (token.buyCount24h || 0) + (token.sellCount24h || 0);
  let volumeProfile: 'high' | 'medium' | 'low' = 'medium';
  if (totalTrades > 100) volumeProfile = 'high';
  else if (totalTrades < 20) volumeProfile = 'low';
  
  // Buy pressure
  const buys = token.buyCount24h || 1;
  const sells = token.sellCount24h || 1;
  const buyPressure = buys / sells;
  
  // Bonding status
  let bondingStatus: 'bonding' | 'graduated' | 'unknown' = 'unknown';
  if (token.bondingProgress !== undefined) {
    bondingStatus = token.bondingProgress >= 100 ? 'graduated' : 'bonding';
  }
  
  return {
    liqRatio,
    liqHealth,
    riskLevel,
    trend,
    momentum,
    volumeProfile,
    buyPressure,
    bondingStatus,
  };
}

// ============================================================
// MARKET DATA (via API)
// ============================================================

export interface MarketInfo {
  price: number;
  priceUsd: number;
  mcap: number;
  liquidity: number;
  holders: number;
  volume24h: number;
  isGraduated: boolean;
  athPrice: number;
}

export async function getMarketData(tokenAddress: string): Promise<MarketInfo | null> {
  const data = await apiGet<{ market_info: any }>(`/agent/market/${tokenAddress}`);
  if (!data?.market_info) return null;

  const m = data.market_info;
  return {
    price: parseFloat(m.price || '0'),
    priceUsd: parseFloat(m.price_usd || '0'),
    mcap: parseFloat(m.market_cap || '0'),
    liquidity: parseFloat(m.liquidity || '0'),
    holders: m.holder_count || 0,
    volume24h: parseFloat(m.volume_24h || '0'),
    isGraduated: m.market_type === 'DEX',
    athPrice: parseFloat(m.ath_price || '0'),
  };
}

// ============================================================
// SWAP HISTORY (via API)
// ============================================================

export interface SwapInfo {
  eventType: 'BUY' | 'SELL';
  nativeAmount: string;
  tokenAmount: string;
  txHash: string;
  sender: string;
  timestamp: number;
}

export async function getSwapHistory(
  tokenAddress: string,
  limit: number = 20,
  tradeType: 'BUY' | 'SELL' | 'ALL' = 'ALL'
): Promise<SwapInfo[]> {
  const data = await apiGet<{ swaps: any[]; total_count: number }>(
    `/agent/swap-history/${tokenAddress}?limit=${limit}&trade_type=${tradeType}`
  );

  if (!data?.swaps) return [];

  return data.swaps.map((s: any) => ({
    eventType: s.swap_info?.event_type || 'BUY',
    nativeAmount: s.swap_info?.native_amount || '0',
    tokenAmount: s.swap_info?.token_amount || '0',
    txHash: s.swap_info?.transaction_hash || '',
    sender: s.swap_info?.sender || '',
    timestamp: s.swap_info?.timestamp || 0,
  }));
}

// ============================================================
// ENRICH TOKEN — Fetch additional data from API
// ============================================================

export async function enrichTokenData(token: Token): Promise<Token> {
  try {
    const [marketData, swapHistory] = await Promise.all([
      getMarketData(token.address),
      getSwapHistory(token.address, 50),
    ]);
    
    if (marketData) {
      token.athPrice = marketData.athPrice;
      token.volume24h = marketData.volume24h;
      // Update with fresh data
      if (marketData.mcap > 0) token.mcap = marketData.mcap;
      if (marketData.liquidity > 0) token.liquidity = marketData.liquidity;
      if (marketData.holders > 0) token.holders = marketData.holders;
    }
    
    if (swapHistory.length > 0) {
      token.buyCount24h = swapHistory.filter(s => s.eventType === 'BUY').length;
      token.sellCount24h = swapHistory.filter(s => s.eventType === 'SELL').length;
    }
    
    return token;
  } catch (error) {
    console.error('Error enriching token:', error);
    return token;
  }
}

// ============================================================
// GET TOKEN INFO (via API)
// ============================================================

export async function getTokenInfo(tokenAddress: string): Promise<Token | null> {
  try {
    const [tokenData, marketData] = await Promise.all([
      apiGet<{ token_info: any }>(`/agent/token/${tokenAddress}`),
      getMarketData(tokenAddress),
    ]);

    if (!tokenData?.token_info) return null;

    const t = tokenData.token_info;
    return {
      address: tokenAddress,
      symbol: t.symbol || 'UNKNOWN',
      name: t.name || 'Unknown',
      price: marketData?.priceUsd || 0,
      priceChange24h: 0,
      mcap: marketData?.mcap || 0,
      liquidity: marketData?.liquidity || 0,
      holders: marketData?.holders || 0,
      deployer: t.creator || '',
      createdAt: new Date(t.created_at || Date.now()),
    };
  } catch (error) {
    console.error('Error getting token info:', error);
    return null;
  }
}

// ============================================================
// CHART DATA (OHLCV via API)
// ============================================================

export interface OHLCV {
  t: number[];  // timestamps
  o: number[];  // open
  h: number[];  // high
  l: number[];  // low
  c: number[];  // close
  v: number[];  // volume
  s: string;    // status
}

export async function getChartData(
  tokenAddress: string,
  resolution: '1' | '5' | '15' | '30' | '60' | '240' | '1D' = '60',
  from?: number,
  to?: number
): Promise<OHLCV | null> {
  const now = Math.floor(Date.now() / 1000);
  const fromTs = from || now - 86400; // Default: last 24h
  const toTs = to || now;

  return apiGet<OHLCV>(
    `/agent/chart/${tokenAddress}?resolution=${resolution}&from=${fromTs}&to=${toTs}`
  );
}

// ============================================================
// CALCULATE RISK SCORE (via API data)
// ============================================================

export async function calculateRiskScore(token: Token): Promise<{
  score: number;
  flags: string[];
}> {
  const flags: string[] = [];
  let score = 50; // Start neutral

  try {
    // Get additional data from API
    const [marketData, swapHistory] = await Promise.all([
      getMarketData(token.address),
      getSwapHistory(token.address, 50),
    ]);

    // Check liquidity ratio
    if (marketData) {
      const liqRatio = marketData.liquidity / (marketData.mcap || 1);
      if (liqRatio < 0.05) {
        flags.push('Very low liquidity ratio');
        score += 20;
      } else if (liqRatio < 0.15) {
        flags.push('Low liquidity ratio');
        score += 10;
      } else if (liqRatio > 0.3) {
        score -= 10; // Good liquidity
      }
    }

    // Check holder count
    if (token.holders < 10) {
      flags.push(`Very few holders (${token.holders})`);
      score += 25;
    } else if (token.holders < 50) {
      flags.push(`Only ${token.holders} holders`);
      score += 15;
    } else if (token.holders > 500) {
      score -= 10; // Good distribution
    }

    // Check swap history for suspicious patterns
    if (swapHistory.length > 0) {
      const buyCount = swapHistory.filter(s => s.eventType === 'BUY').length;
      const sellCount = swapHistory.filter(s => s.eventType === 'SELL').length;
      
      if (sellCount > buyCount * 2) {
        flags.push('High sell pressure');
        score += 15;
      }
      
      // Check for whale activity
      const largeTrades = swapHistory.filter(s => {
        const amount = parseFloat(s.nativeAmount);
        return amount > 10; // > 10 MON
      });
      if (largeTrades.length > swapHistory.length * 0.3) {
        flags.push('Whale activity detected');
        score += 10;
      }
    }

    // Check token age
    const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 1) {
      flags.push('Very new token (<1h)');
      score += 15;
    } else if (ageHours < 6) {
      flags.push('New token (<6h)');
      score += 10;
    } else if (ageHours < 24) {
      flags.push('Recent token (<24h)');
      score += 5;
    }

    // Check price change
    if (token.priceChange24h < -50) {
      flags.push('Major price dump (-50%+)');
      score += 20;
    } else if (token.priceChange24h < -30) {
      flags.push('Significant price drop');
      score += 10;
    }

  } catch (error) {
    console.error('Error calculating risk score:', error);
    flags.push('Unable to fetch complete data');
    score += 10;
  }

  // Clamp score between 0-100
  score = Math.max(0, Math.min(100, score));

  return { score, flags };
}

// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

export interface TechnicalIndicators {
  rsi: number;                    // 0-100
  rsiSignal: 'oversold' | 'neutral' | 'overbought';
  sma20: number;
  sma50: number;
  priceVsSma20: number;           // % above/below
  trend: 'uptrend' | 'downtrend' | 'sideways';
  support: number;
  resistance: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  pattern: string;                // "breakout", "consolidation", "dump", etc.
  momentum: 'strong_bull' | 'weak_bull' | 'neutral' | 'weak_bear' | 'strong_bear';
}

export async function getTechnicalAnalysis(tokenAddress: string): Promise<TechnicalIndicators | null> {
  // Fetch 1h candles for last 24h
  const chartData = await getChartData(tokenAddress, '60');
  if (!chartData || chartData.c.length < 10) return null;
  
  const closes = chartData.c;
  const volumes = chartData.v;
  const highs = chartData.h;
  const lows = chartData.l;
  
  // Calculate RSI (14 periods)
  const rsi = calculateRSI(closes, 14);
  
  // Calculate SMAs
  const sma20 = calculateSMA(closes, Math.min(20, closes.length));
  const sma50 = calculateSMA(closes, Math.min(50, closes.length));
  
  const currentPrice = closes[closes.length - 1];
  const priceVsSma20 = ((currentPrice - sma20) / sma20) * 100;
  
  // Determine trend
  let trend: 'uptrend' | 'downtrend' | 'sideways' = 'sideways';
  if (currentPrice > sma20 && sma20 > sma50) trend = 'uptrend';
  else if (currentPrice < sma20 && sma20 < sma50) trend = 'downtrend';
  
  // Find support/resistance
  const support = Math.min(...lows.slice(-10));
  const resistance = Math.max(...highs.slice(-10));
  
  // Volume trend
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const olderVol = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
  let volumeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (recentVol > olderVol * 1.3) volumeTrend = 'increasing';
  else if (recentVol < olderVol * 0.7) volumeTrend = 'decreasing';
  
  // Detect pattern
  const pattern = detectPattern(closes, highs, lows, volumes);
  
  // Momentum
  const momentum = getMomentum(rsi, trend, priceVsSma20);
  
  return {
    rsi,
    rsiSignal: rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral',
    sma20,
    sma50,
    priceVsSma20,
    trend,
    support,
    resistance,
    volumeTrend,
    pattern,
    momentum,
  };
}

function calculateRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateSMA(data: number[], period: number): number {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function detectPattern(closes: number[], highs: number[], lows: number[], volumes: number[]): string {
  const len = closes.length;
  if (len < 5) return 'insufficient_data';
  
  const recent = closes.slice(-5);
  const recentHigh = Math.max(...recent);
  const recentLow = Math.min(...recent);
  const range = (recentHigh - recentLow) / recentLow * 100;
  
  const currentPrice = closes[len - 1];
  const priceChange = (currentPrice - closes[len - 5]) / closes[len - 5] * 100;
  
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0);
  const olderVol = volumes.slice(-6, -3).reduce((a, b) => a + b, 0);
  const volSpike = recentVol > olderVol * 2;
  
  // Detect patterns
  if (priceChange > 30 && volSpike) return 'pump';
  if (priceChange < -30 && volSpike) return 'dump';
  if (range < 5) return 'consolidation';
  if (currentPrice >= recentHigh * 0.98 && volSpike) return 'breakout';
  if (currentPrice <= recentLow * 1.02 && volSpike) return 'breakdown';
  if (priceChange > 10) return 'rally';
  if (priceChange < -10) return 'selloff';
  
  return 'ranging';
}

function getMomentum(rsi: number, trend: string, priceVsSma: number): string {
  if (rsi > 70 && trend === 'uptrend' && priceVsSma > 10) return 'strong_bull';
  if (rsi > 50 && trend === 'uptrend') return 'weak_bull';
  if (rsi < 30 && trend === 'downtrend' && priceVsSma < -10) return 'strong_bear';
  if (rsi < 50 && trend === 'downtrend') return 'weak_bear';
  return 'neutral';
}

// ============================================================
// NEW TOKENS (via API)
// ============================================================

export async function getNewTokens(limit: number = 10): Promise<Token[]> {
  try {
    console.log(`🔍 Fetching new tokens from nad.fun API...`);
    
    const url = `${CONFIG.apiUrl}/order/market_cap?page=1&limit=${limit * 3}&is_nsfw=false`;
    console.log(`📡 GET ${url}`);
    
    const res = await fetch(url, { headers });
    
    if (!res.ok) {
      console.error(`API error: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    
    if (!data?.tokens || data.tokens.length === 0) {
      console.log('📭 No tokens returned from API');
      return [];
    }
    
    console.log(`📊 Found ${data.tokens.length} tokens`);
    
    const tokens: Token[] = [];
    
    for (const item of data.tokens) {
      const t = item.token_info;
      const m = item.market_info;
      
      const address = t?.token_id;
      if (!address) continue;
      
      const priceUsd = parseFloat(m?.price_usd || '0');
      const totalSupply = parseFloat(m?.total_supply || '0') / 1e18;
      const mcap = priceUsd * totalSupply;
      
      const reserveNative = parseFloat(m?.reserve_native || '0') / 1e18;
      const nativePrice = parseFloat(m?.native_price || '0');
      const liquidity = reserveNative * nativePrice * 2;
      
      const holders = m?.holder_count || 0;
      
      console.log(`✅ $${t.symbol} - MCap: $${(mcap/1000).toFixed(1)}K, Holders: ${holders}`);
      
      tokens.push({
        address,
        symbol: t.symbol || 'UNKNOWN',
        name: t.name || 'Unknown Token',
        price: priceUsd,
        priceChange24h: item.percent || 0,
        mcap,
        liquidity,
        holders,
        deployer: t.creator?.account_id || '',
        createdAt: new Date((t.created_at || 0) * 1000),
      });
      
      if (tokens.length >= limit) break;
    }
    
    console.log(`🎯 Returning ${tokens.length} tokens`);
    return tokens;
  } catch (error) {
    console.error('Error fetching new tokens:', error);
    return [];
  }
}

// ============================================================
// QUOTE (on-chain)
// ============================================================

export async function getQuote(
  tokenAddress: `0x${string}`,
  amountIn: bigint,
  isBuy: boolean
): Promise<{ router: `0x${string}`; amountOut: bigint } | null> {
  try {
    const result = await publicClient.readContract({
      address: CONFIG.LENS,
      abi: lensAbi,
      functionName: 'getAmountOut',
      args: [tokenAddress, amountIn, isBuy],
    });

    return {
      router: result[0] as `0x${string}`,
      amountOut: result[1],
    };
  } catch (error) {
    console.error('Error getting quote:', error);
    return null;
  }
}

// ============================================================
// BUY TOKEN
// ============================================================

export async function buyToken(
  walletClient: WalletClient,
  tokenAddress: `0x${string}`,
  amountMON: string,
  slippageBps: bigint = 100n
): Promise<{ txHash: `0x${string}`; amountOut: bigint } | null> {
  try {
    const account = walletClient.account;
    if (!account) throw new Error('No account');

    const amountIn = parseEther(amountMON);
    const quote = await getQuote(tokenAddress, amountIn, true);
    if (!quote) throw new Error('Failed to get quote');

    const amountOutMin = (quote.amountOut * (10000n - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const callData = encodeFunctionData({
      abi: routerAbi,
      functionName: 'buy',
      args: [{
        amountOutMin,
        token: tokenAddress,
        to: account.address,
        deadline,
      }],
    });

    const hash = await walletClient.sendTransaction({
      account,
      to: quote.router,
      data: callData,
      value: amountIn,
      chain,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted');
    }

    return { txHash: hash, amountOut: quote.amountOut };
  } catch (error) {
    console.error('Error buying token:', error);
    return null;
  }
}

// ============================================================
// SELL TOKEN
// ============================================================

export async function sellToken(
  walletClient: WalletClient,
  tokenAddress: `0x${string}`,
  amountTokens: bigint,
  slippageBps: bigint = 100n
): Promise<{ txHash: `0x${string}`; amountOut: bigint } | null> {
  try {
    const account = walletClient.account;
    if (!account) throw new Error('No account');

    const quote = await getQuote(tokenAddress, amountTokens, false);
    if (!quote) throw new Error('Failed to get quote');

    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, quote.router],
    });

    if (allowance < amountTokens) {
      const approveHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [quote.router, amountTokens],
        account,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const amountOutMin = (quote.amountOut * (10000n - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const callData = encodeFunctionData({
      abi: routerAbi,
      functionName: 'sell',
      args: [{
        amountIn: amountTokens,
        amountOutMin,
        token: tokenAddress,
        to: account.address,
        deadline,
      }],
    });

    const hash = await walletClient.sendTransaction({
      account,
      to: quote.router,
      data: callData,
      chain,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted');
    }

    return { txHash: hash, amountOut: quote.amountOut };
  } catch (error) {
    console.error('Error selling token:', error);
    return null;
  }
}

// ============================================================
// HELPERS
// ============================================================

export function createBotWalletClient(privateKey: `0x${string}`): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain,
    transport: http(CONFIG.rpcUrl),
  });
}

export async function getWalletBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.getBalance({ address });
}

export async function getTokenBalance(
  tokenAddress: `0x${string}`,
  walletAddress: `0x${string}`
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}