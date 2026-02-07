// ============================================================
// POSITION MONITOR — Auto sell at TP/SL
// ============================================================

import { prisma } from '../db/index.js';
import { closeBotPosition, getBotBalance } from './trading.js';
import { getTokenPrice, getTokenInfo } from './nadfun.js';
import { broadcastMessage } from './websocket.js';
import { randomUUID } from 'crypto';
import type { BotId, Token } from '../types/index.js';

// ============================================================
// CONFIG
// ============================================================

export const TRADING_CONFIG = {
  // Take Profit / Stop Loss
  takeProfitPercent: 50,    // +50% → sell
  stopLossPercent: -30,     // -30% → sell
  
  // Time-based exit
  maxHoldTimeHours: 24,     // Sell after 24h regardless
  
  // Limits per bot
  maxOpenPositions: 5,      // Max 5 positions per bot
  maxDailyTrades: 10,       // Max 10 trades per day per bot
  maxTotalInvested: 50,     // Max 50 MON invested per bot
  
  // Monitor interval
  checkIntervalMs: 60_000,  // Check every 60 seconds (avoid rate limit)
};

// ============================================================
// STATE
// ============================================================

let isRunning = false;
let monitorInterval: NodeJS.Timeout | null = null;

// ============================================================
// START / STOP
// ============================================================

export function startPositionMonitor(): void {
  if (isRunning) return;
  
  isRunning = true;
  console.log('📊 Position monitor started');
  
  // Run immediately, then on interval
  checkAllPositions();
  monitorInterval = setInterval(checkAllPositions, TRADING_CONFIG.checkIntervalMs);
}

export function stopPositionMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isRunning = false;
  console.log('📊 Position monitor stopped');
}

// ============================================================
// MAIN CHECK LOOP
// ============================================================

async function checkAllPositions(): Promise<void> {
  try {
    const positions = await prisma.position.findMany({
      where: { isOpen: true },
    });
    
    if (positions.length === 0) return;
    
    console.log(`📊 Checking ${positions.length} open positions...`);
    
    for (const position of positions) {
      await checkPosition(position);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (error) {
    console.error('Monitor error:', error);
  }
}

async function checkPosition(position: {
  id: string;
  botId: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: any;
  entryPrice: any;
  entryValueMon?: any;
  createdAt: Date;
}): Promise<void> {
  try {
    const tokenAmount = Number(position.amount);
    const entryValueMON = Number((position as any).entryValueMon) || 0;
    
    // If no entry value stored, skip (old position)
    if (entryValueMON === 0) {
      console.log(`⚠️ Position ${position.id} has no entryValueMon, skipping`);
      return;
    }
    
    // Get current token price
    const currentPricePerToken = await getTokenPrice(position.tokenAddress);
    if (!currentPricePerToken || currentPricePerToken === 0) return;
    
    // Calculate current value in MON
    const currentValueMON = tokenAmount * currentPricePerToken;
    
    // Calculate PnL
    const pnlMON = currentValueMON - entryValueMON;
    const pnlPercent = (pnlMON / entryValueMON) * 100;
    
    // Check hold time
    const holdTimeHours = (Date.now() - position.createdAt.getTime()) / (1000 * 60 * 60);
    
    let shouldSell = false;
    let reason = '';
    
    // Take Profit
    if (pnlPercent >= TRADING_CONFIG.takeProfitPercent) {
      shouldSell = true;
      reason = `TP hit +${pnlPercent.toFixed(1)}% (+${pnlMON.toFixed(2)} MON)`;
    }
    // Stop Loss
    else if (pnlPercent <= TRADING_CONFIG.stopLossPercent) {
      shouldSell = true;
      reason = `SL hit ${pnlPercent.toFixed(1)}% (${pnlMON.toFixed(2)} MON)`;
    }
    // Time exit
    else if (holdTimeHours >= TRADING_CONFIG.maxHoldTimeHours) {
      shouldSell = true;
      reason = `time exit (${holdTimeHours.toFixed(1)}h) at ${pnlPercent.toFixed(1)}%`;
    }
    
    if (shouldSell) {
      await executeExit(position, currentValueMON, pnlPercent, reason);
    }
  } catch (error) {
    console.error(`Error checking position ${position.id}:`, error);
  }
}

// ============================================================
// EXECUTE EXIT
// ============================================================

async function executeExit(
  position: {
    id: string;
    botId: string;
    tokenAddress: string;
    tokenSymbol: string;
    amount: any;
    entryPrice: any;
  },
  exitValueMON: number,
  pnlPercent: number,
  reason: string
): Promise<void> {
  const botId = position.botId as BotId;
  const isWin = pnlPercent > 0;
  
  console.log(`🔔 ${botId} selling $${position.tokenSymbol}: ${reason}`);
  
  // Broadcast sell message
  broadcastMessage({
    id: randomUUID(),
    botId,
    content: `selling $${position.tokenSymbol} — ${reason} ${isWin ? '✅' : '❌'}`,
    token: position.tokenAddress,
    messageType: 'trade',
    createdAt: new Date(),
  });
  
  try {
    // Build token object for closeBotPosition
    const token: Token = {
      address: position.tokenAddress,
      symbol: position.tokenSymbol,
      name: position.tokenSymbol,
      price: 0, // Not used for sell
      priceChange24h: 0,
      mcap: 0,
      liquidity: 0,
      holders: 0,
      deployer: '',
      createdAt: new Date(),
    };
    
    // Execute sell
    const trade = await closeBotPosition(botId, token);
    
    if (trade && trade.status === 'confirmed') {
      // Close position in DB
      await prisma.position.update({
        where: { id: position.id },
        data: {
          isOpen: false,
          exitPrice: exitValueMON / Number(position.amount), // Store price per token
          exitTxHash: trade.txHash,
          pnl: pnlPercent,
          closedAt: new Date(),
        },
      });
      
      // Update bot stats
      await updateBotDailyStats(botId, isWin, pnlPercent, exitValueMON);
      
      // Broadcast result
      const pnlEmoji = isWin ? '🟢' : '🔴';
      broadcastMessage({
        id: randomUUID(),
        botId,
        content: `${pnlEmoji} closed $${position.tokenSymbol} at ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`,
        token: position.tokenAddress,
        messageType: 'trade',
        createdAt: new Date(),
      });
    }
  } catch (error) {
    console.error(`Failed to exit position:`, error);
  }
}

// ============================================================
// DAILY STATS
// ============================================================

async function updateBotDailyStats(
  botId: string,
  isWin: boolean,
  pnl: number,
  volume: number
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    await prisma.botDailyStats.upsert({
      where: {
        botId_date: { botId, date: today },
      },
      update: {
        trades: { increment: 1 },
        wins: { increment: isWin ? 1 : 0 },
        pnl: { increment: pnl },
        volume: { increment: volume },
      },
      create: {
        botId,
        date: today,
        trades: 1,
        wins: isWin ? 1 : 0,
        pnl,
        volume,
      },
    });
    
    await prisma.botStats.upsert({
      where: { botId },
      update: {
        totalTrades: { increment: 1 },
        wins: { increment: isWin ? 1 : 0 },
        losses: { increment: isWin ? 0 : 1 },
        totalPnl: { increment: pnl },
        currentStreak: isWin ? { increment: 1 } : 0,
      },
      create: {
        botId,
        totalTrades: 1,
        wins: isWin ? 1 : 0,
        losses: isWin ? 0 : 1,
        winRate: isWin ? 100 : 0,
        totalPnl: pnl,
        currentStreak: isWin ? 1 : 0,
        bestStreak: isWin ? 1 : 0,
      },
    });
    
    const stats = await prisma.botStats.findUnique({ where: { botId } });
    if (stats && stats.totalTrades > 0) {
      await prisma.botStats.update({
        where: { botId },
        data: {
          winRate: (stats.wins / stats.totalTrades) * 100,
          bestStreak: Math.max(stats.bestStreak, stats.currentStreak),
        },
      });
    }
  } catch (error) {
    console.error('Failed to update daily stats:', error);
  }
}

// ============================================================
// TRADING LIMITS CHECK
// ============================================================

export async function canBotTrade(botId: string): Promise<{ allowed: boolean; reason?: string }> {
  const today = new Date().toISOString().split('T')[0];
  
  const dailyStats = await prisma.botDailyStats.findUnique({
    where: { botId_date: { botId, date: today } },
  });
  
  if (dailyStats && dailyStats.trades >= TRADING_CONFIG.maxDailyTrades) {
    return { allowed: false, reason: `max daily trades (${TRADING_CONFIG.maxDailyTrades})` };
  }
  
  const openPositions = await prisma.position.count({
    where: { botId, isOpen: true },
  });
  
  if (openPositions >= TRADING_CONFIG.maxOpenPositions) {
    return { allowed: false, reason: `max open positions (${TRADING_CONFIG.maxOpenPositions})` };
  }
  
  // Check total invested using entryValueMon
  const positions = await prisma.position.findMany({
    where: { botId, isOpen: true },
  });
  
  const totalInvested = positions.reduce((sum: number, p: any) => sum + (Number((p as any).entryValueMon) || 0), 0);
  
  if (totalInvested >= TRADING_CONFIG.maxTotalInvested) {
    return { allowed: false, reason: `max invested (${TRADING_CONFIG.maxTotalInvested} MON)` };
  }
  
  return { allowed: true };
}

// ============================================================
// HELPERS
// ============================================================

export async function getBotOpenPositions(botId: string) {
  const positions = await prisma.position.findMany({
    where: { botId, isOpen: true },
    orderBy: { createdAt: 'desc' },
  });
  
  const enriched = await Promise.all(positions.map(async (p) => {
    const tokenAmount = Number(p.amount);
    const entryValueMON = Number((p as any).entryValueMon) || 0;
    
    // Get current token price
    const currentPricePerToken = await getTokenPrice(p.tokenAddress);
    const currentValueMON = currentPricePerToken ? tokenAmount * currentPricePerToken : entryValueMON;
    
    // PnL = (current - entry) / entry * 100
    let pnlPercent = 0;
    if (entryValueMON > 0) {
      pnlPercent = ((currentValueMON - entryValueMON) / entryValueMON) * 100;
    }
    
    // Clamp to reasonable range
    pnlPercent = Math.max(-99, Math.min(9999, pnlPercent));
    
    return {
      id: p.id,
      tokenAddress: p.tokenAddress,
      tokenSymbol: p.tokenSymbol,
      amount: tokenAmount,
      entryValueMON,
      currentValueMON,
      pnlPercent: Math.round(pnlPercent * 10) / 10,
      holdTimeHours: (Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60),
      createdAt: p.createdAt,
    };
  }));
  
  return enriched;
}

export async function getAllOpenPositions() {
  return prisma.position.findMany({
    where: { isOpen: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getTodayStats() {
  const today = new Date().toISOString().split('T')[0];
  
  const stats = await prisma.botDailyStats.findMany({
    where: { date: today },
    orderBy: { pnl: 'desc' },
  });
  
  return stats.map((s: any) => ({
    botId: s.botId,
    trades: s.trades,
    wins: s.wins,
    winrate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
    pnl: Number(s.pnl),
    volume: Number(s.volume),
  }));
}