// ============================================================
// NADFUN SERVICE — With cache and rate limiting
// ============================================================

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseEther, 
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

const NETWORK = (process.env.MONAD_NETWORK || 'mainnet') as 'testnet' | 'mainnet';

const CONFIG = {
  testnet: {
    chainId: 10143,
    rpcUrl: 'https://monad-testnet.drpc.org',
    apiUrl: 'https://api.nadapp.net',
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
// CACHE — Avoid rate limiting
// ============================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = {
  market: new Map<string, CacheEntry<MarketInfo | null>>(),
  swaps: new Map<string, CacheEntry<SwapInfo[]>>(),
  price: new Map<string, CacheEntry<number | null>>(),
};

const CACHE_TTL = 60_000; // 60 seconds cache

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
const MIN_API_INTERVAL = 1000; // 1 second between calls
const apiQueue: Array<() => Promise<any>> = [];
let isProcessingQueue = false;

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  while (apiQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCall;
    
    if (timeSinceLastCall < MIN_API_INTERVAL) {
      await new Promise(r => setTimeout(r, MIN_API_INTERVAL - timeSinceLastCall));
    }
    
    const fn = apiQueue.shift();
    if (fn) {
      lastApiCall = Date.now();
      await fn();
    }
  }
  
  isProcessingQueue = false;
}

async function rateLimitedFetch<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    apiQueue.push(async () => {
      try {
        const res = await fetch(url, { headers });
        
        if (res.status === 429) {
          console.error(`Rate limited: ${url}`);
          resolve(null);
          return;
        }
        
        if (!res.ok) {
          console.error(`API error ${url}: ${res.status}`);
          resolve(null);
          return;
        }
        
        const data = await res.json();
        resolve(data as T);
      } catch (e) {
        console.error(`Fetch error ${url}:`, e);
        resolve(null);
      }
    });
    processQueue();
  });
}

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
// ABIs
// ============================================================

export const routerAbi = [
  {
    name: 'buy',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'amountOutMin', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'sell',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMin', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
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
// MARKET DATA — WITH CACHE
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
  // Check cache first
  const cached = getCached(cache.market, tokenAddress);
  if (cached !== undefined) {
    return cached;
  }

  const data = await rateLimitedFetch<{ market_info: any }>(`${CONFIG.apiUrl}/agent/market/${tokenAddress}`);
  
  if (!data?.market_info) {
    setCache(cache.market, tokenAddress, null);
    return null;
  }

  const m = data.market_info;
  const result: MarketInfo = {
    price: parseFloat(m.price || '0'),
    priceUsd: parseFloat(m.price_usd || '0'),
    mcap: parseFloat(m.market_cap || '0'),
    liquidity: parseFloat(m.liquidity || '0'),
    holders: m.holder_count || 0,
    volume24h: parseFloat(m.volume_24h || '0'),
    isGraduated: m.market_type === 'DEX',
    athPrice: parseFloat(m.ath_price || '0'),
  };
  
  setCache(cache.market, tokenAddress, result);
  return result;
}

// ============================================================
// TOKEN PRICE — WITH CACHE
// ============================================================

export async function getTokenPrice(tokenAddress: string): Promise<number | null> {
  const cached = getCached(cache.price, tokenAddress);
  if (cached !== undefined) return cached;

  const marketData = await getMarketData(tokenAddress);
  const price = marketData?.price || null;
  setCache(cache.price, tokenAddress, price);
  return price;
}

// ============================================================
// SWAP HISTORY — WITH CACHE
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
  const cacheKey = `${tokenAddress}-${limit}-${tradeType}`;
  const cached = getCached(cache.swaps, cacheKey);
  if (cached !== undefined) return cached;

  const data = await rateLimitedFetch<{ swaps: any[] }>(
    `${CONFIG.apiUrl}/agent/swap-history/${tokenAddress}?limit=${limit}&trade_type=${tradeType}`
  );

  if (!data?.swaps) {
    setCache(cache.swaps, cacheKey, []);
    return [];
  }

  const result = data.swaps.map((s: any) => ({
    eventType: s.swap_info?.event_type || 'BUY',
    nativeAmount: s.swap_info?.native_amount || '0',
    tokenAmount: s.swap_info?.token_amount || '0',
    txHash: s.swap_info?.transaction_hash || '',
    sender: s.swap_info?.sender || '',
    timestamp: s.swap_info?.timestamp || 0,
  }));
  
  setCache(cache.swaps, cacheKey, result);
  return result;
}

// ============================================================
// CALCULATE RISK SCORE
// ============================================================

export async function calculateRiskScore(token: Token): Promise<{ score: number; flags: string[] }> {
  const flags: string[] = [];
  let score = 50;

  try {
    const marketData = await getMarketData(token.address);
    const swapHistory = await getSwapHistory(token.address, 50);

    if (marketData) {
      const liqRatio = marketData.liquidity / (marketData.mcap || 1);
      if (liqRatio < 0.05) {
        flags.push('Very low liquidity');
        score += 20;
      } else if (liqRatio < 0.15) {
        flags.push('Low liquidity');
        score += 10;
      } else if (liqRatio > 0.3) {
        score -= 10;
      }
    }

    if (token.holders < 10) {
      flags.push(`Only ${token.holders} holders`);
      score += 25;
    } else if (token.holders < 50) {
      flags.push(`${token.holders} holders`);
      score += 15;
    } else if (token.holders > 500) {
      score -= 10;
    }

    if (swapHistory.length > 0) {
      const buyCount = swapHistory.filter(s => s.eventType === 'BUY').length;
      const sellCount = swapHistory.filter(s => s.eventType === 'SELL').length;
      
      if (sellCount > buyCount * 2) {
        flags.push('High sell pressure');
        score += 15;
      }
    }

    const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
    if (ageHours < 1) {
      flags.push('Very new (<1h)');
      score += 15;
    } else if (ageHours < 6) {
      flags.push('New (<6h)');
      score += 10;
    }

    if (token.priceChange24h < -50) {
      flags.push('Major dump');
      score += 20;
    } else if (token.priceChange24h < -30) {
      flags.push('Significant drop');
      score += 10;
    }

  } catch (error) {
    console.error('Risk calc error:', error);
    flags.push('Data incomplete');
    score += 10;
  }

  return { score: Math.max(0, Math.min(100, score)), flags };
}

// ============================================================
// NEW TOKENS
// ============================================================

export async function getNewTokens(limit: number = 10): Promise<Token[]> {
  try {
    const data = await rateLimitedFetch<{ tokens: any[] }>(
      `${CONFIG.apiUrl}/order/market_cap?page=1&limit=${limit}&direction=DESC&is_nsfw=false`
    );
    
    if (!data?.tokens) return [];
    
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
      
      tokens.push({
        address,
        symbol: t.symbol || 'UNKNOWN',
        name: t.name || 'Unknown',
        price: priceUsd,
        priceChange24h: item.percent || 0,
        mcap,
        liquidity,
        holders: m?.holder_count || 0,
        deployer: t.creator?.account_id || '',
        createdAt: new Date((t.created_at || 0) * 1000),
      });
      
      if (tokens.length >= limit) break;
    }
    
    return tokens;
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return [];
  }
}

// ============================================================
// TRADING FUNCTIONS
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
    return { router: result[0] as `0x${string}`, amountOut: result[1] };
  } catch (error) {
    console.error('Quote error:', error);
    return null;
  }
}

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
    if (!quote) throw new Error('No quote');

    const amountOutMin = (quote.amountOut * (10000n - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const callData = encodeFunctionData({
      abi: routerAbi,
      functionName: 'buy',
      args: [{ amountOutMin, token: tokenAddress, to: account.address, deadline }],
    });

    const hash = await walletClient.sendTransaction({
      account,
      to: quote.router,
      data: callData,
      value: amountIn,
      chain,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') throw new Error('Reverted');

    return { txHash: hash, amountOut: quote.amountOut };
  } catch (error) {
    console.error('Buy error:', error);
    return null;
  }
}

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
    if (!quote) throw new Error('No quote');

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
      args: [{ amountIn: amountTokens, amountOutMin, token: tokenAddress, to: account.address, deadline }],
    });

    const hash = await walletClient.sendTransaction({
      account,
      to: quote.router,
      data: callData,
      chain,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') throw new Error('Reverted');

    return { txHash: hash, amountOut: quote.amountOut };
  } catch (error) {
    console.error('Sell error:', error);
    return null;
  }
}

// ============================================================
// HELPERS
// ============================================================

export function createBotWalletClient(privateKey: `0x${string}`): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain, transport: http(CONFIG.rpcUrl) });
}

export async function getWalletBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.getBalance({ address });
}

export async function getTokenBalance(tokenAddress: `0x${string}`, walletAddress: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}

export function clearCache(): void {
  cache.market.clear();
  cache.swaps.clear();
  cache.price.clear();
}