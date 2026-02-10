// ============================================================
// TYPES — The Council Backend
// ============================================================

export type BotId = 'sensei' | 'quantum' | 'chad' | 'sterling' | 'oracle';

export interface Bot {
  id: BotId;
  name: string;
  emoji: string;
  wallet: string;
  privateKey: string;
  personality: string;
}

export interface Token {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  mcap: number;
  liquidity: number;
  holders: number;
  createdAt: Date;
  deployer: string;
  // Enhanced trading data
  athPrice?: number;          // All-time high
  athDate?: Date;             // When ATH happened
  atlPrice?: number;          // All-time low  
  volume24h?: number;         // 24h volume
  volumeChange?: number;      // Volume change %
  buyCount24h?: number;       // Number of buys in 24h
  sellCount24h?: number;      // Number of sells in 24h
  topHolderPercent?: number;  // % held by top wallet
  isGraduated?: boolean;      // Has it graduated from bonding curve?
  bondingProgress?: number;   // 0-100% bonding curve progress
}

export interface TokenAnalysis {
  tokenAddress: string;
  riskScore: number;
  flags: string[];
  verdict: 'buy' | 'pass' | 'watch';
  opinions: Record<BotId, string>;
}

export interface Message {
  id: string;
  botId: BotId | `human_${string}`;
  content: string;
  token?: string;
  txHash?: string;
  messageType: 'chat' | 'trade' | 'verdict' | 'reaction' | 'system';
  createdAt: Date;
}

export interface Trade {
  id: string;
  botId: BotId | `human_${string}`;
  tokenAddress: string;
  tokenSymbol: string;
  side: 'buy' | 'sell';
  amountIn: number;
  amountOut: number;
  price: number;
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  pnl?: number;
  createdAt: Date;
}

export interface BotStats {
  botId: BotId;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  currentStreak: number;
  bestStreak: number;
}

export interface Position {
  botId: BotId;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}



export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: Date;
}



export interface BotEvent {
  type: BotEventType;
  data: unknown;
  targetBot?: BotId; // If specific bot should react, otherwise all may react
}

// Nadfun API types
export interface NadfunToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  price: string;
  marketCap: string;
  liquidity: string;
  holders: number;
  createdAt: string;
  deployer: string;
}

export interface NadfunSwapQuote {
  amountIn: string;
  amountOut: string;
  priceImpact: number;
  route: string[];
}

// Chat context for Grok
export interface ChatContext {
  currentToken: Token | null;
  recentMessages: Message[];
  positions: Position[];
  event: BotEvent;
}

// ============================================================
// TYPES — Shared types for frontend
// ============================================================


export interface Token {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  mcap: number;
  liquidity: number;
  holders: number;
  deployer: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  botId: BotId | `human_${string}`;
  content: string;
  token?: string;
  messageType: 'chat' | 'trade' | 'verdict' | 'reaction' | 'system';
  createdAt: Date;
}

export interface Trade {
  id: string;
  botId: BotId | `human_${string}`;
  tokenAddress: string;
  tokenSymbol: string;
  side: 'buy' | 'sell';
  amountIn: number;
  amountOut: number;
  price: number;
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  pnl?: number;
  createdAt: Date;
}

// ============================================================
// POSITIONS — Bot holdings with live PnL
// ============================================================

export interface BotPosition {
  id: string;
  botId: BotId | `human_${string}`;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  totalInvested: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  isOpen: boolean;
  createdAt: Date;
}

export interface BotPortfolio {
  botId: BotId | `human_${string}`;
  name: string;
  positions: BotPosition[];
  totalInvested: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPercent: number;
  openPositions: number;
}

// ============================================================
// STATS
// ============================================================

export interface BotStats {
  botId: BotId;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  currentStreak: number;
  bestStreak: number;
}

export interface Verdict {
  token: Token;
  verdict: 'buy' | 'pass' | 'watch';
  opinions: Record<BotId, string>;
  timestamp: Date;
}

export interface WebSocketEvent {
  type: 'connected' | 'new_token' | 'message' | 'trade' | 'verdict' | 'positions_update';
  data: unknown;
  timestamp: string;
}

// ============================================================
// TYPES — The Council Backend
// ============================================================


export interface Bot {
  id: BotId;
  name: string;
  emoji: string;
  wallet: string;
  privateKey: string;
  personality: string;
}

export interface Token {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  mcap: number;
  liquidity: number;
  holders: number;
  createdAt: Date;
  deployer: string;
  image_uri: string | null;
}

export interface TokenAnalysis {
  tokenAddress: string;
  riskScore: number;
  flags: string[];
  verdict: 'buy' | 'pass' | 'watch';
  opinions: Record<BotId, string>;
}

export interface Message {
  id: string;
  botId: BotId | `human_${string}`;
  content: string;
  token?: string;
  txHash?: string;
  messageType: 'chat' | 'trade' | 'verdict' | 'reaction' | 'system';
  createdAt: Date;
}

export interface Trade {
  id: string;
  botId: BotId | `human_${string}`;
  tokenAddress: string;
  tokenSymbol: string;
  side: 'buy' | 'sell';
  amountIn: number;
  amountOut: number;
  price: number;
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  pnl?: number;
  createdAt: Date;
}

export interface BotStats {
  botId: BotId;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  currentStreak: number;
  bestStreak: number;
}

export interface Position {
  botId: BotId;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

// WebSocket Events
export type WSEventType = 
  | 'message'
  | 'trade'
  | 'new_token'
  | 'price_update'
  | 'verdict'
  | 'human_joined'
  | 'human_trade'
  | 'connected'
  | 'pong';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: Date;
}

// Bot Events (triggers for bot reactions)
export type BotEventType =
  | 'new_token'
  | 'bot_trade'
  | 'human_trade'
  | 'price_pump'
  | 'price_dump'
  | 'rug'
  | 'new_message'
  | 'verdict_request';

export interface BotEvent {
  type: BotEventType;
  data: unknown;
  targetBot?: BotId; // If specific bot should react, otherwise all may react
}

// Nadfun API types
export interface NadfunToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  price: string;
  marketCap: string;
  liquidity: string;
  holders: number;
  createdAt: string;
  deployer: string;
}

export interface NadfunSwapQuote {
  amountIn: string;
  amountOut: string;
  priceImpact: number;
  route: string[];
}

// Chat context for Grok
export interface ChatContext {
  currentToken: Token | null;
  recentMessages: Message[];
  positions: Position[];
  event: BotEvent;
}