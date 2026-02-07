// ============================================================
// MONITOR v2 — Position monitoring, stats tracking, daily resets
// ============================================================

import { prisma, getOpenPositions, closePosition } from '../db/index.js';
import { getTokenPrice } from './nadfun.js';
import { executeBotTrade, getBotBalance } from './trading.js';
import { broadcastMessage } from './websocket.js';
import { getBotConfig, ALL_BOT_IDS, type BotId } from '../bots/personalities.js';
import { randomUUID } from 'crypto';

// ============================================================
// CONFIG
// ============================================================

const MONITOR_INTERVAL = 30_000;      // Check positions every 30s
const TAKE_PROFIT_PERCENT = 50;       // +50% = take profit
const STOP_LOSS_PERCENT = -30;        // -30% = stop loss
const MAX_POSITION_AGE_HOURS = 24;    // Close after 24h regardless
const MAX_OPEN_POSITIONS = 5;         // Per bot

// ============================================================
// STATE
// ============================================================

let isRunning = false;
let lastDailyReset: string | null = null;

// ============================================================
// MAIN MONITOR LOOP
// ============================================================

export async function startMonitor(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  
  console.log('📊 Position Monitor v2 started');
  
  while (isRunning) {
    try {
      // Check for daily reset
      await checkDailyReset();
      
      // Monitor all bot positions
      for (const botId of ALL_BOT_IDS) {
        await monitorBotPositions(botId);
      }
    } catch (error) {
      console.error('Monitor error:', error);
    }
    
    await sleep(MONITOR_INTERVAL);
  }
}

export function stopMonitor(): void {
  isRunning = false;
}

// ============================================================
// POSITION MONITORING
// ============================================================

async function monitorBotPositions(botId: BotId): Promise<void> {
  const positions = await getOpenPositions(botId);
  
  for (const pos of positions) {
    try {
      // Get current price
      const priceData = await getTokenPrice(pos.tokenAddress);
      if (!priceData?.price) continue;
      
      const currentPrice = priceData.price;
      const entryPrice = Number(pos.entryPrice);
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      // Calculate position age
      const ageHours = (Date.now() - new Date(pos.createdAt).getTime()) / (1000 * 60 * 60);
      
      let shouldClose = false;
      let reason = '';
      
      // Check take profit
      if (pnlPercent >= TAKE_PROFIT_PERCENT) {
        shouldClose = true;
        reason = `TP hit +${pnlPercent.toFixed(1)}%`;
      }
      // Check stop loss
      else if (pnlPercent <= STOP_LOSS_PERCENT) {
        shouldClose = true;
        reason = `SL hit ${pnlPercent.toFixed(1)}%`;
      }
      // Check max age
      else if (ageHours >= MAX_POSITION_AGE_HOURS) {
        shouldClose = true;
        reason = `Max age ${ageHours.toFixed(1)}h`;
      }
      
      if (shouldClose) {
        await closePositionWithTrade(botId, pos, currentPrice, reason);
      }
    } catch (error) {
      console.error(`Error monitoring position ${pos.id}:`, error);
    }
  }
}

// ============================================================
// CLOSE POSITION
// ============================================================

async function closePositionWithTrade(
  botId: BotId, 
  position: any, 
  currentPrice: number,
  reason: string
): Promise<void> {
  const config = getBotConfig(botId);
  const entryPrice = Number(position.entryPrice);
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
  const pnlMon = Number(position.amount) * (currentPrice - entryPrice);
  
  console.log(`📤 Closing ${position.tokenSymbol} for ${config?.name}: ${reason}`);
  
  // Execute sell trade
  const trade = await executeBotTrade(
    botId, 
    { address: position.tokenAddress, symbol: position.tokenSymbol } as any,
    Number(position.amount),
    'sell'
  );
  
  if (trade?.status === 'confirmed') {
    // Close position in DB
    await closePosition(position.id, currentPrice, pnlMon, trade.txHash);
    
    // Update bot stats
    await updateBotStats(botId, pnlMon > 0, pnlMon, Number(position.entryValueMon || 0));
    
    // Broadcast message
    const emoji = pnlMon >= 0 ? '🟢' : '🔴';
    const msg = {
      id: randomUUID(),
      botId,
      content: `${emoji} Closed $${position.tokenSymbol} | ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% | ${reason}`,
      messageType: 'trade' as const,
      createdAt: new Date(),
    };
    broadcastMessage(msg);
  } else {
    console.error(`Failed to close position ${position.id}`);
  }
}

// ============================================================
// STATS UPDATES — This is the key fix!
// ============================================================

export async function updateBotStats(
  botId: BotId, 
  isWin: boolean, 
  pnl: number,
  volume: number
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // Update all-time stats
    await prisma.botStats.upsert({
      where: { botId },
      create: {
        botId,
        totalTrades: 1,
        wins: isWin ? 1 : 0,
        losses: isWin ? 0 : 1,
        winRate: isWin ? 100 : 0,
        totalPnl: pnl,
        currentStreak: isWin ? 1 : -1,
        bestStreak: isWin ? 1 : 0,
      },
      update: {
        totalTrades: { increment: 1 },
        wins: { increment: isWin ? 1 : 0 },
        losses: { increment: isWin ? 0 : 1 },
        totalPnl: { increment: pnl },
        // Update streak
        currentStreak: isWin 
          ? { increment: 1 }  // This doesn't work for resetting, need raw query
          : { decrement: 1 },
      },
    });
    
    // Fix streak logic with raw update
    const currentStats = await prisma.botStats.findUnique({ where: { botId } });
    if (currentStats) {
      let newStreak: number;
      if (isWin) {
        // If was negative or 0, start new win streak
        newStreak = currentStats.currentStreak >= 0 ? currentStats.currentStreak + 1 : 1;
      } else {
        // If was positive or 0, start new loss streak
        newStreak = currentStats.currentStreak <= 0 ? currentStats.currentStreak - 1 : -1;
      }
      
      const newBestStreak = Math.max(currentStats.bestStreak, newStreak);
      const newWinRate = currentStats.totalTrades > 0 
        ? (currentStats.wins / currentStats.totalTrades) * 100 
        : 0;
      
      await prisma.botStats.update({
        where: { botId },
        data: {
          currentStreak: newStreak,
          bestStreak: newBestStreak,
          winRate: newWinRate,
        },
      });
    }
    
    // Update daily stats
    await prisma.botDailyStats.upsert({
      where: {
        botId_date: { botId, date: today },
      },
      create: {
        botId,
        date: today,
        trades: 1,
        wins: isWin ? 1 : 0,
        pnl,
        volume,
      },
      update: {
        trades: { increment: 1 },
        wins: { increment: isWin ? 1 : 0 },
        pnl: { increment: pnl },
        volume: { increment: volume },
      },
    });
    
    console.log(`📊 Stats updated for ${botId}: ${isWin ? 'WIN' : 'LOSS'} ${pnl.toFixed(2)} MON`);
  } catch (error) {
    console.error(`Failed to update stats for ${botId}:`, error);
  }
}

// Call this when a trade is opened (to track volume even without PnL yet)
export async function recordTradeOpen(botId: BotId, volumeMon: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // Just increment volume for daily stats
    await prisma.botDailyStats.upsert({
      where: {
        botId_date: { botId, date: today },
      },
      create: {
        botId,
        date: today,
        trades: 0,  // Don't count as trade until closed
        wins: 0,
        pnl: 0,
        volume: volumeMon,
      },
      update: {
        volume: { increment: volumeMon },
      },
    });
  } catch (error) {
    console.error(`Failed to record trade open for ${botId}:`, error);
  }
}

// ============================================================
// DAILY RESET
// ============================================================

async function checkDailyReset(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  if (lastDailyReset !== today) {
    console.log(`📅 New day: ${today} - Daily stats will accumulate fresh`);
    lastDailyReset = today;
    
    // Could add any daily reset logic here
    // Daily stats auto-separate by date, so no reset needed
  }
}

// ============================================================
// GET TODAY'S STATS
// ============================================================

export async function getTodayStats(): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  
  const stats = await prisma.botDailyStats.findMany({
    where: { date: today },
  });
  
  return stats.map(s => ({
    botId: s.botId,
    trades: s.trades,
    wins: s.wins,
    winrate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
    pnl: Number(s.pnl),
    volume: Number(s.volume),
  }));
}

// ============================================================
// CAN BOT TRADE — Check if bot can open new positions
// ============================================================

export async function canBotTrade(botId: BotId): Promise<{ allowed: boolean; reason?: string }> {
  const positions = await getOpenPositions(botId);
  
  if (positions.length >= MAX_OPEN_POSITIONS) {
    return { 
      allowed: false, 
      reason: `max ${MAX_OPEN_POSITIONS} positions` 
    };
  }
  
  const balance = await getBotBalance(botId);
  if (balance < 1) {
    return { 
      allowed: false, 
      reason: 'insufficient balance' 
    };
  }
  
  return { allowed: true };
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export { MAX_OPEN_POSITIONS };