// ============================================================
// POSITIONS SERVICE — Track bot holdings and PnL
// ============================================================

import { prisma } from '../db/index.js';
import type { BotId } from '../types/index.js';

// ============================================================
// TYPES
// ============================================================

export interface Position {
  botId: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;          // Token amount held
  avgBuyPrice: number;     // Average buy price in MON
  totalInvested: number;   // Total MON spent
  currentPrice: number;    // Current price
  currentValue: number;    // Current value in MON
  pnl: number;             // Profit/Loss in MON
  pnlPercent: number;      // Profit/Loss %
  trades: number;          // Number of trades
}

export interface BotPortfolio {
  botId: string;
  positions: Position[];
  totalInvested: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPercent: number;
}

// ============================================================
// IN-MEMORY CACHE (for demo mode)
// ============================================================

const positionsCache: Map<string, Map<string, Position>> = new Map();

// Initialize cache for each bot
const BOT_IDS = ['chad', 'quantum', 'sensei', 'sterling', 'oracle'];
for (const botId of BOT_IDS) {
  positionsCache.set(botId, new Map());
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

export async function recordBuy(
  botId: string,
  tokenAddress: string,
  tokenSymbol: string,
  amountMon: number,
  tokenAmount: number,
  price: number
): Promise<void> {
  const botPositions = positionsCache.get(botId);
  if (!botPositions) return;

  const existing = botPositions.get(tokenAddress);
  
  if (existing) {
    // Update existing position
    const newTotalAmount = existing.amount + tokenAmount;
    const newTotalInvested = existing.totalInvested + amountMon;
    existing.amount = newTotalAmount;
    existing.totalInvested = newTotalInvested;
    existing.avgBuyPrice = newTotalInvested / newTotalAmount;
    existing.currentPrice = price;
    existing.currentValue = newTotalAmount * price;
    existing.pnl = existing.currentValue - existing.totalInvested;
    existing.pnlPercent = (existing.pnl / existing.totalInvested) * 100;
    existing.trades++;
  } else {
    // New position
    const position: Position = {
      botId,
      tokenAddress,
      tokenSymbol,
      amount: tokenAmount,
      avgBuyPrice: price,
      totalInvested: amountMon,
      currentPrice: price,
      currentValue: amountMon, // At buy time, value = invested
      pnl: 0,
      pnlPercent: 0,
      trades: 1,
    };
    botPositions.set(tokenAddress, position);
  }

  console.log(`📊 Position updated: ${botId} holds ${botPositions.get(tokenAddress)?.amount.toFixed(2)} $${tokenSymbol}`);
}

export async function recordSell(
  botId: string,
  tokenAddress: string,
  tokenAmount: number,
  monReceived: number
): Promise<number> {
  const botPositions = positionsCache.get(botId);
  if (!botPositions) return 0;

  const position = botPositions.get(tokenAddress);
  if (!position) return 0;

  // Calculate PnL for this sale
  const costBasis = (tokenAmount / position.amount) * position.totalInvested;
  const pnl = monReceived - costBasis;

  // Update position
  position.amount -= tokenAmount;
  position.totalInvested -= costBasis;
  position.trades++;

  if (position.amount <= 0.0001) {
    // Position closed
    botPositions.delete(tokenAddress);
    console.log(`📊 Position closed: ${botId} sold all $${position.tokenSymbol}, PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} MON`);
  } else {
    console.log(`📊 Partial sell: ${botId} sold some $${position.tokenSymbol}, PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} MON`);
  }

  return pnl;
}

export async function updatePrices(
  priceUpdates: Array<{ tokenAddress: string; price: number }>
): Promise<void> {
  for (const [botId, positions] of positionsCache) {
    for (const [tokenAddress, position] of positions) {
      const update = priceUpdates.find(p => p.tokenAddress === tokenAddress);
      if (update) {
        position.currentPrice = update.price;
        position.currentValue = position.amount * update.price;
        position.pnl = position.currentValue - position.totalInvested;
        position.pnlPercent = position.totalInvested > 0 
          ? (position.pnl / position.totalInvested) * 100 
          : 0;
      }
    }
  }
}

// ============================================================
// GETTERS
// ============================================================

export function getBotPositions(botId: string): Position[] {
  const botPositions = positionsCache.get(botId);
  if (!botPositions) return [];
  return Array.from(botPositions.values());
}

export function getBotPortfolio(botId: string): BotPortfolio {
  const positions = getBotPositions(botId);
  
  const totalInvested = positions.reduce((sum, p) => sum + p.totalInvested, 0);
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const totalPnl = totalValue - totalInvested;
  const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  return {
    botId,
    positions,
    totalInvested,
    totalValue,
    totalPnl,
    totalPnlPercent,
  };
}

export function getAllPortfolios(): BotPortfolio[] {
  return BOT_IDS.map(botId => getBotPortfolio(botId));
}

export function getPosition(botId: string, tokenAddress: string): Position | null {
  const botPositions = positionsCache.get(botId);
  if (!botPositions) return null;
  return botPositions.get(tokenAddress) || null;
}

// ============================================================
// LEADERBOARD
// ============================================================

export function getLeaderboard(): Array<{
  botId: string;
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winRate: number;
}> {
  const results = BOT_IDS.map(botId => {
    const portfolio = getBotPortfolio(botId);
    const positions = portfolio.positions;
    const totalTrades = positions.reduce((sum, p) => sum + p.trades, 0);
    const winningPositions = positions.filter(p => p.pnl > 0).length;
    const winRate = positions.length > 0 ? (winningPositions / positions.length) * 100 : 0;

    return {
      botId,
      totalPnl: portfolio.totalPnl,
      totalPnlPercent: portfolio.totalPnlPercent,
      totalTrades,
      winRate,
    };
  });

  // Sort by PnL descending
  return results.sort((a, b) => b.totalPnl - a.totalPnl);
}

// ============================================================
// API RESPONSE FORMATTERS
// ============================================================

export function formatPositionsForAPI(): Record<string, any> {
  const portfolios = getAllPortfolios();
  const leaderboard = getLeaderboard();

  return {
    portfolios: portfolios.map(p => ({
      botId: p.botId,
      totalInvested: p.totalInvested.toFixed(4),
      totalValue: p.totalValue.toFixed(4),
      totalPnl: p.totalPnl.toFixed(4),
      totalPnlPercent: p.totalPnlPercent.toFixed(2),
      positions: p.positions.map(pos => ({
        tokenSymbol: pos.tokenSymbol,
        tokenAddress: pos.tokenAddress,
        amount: pos.amount.toFixed(2),
        avgBuyPrice: pos.avgBuyPrice.toFixed(8),
        currentPrice: pos.currentPrice.toFixed(8),
        totalInvested: pos.totalInvested.toFixed(4),
        currentValue: pos.currentValue.toFixed(4),
        pnl: pos.pnl.toFixed(4),
        pnlPercent: pos.pnlPercent.toFixed(2),
        trades: pos.trades,
      })),
    })),
    leaderboard: leaderboard.map(l => ({
      botId: l.botId,
      totalPnl: l.totalPnl.toFixed(4),
      totalPnlPercent: l.totalPnlPercent.toFixed(2),
      totalTrades: l.totalTrades,
      winRate: l.winRate.toFixed(1),
    })),
  };
}