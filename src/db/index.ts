// ============================================================
// DATABASE SERVICE — Prisma Client
// ============================================================

import { PrismaClient, Prisma } from '@prisma/client';
import type { Message, Trade, BotStats, Token, TokenAnalysis, BotId } from '../types/index.js';

export const prisma = new PrismaClient();

// ============================================================
// MESSAGES
// ============================================================

export async function saveMessage(message: Message): Promise<void> {
  await prisma.message.create({
    data: {
      id: message.id,
      botId: message.botId,
      content: message.content,
      token: message.token,
      txHash: message.txHash,
      messageType: message.messageType,
      createdAt: message.createdAt,
    },
  });
}

export async function getRecentMessages(limit: number = 20): Promise<Message[]> {
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return messages.map((m) => ({
    id: m.id,
    botId: m.botId as BotId | `human_${string}`,
    content: m.content,
    token: m.token ?? undefined,
    txHash: m.txHash ?? undefined,
    messageType: m.messageType as Message['messageType'],
    createdAt: m.createdAt,
  })).reverse();
}

export async function getMessagesByToken(tokenAddress: string, limit: number = 50): Promise<Message[]> {
  const messages = await prisma.message.findMany({
    where: { token: tokenAddress },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return messages.map((m) => ({
    id: m.id,
    botId: m.botId as BotId | `human_${string}`,
    content: m.content,
    token: m.token ?? undefined,
    txHash: m.txHash ?? undefined,
    messageType: m.messageType as Message['messageType'],
    createdAt: m.createdAt,
  })).reverse();
}

// ============================================================
// TRADES
// ============================================================

export async function saveTrade(trade: Trade): Promise<void> {
  await prisma.trade.create({
    data: {
      id: trade.id,
      botId: trade.botId,
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol,
      side: trade.side,
      amountIn: trade.amountIn,
      amountOut: trade.amountOut,
      price: trade.price,
      txHash: trade.txHash,
      status: trade.status,
      pnl: trade.pnl,
      createdAt: trade.createdAt,
    },
  });
}

export async function updateTradeStatus(txHash: string, status: string, pnl?: number): Promise<void> {
  await prisma.trade.updateMany({
    where: { txHash },
    data: { status, pnl },
  });
}

export async function getTradesByBot(botId: string, limit: number = 20): Promise<Trade[]> {
  const trades = await prisma.trade.findMany({
    where: { botId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return trades.map((t) => ({
    id: t.id,
    botId: t.botId as BotId | `human_${string}`,
    tokenAddress: t.tokenAddress,
    tokenSymbol: t.tokenSymbol,
    side: t.side as 'buy' | 'sell',
    amountIn: Number(t.amountIn),
    amountOut: Number(t.amountOut),
    price: Number(t.price),
    txHash: t.txHash,
    status: t.status as Trade['status'],
    pnl: t.pnl ? Number(t.pnl) : undefined,
    createdAt: t.createdAt,
  }));
}

export async function getOpenPositions(botId: string): Promise<Trade[]> {
  const trades = await prisma.trade.findMany({
    where: {
      botId,
      side: 'buy',
      status: 'confirmed',
      pnl: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  return trades.map((t) => ({
    id: t.id,
    botId: t.botId as BotId | `human_${string}`,
    tokenAddress: t.tokenAddress,
    tokenSymbol: t.tokenSymbol,
    side: t.side as 'buy' | 'sell',
    amountIn: Number(t.amountIn),
    amountOut: Number(t.amountOut),
    price: Number(t.price),
    txHash: t.txHash,
    status: t.status as Trade['status'],
    createdAt: t.createdAt,
  }));
}

// ============================================================
// BOT STATS
// ============================================================

export async function getBotStats(botId: string): Promise<BotStats | null> {
  const stats = await prisma.botStats.findUnique({
    where: { botId },
  });

  if (!stats) return null;

  return {
    botId: stats.botId as BotId,
    totalTrades: stats.totalTrades,
    wins: stats.wins,
    losses: stats.losses,
    winRate: Number(stats.winRate),
    totalPnl: Number(stats.totalPnl),
    currentStreak: stats.currentStreak,
    bestStreak: stats.bestStreak,
  };
}

export async function getAllBotStats(): Promise<BotStats[]> {
  const stats = await prisma.botStats.findMany({
    orderBy: { winRate: 'desc' },
  });

  return stats.map((s) => ({
    botId: s.botId as BotId,
    totalTrades: s.totalTrades,
    wins: s.wins,
    losses: s.losses,
    winRate: Number(s.winRate),
    totalPnl: Number(s.totalPnl),
    currentStreak: s.currentStreak,
    bestStreak: s.bestStreak,
  }));
}

export async function updateBotStats(botId: string, isWin: boolean, pnl: number): Promise<void> {
  const stats = await getBotStats(botId);
  if (!stats) return;

  const newWins = isWin ? stats.wins + 1 : stats.wins;
  const newLosses = isWin ? stats.losses : stats.losses + 1;
  const newTotal = stats.totalTrades + 1;
  const newWinRate = newTotal > 0 ? (newWins / newTotal) * 100 : 0;
  const newPnl = stats.totalPnl + pnl;
  const newStreak = isWin ? stats.currentStreak + 1 : 0;
  const newBestStreak = Math.max(stats.bestStreak, newStreak);

  await prisma.botStats.update({
    where: { botId },
    data: {
      totalTrades: newTotal,
      wins: newWins,
      losses: newLosses,
      winRate: newWinRate,
      totalPnl: newPnl,
      currentStreak: newStreak,
      bestStreak: newBestStreak,
    },
  });
}

// ============================================================
// TOKENS
// ============================================================

export async function saveToken(token: Token, analysis?: TokenAnalysis): Promise<void> {
  await prisma.token.upsert({
    where: { address: token.address },
    update: {
      price: token.price,
      mcap: token.mcap,
      liquidity: token.liquidity,
      holders: token.holders,
      verdict: analysis?.verdict,
      riskScore: analysis?.riskScore,
      analysis: analysis as unknown as Prisma.JsonObject,
    },
    create: {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      price: token.price,
      mcap: token.mcap,
      liquidity: token.liquidity,
      holders: token.holders,
      deployer: token.deployer,
      verdict: analysis?.verdict,
      riskScore: analysis?.riskScore,
      analysis: analysis as unknown as Prisma.JsonObject,
      createdAt: token.createdAt,
    },
  });
}

export async function getToken(address: string): Promise<Token | null> {
  const token = await prisma.token.findUnique({
    where: { address },
  });

  if (!token) return null;

  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    price: Number(token.price),
    priceChange24h: 0,
    mcap: Number(token.mcap),
    liquidity: Number(token.liquidity),
    holders: token.holders ?? 0,
    deployer: token.deployer ?? '',
    createdAt: token.createdAt,
  };
}

export async function getAnalyzedTokens(limit: number = 10): Promise<Token[]> {
  const tokens = await prisma.token.findMany({
    where: { verdict: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  return tokens.map((t) => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    price: Number(t.price),
    priceChange24h: 0,
    mcap: Number(t.mcap),
    liquidity: Number(t.liquidity),
    holders: t.holders ?? 0,
    deployer: t.deployer ?? '',
    createdAt: t.createdAt,
  }));
}

// ============================================================
// POSITIONS
// ============================================================

export async function createPosition(data: {
  botId: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  entryPrice: number;
  entryTxHash: string;
}): Promise<void> {
  await prisma.position.create({
    data: {
      botId: data.botId,
      tokenAddress: data.tokenAddress,
      tokenSymbol: data.tokenSymbol,
      amount: data.amount,
      entryPrice: data.entryPrice,
      entryTxHash: data.entryTxHash,
      isOpen: true,
    },
  });
}

export async function closePosition(
  botId: string,
  tokenAddress: string,
  exitPrice: number,
  exitTxHash: string
): Promise<void> {
  const position = await prisma.position.findFirst({
    where: { botId, tokenAddress, isOpen: true },
  });

  if (!position) return;

  const pnl = ((exitPrice - Number(position.entryPrice)) / Number(position.entryPrice)) * 100;

  await prisma.position.update({
    where: { id: position.id },
    data: {
      isOpen: false,
      exitPrice,
      exitTxHash,
      pnl,
      closedAt: new Date(),
    },
  });
}

export async function getOpenPositionsByBot(botId: string) {
  return prisma.position.findMany({
    where: { botId, isOpen: true },
  });
}

// ============================================================
// CLEANUP
// ============================================================

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// ============================================================
// INIT
// ============================================================

export async function initDatabase(): Promise<void> {
  // Prisma handles schema with migrations
  // Just verify connection works
  await prisma.$connect();
  console.log('✅ Database connected via Prisma');
}