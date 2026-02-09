// ============================================================
// NADFUN SERVICE — Lazy loading with smart caching
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
    rpcUrl: 'https://rpc.monad.xyz',
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
// SMART CACHE — Avoid refetching same data
// ============================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Cache TTLs
const CACHE_TTL = {
  TOKEN: 5 * 60 * 1000,      // 5 minutes for token details
  PRICE: 60 * 1000,          // 1 minute for prices
  HOLDINGS: 2 * 60 * 1000,   // 2 minutes for wallet holdings
  LIST: 60 * 1000,           // 1 minute for token list
};

// Caches
const tokenCache = new Map<string, CacheEntry<Token>>();
const priceCache = new Map<string, CacheEntry<number>>();
const holdingsCache = new Map<string, CacheEntry<WalletHolding[]>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const entry = cache.get(key.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key.toLowerCase());
    return null;
  }
  return entry.data;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key.toLowerCase(), { data, timestamp: Date.now() });
}

// ============================================================
// RATE LIMITING — Simple delay between calls
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
      console.error(`⚠️ Rate limited: ${url.slice(-50)}`);
      return null;
    }
    
    if (!res.ok) {
      console.error(`API error ${res.status}: ${url.slice(-50)}`);
      return null;
    }
    
    return await res.json() as T;
  } catch (e) {
    console.error(`Fetch error: ${url.slice(-50)}`, e);
    return null;
  }
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
// TOKEN QUEUE — Lazy loading system
// ============================================================

interface TokenStub {
  address: string;
  symbol: string;
  name: string;
  mcap: number;
  liquidity: number;
  holders: number;
  priceChange24h: number;
  createdAt: Date;
  deployer: string;
  price: number;
}

const tokenStubQueue: TokenStub[] = [];
const seenAddresses = new Set<string>();

/**
 * Fetch the LIST of tokens (1 API call)
 */
export async function fetchTokenList(limit: number = 30): Promise<number> {
  console.log(`📋 Fetching token list (${limit} tokens)...`);
  
  const data = await rateLimitedFetch<{ tokens: any[] }>(
    `${CONFIG.apiUrl}/order/market_cap?page=1&limit=${limit}&direction=DESC&is_nsfw=false`
  );
  
  if (!data?.tokens) {
    console.error('Failed to fetch token list');
    return 0;
  }
  
  let added = 0;
  
  for (const item of data.tokens) {
    const t = item.token_info;
    const m = item.market_info;
    
    const address = t?.token_id;
    if (!address) continue;
    
    // Skip if already seen
    if (seenAddresses.has(address.toLowerCase())) continue;
    seenAddresses.add(address.toLowerCase());
    
    // Calculate basic metrics from list data
    const priceUsd = parseFloat(m?.price_usd || '0');
    const totalSupply = parseFloat(m?.total_supply || '0') / 1e18;
    const mcap = priceUsd * totalSupply;
    
    const reserveNative = parseFloat(m?.reserve_native || '0') / 1e18;
    const nativePrice = parseFloat(m?.native_price || '0');
    const liquidity = reserveNative * nativePrice * 2;
    
    // Basic filters - skip obviously bad tokens
    if (mcap < 3000 || mcap > 10_000_000) continue;
    if (liquidity < 300) continue;
    
    const stub: TokenStub = {
      address,
      symbol: t.symbol || 'UNKNOWN',
      name: t.name || 'Unknown',
      mcap,
      liquidity,
      holders: m?.holder_count || 0,
      priceChange24h: item.percent || 0,
      deployer: t.creator?.account_id || '',
      createdAt: new Date((t.created_at || 0) * 1000),
      price: priceUsd,
    };
    
    tokenStubQueue.push(stub);
    
    // Also cache this data so we don't refetch later
    const token: Token = {
      address: stub.address,
      symbol: stub.symbol,
      name: stub.name,
      price: stub.price,
      priceChange24h: stub.priceChange24h,
      mcap: stub.mcap,
      liquidity: stub.liquidity,
      holders: stub.holders,
      deployer: stub.deployer,
      createdAt: stub.createdAt,
    };
    setCache(tokenCache, address, token);
    setCache(priceCache, address, stub.price);
    
    added++;
  }
  
  console.log(`✅ Added ${added} tokens to queue (total: ${tokenStubQueue.length})`);
  return added;
}

/**
 * Get the next token from queue
 * Uses cache if available, otherwise fetches fresh data
 */
export async function getNextToken(): Promise<Token | null> {
  // If queue is empty, refill it
  if (tokenStubQueue.length === 0) {
    console.log('📋 Queue empty, fetching new token list...');
    const added = await fetchTokenList(30);
    if (added === 0) {
      console.log('No new tokens found');
      return null;
    }
  }
  
  // Get next stub from queue
  const stub = tokenStubQueue.shift();
  if (!stub) return null;
  
  // Check cache first - if we have fresh data, use it
  const cached = getCached(tokenCache, stub.address, CACHE_TTL.TOKEN);
  if (cached) {
    console.log(`📦 Using cached data for $${stub.symbol}`);
    return cached;
  }
  
  console.log(`🔍 Fetching details for $${stub.symbol} (${tokenStubQueue.length} remaining)...`);
  
  // Fetch fresh details
  const freshToken = await fetchTokenDetails(stub.address);
  
  if (freshToken) {
    // Cache the fresh data
    setCache(tokenCache, stub.address, freshToken);
    setCache(priceCache, stub.address, freshToken.price);
    return freshToken;
  }
  
  // Fallback to stub data if fetch failed
  console.log(`⚠️ Using stub data for $${stub.symbol}`);
  const token: Token = {
    address: stub.address,
    symbol: stub.symbol,
    name: stub.name,
    price: stub.price,
    priceChange24h: stub.priceChange24h,
    mcap: stub.mcap,
    liquidity: stub.liquidity,
    holders: stub.holders,
    deployer: stub.deployer,
    createdAt: stub.createdAt,
  };
  
  setCache(tokenCache, stub.address, token);
  return token;
}

/**
 * Fetch FULL details for a single token
 */
async function fetchTokenDetails(address: string): Promise<Token | null> {
  const data = await rateLimitedFetch<{ token_info: any; market_info: any }>(
    `https://api.nad.fun/token/${address}`
  );
  
  if (!data) return null;
  
  const t = data.token_info || {};
  const m = data.market_info || {};
  
  const priceUsd = parseFloat(m.price_usd || m.token_price || '0');
  const totalSupply = parseFloat(m.total_supply || '0') / 1e18;
  const mcap = priceUsd * totalSupply;
  
  const reserveNative = parseFloat(m.reserve_native || '0') / 1e18;
  const nativePrice = parseFloat(m.native_price || '0');
  const liquidity = reserveNative * nativePrice * 2;
  
  return {
    address,
    symbol: t.symbol || 'UNKNOWN',
    name: t.name || 'Unknown',
    price: priceUsd,
    priceChange24h: 0,
    mcap,
    liquidity,
    holders: parseInt(m.holder_count) || 0,
    deployer: t.creator?.account_id || '',
    createdAt: t.created_at ? new Date(t.created_at * 1000) : new Date(),
  };
}

/**
 * Get queue status
 */
export function getQueueStatus(): { remaining: number; seen: number; cached: number } {
  return {
    remaining: tokenStubQueue.length,
    seen: seenAddresses.size,
    cached: tokenCache.size,
  };
}

/**
 * Clear queue and caches
 */
export function clearQueue(): void {
  tokenStubQueue.length = 0;
  seenAddresses.clear();
  tokenCache.clear();
  priceCache.clear();
  holdingsCache.clear();
  console.log('🗑️ Token queue and caches cleared');
}

// ============================================================
// GET TOKEN PRICE — With smart cache
// ============================================================

export async function getTokenPrice(tokenAddress: string): Promise<number | null> {
  // Check price cache first
  const cachedPrice = getCached(priceCache, tokenAddress, CACHE_TTL.PRICE);
  if (cachedPrice !== null) {
    return cachedPrice;
  }
  
  // Check token cache (might have price)
  const cachedToken = getCached(tokenCache, tokenAddress, CACHE_TTL.TOKEN);
  if (cachedToken?.price) {
    setCache(priceCache, tokenAddress, cachedToken.price);
    return cachedToken.price;
  }
  
  // Fetch from API
  try {
    const data = await rateLimitedFetch<{ market_info: any }>(
      `${CONFIG.apiUrl}/agent/market/${tokenAddress}`
    );
    
    if (!data?.market_info) return null;
    
    const price = parseFloat(data.market_info.price_usd || '0');
    setCache(priceCache, tokenAddress, price);
    return price;
  } catch (error) {
    return null;
  }
}

// ============================================================
// GET TOKEN BY ADDRESS — With cache
// ============================================================

export async function getTokenByAddress(address: string): Promise<Token | null> {
  // Check cache first
  const cached = getCached(tokenCache, address, CACHE_TTL.TOKEN);
  if (cached) {
    console.log(`📦 Cache hit for ${address.slice(0, 8)}...`);
    return cached;
  }
  
  // Fetch fresh
  const token = await fetchTokenDetails(address);
  if (token) {
    setCache(tokenCache, address, token);
    setCache(priceCache, address, token.price);
  }
  return token;
}

// ============================================================
// WALLET HOLDINGS — With cache
// ============================================================

export interface WalletHolding {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  amount: number;
  valueUsd: number;
  valueMon: number;
  priceUsd: number;
}

export async function getWalletHoldings(walletAddress: string): Promise<WalletHolding[]> {
  // Check cache first
  const cached = getCached(holdingsCache, walletAddress, CACHE_TTL.HOLDINGS);
  if (cached) {
    console.log(`📦 Cache hit for holdings ${walletAddress.slice(0, 8)}...`);
    return cached;
  }
  
  try {
    const data = await rateLimitedFetch<{ tokens: any[]; total_count: number }>(
      `${CONFIG.apiUrl}/profile/hold-token/${walletAddress}?tableType=hold-tokens-table&page=1&limit=50`
    );
    
    if (!data?.tokens) {
      setCache(holdingsCache, walletAddress, []);
      return [];
    }
    
    const holdings: WalletHolding[] = [];
    
    for (const item of data.tokens) {
      const tokenInfo = item.token_info || {};
      const marketInfo = item.market_info || {};
      const balanceInfo = item.balance_info || {};
      
      // Get balance from balance_info
      const amount = parseFloat(balanceInfo.balance || '0') / 1e18;
      if (amount <= 0) continue;
      
      // Get prices - prefer market_info for current price
      const priceUsd = parseFloat(marketInfo.price_usd || marketInfo.token_price || balanceInfo.token_price || '0');
      const priceMon = parseFloat(marketInfo.price_native || marketInfo.price || '0');
      const nativePrice = parseFloat(balanceInfo.native_price || marketInfo.native_price || '0.5'); // MON price in USD
      
      const valueUsd = amount * priceUsd;
      const valueMon = priceMon > 0 ? amount * priceMon : (nativePrice > 0 ? valueUsd / nativePrice : 0);
      
      holdings.push({
        tokenAddress: tokenInfo.token_id || '',
        tokenSymbol: tokenInfo.symbol || 'UNKNOWN',
        tokenName: tokenInfo.name || 'Unknown',
        amount,
        valueUsd,
        valueMon,
        priceUsd,
        priceMon,
      });
      
      // Also cache the price for this token
      if (tokenInfo.token_id && priceUsd > 0) {
        setCache(priceCache, tokenInfo.token_id, priceUsd);
      }
    }
    
    console.log(`📊 Found ${holdings.length} holdings for ${walletAddress.slice(0, 8)}...`);
    setCache(holdingsCache, walletAddress, holdings);
    return holdings;
  } catch (error) {
    console.error(`Error fetching holdings for ${walletAddress}:`, error);
    return [];
  }
}

// ============================================================
// LEGACY FUNCTION — For backwards compatibility
// ============================================================

export async function getNewTokens(limit: number = 10): Promise<Token[]> {
  // Just fetch the list, don't fetch details
  if (tokenStubQueue.length === 0) {
    await fetchTokenList(limit);
  }
  
  // Return cached tokens (no extra API calls)
  const tokens: Token[] = [];
  const stubs = tokenStubQueue.slice(0, limit);
  
  for (const stub of stubs) {
    // Use cache if available
    const cached = getCached(tokenCache, stub.address, CACHE_TTL.TOKEN);
    if (cached) {
      tokens.push(cached);
    } else {
      tokens.push({
        address: stub.address,
        symbol: stub.symbol,
        name: stub.name,
        price: stub.price,
        priceChange24h: stub.priceChange24h,
        mcap: stub.mcap,
        liquidity: stub.liquidity,
        holders: stub.holders,
        deployer: stub.deployer,
        createdAt: stub.createdAt,
      });
    }
  }
  
  return tokens;
}

// ============================================================
// RISK SCORE — Simplified (no extra API calls)
// ============================================================

export async function calculateRiskScore(token: Token): Promise<{ score: number; flags: string[] }> {
  const flags: string[] = [];
  let score = 50;

  // Liquidity ratio check
  const liqRatio = token.liquidity / (token.mcap || 1);
  if (liqRatio < 0.05) {
    flags.push('Very low liquidity');
    score += 20;
  } else if (liqRatio < 0.15) {
    flags.push('Low liquidity');
    score += 10;
  } else if (liqRatio > 0.3) {
    score -= 10;
  }

  // Holder check
  if (token.holders < 10) {
    flags.push(`Only ${token.holders} holders`);
    score += 25;
  } else if (token.holders < 50) {
    flags.push(`${token.holders} holders`);
    score += 15;
  } else if (token.holders > 500) {
    score -= 10;
  }

  // Age check
  const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
  if (ageHours < 1) {
    flags.push('Very new (<1h)');
    score += 15;
  } else if (ageHours < 6) {
    flags.push('New (<6h)');
    score += 10;
  }

  // Price change check
  if (token.priceChange24h < -50) {
    flags.push('Major dump');
    score += 20;
  } else if (token.priceChange24h < -30) {
    flags.push('Significant drop');
    score += 10;
  }

  return { score: Math.max(0, Math.min(100, score)), flags };
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
  console.log("address", address);
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

// ============================================================
// CACHE STATS — For debugging
// ============================================================

export function getCacheStats(): { tokens: number; prices: number; holdings: number; queue: number } {
  return {
    tokens: tokenCache.size,
    prices: priceCache.size,
    holdings: holdingsCache.size,
    queue: tokenStubQueue.length,
  };
}