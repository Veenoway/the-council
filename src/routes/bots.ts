// ============================================================
// BOTS ROUTES v3 — Stats include open positions, holdings aggregated
// ============================================================

import { Hono } from 'hono';
import { prisma } from '../db/index.js';
import { getBotConfig, ALL_BOT_IDS, type BotId } from '../bots/personalities.js';
import { getBotBalance } from '../services/trading.js';
import { getTokenPrice } from '../services/nadfun.js';

export const botsRouter = new Hono();

// ============================================================
// GET /api/bots — List all bots with basic info
// ============================================================

botsRouter.get('/', async (c) => {
  try {
    const bots = await Promise.all(ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId);
      
      // Get open positions count
      const openPositions = await prisma.position.count({
        where: { botId, isOpen: true },
      });
      
      // Get closed trades count
      const closedTrades = await prisma.position.count({
        where: { botId, isOpen: false },
      });
      
      return {
        id: botId,
        name: config?.name || botId,
        avatar: config?.avatar || '🤖',
        personality: config?.personality || '',
        openPositions,
        closedTrades,
      };
    }));
    
    return c.json({ bots });
  } catch (error) {
    console.error('Error fetching bots:', error);
    return c.json({ error: 'Failed to fetch bots' }, 500);
  }
});

// ============================================================
// GET /api/bots/:botId — Single bot profile with REAL stats & holdings
// ============================================================

botsRouter.get('/:botId', async (c) => {
  try {
    const botId = c.req.param('botId') as BotId;
    const config = getBotConfig(botId);
    
    if (!config) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    
    // Get all positions (open and closed)
    const allPositions = await prisma.position.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
    });
    
    const openPositions = allPositions.filter(p => p.isOpen);
    const closedPositions = allPositions.filter(p => !p.isOpen);
    
    // Calculate stats from CLOSED positions (realized PnL)
    const wins = closedPositions.filter(p => p.pnl && Number(p.pnl) > 0).length;
    const losses = closedPositions.filter(p => p.pnl && Number(p.pnl) <= 0).length;
    const totalClosedTrades = closedPositions.length;
    const winRate = totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0;
    const realizedPnl = closedPositions.reduce((sum, p) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
    
    // Calculate streak from recent closed trades
    let currentStreak = 0;
    let bestStreak = 0;
    let tempStreak = 0;
    
    for (const trade of closedPositions) {
      const isWin = trade.pnl && Number(trade.pnl) > 0;
      if (currentStreak === 0) {
        currentStreak = isWin ? 1 : -1;
        tempStreak = currentStreak;
      } else if ((currentStreak > 0 && isWin) || (currentStreak < 0 && !isWin)) {
        tempStreak += isWin ? 1 : -1;
      } else {
        break; // Streak broken
      }
    }
    currentStreak = tempStreak;
    bestStreak = Math.max(bestStreak, Math.abs(currentStreak));
    
    // Get MON balance
    let balance = 0;
    try {
      balance = await getBotBalance(botId);
    } catch (e) {
      console.error(`Failed to get balance for ${botId}:`, e);
    }
    
    // Aggregate holdings by token
    const aggregatedHoldings = await aggregateHoldings(openPositions);
    
    // Calculate totals
    const totalHoldingsValue = aggregatedHoldings.reduce((sum, h) => sum + h.currentValue, 0);
    const totalUnrealizedPnl = aggregatedHoldings.reduce((sum, h) => sum + h.unrealizedPnl, 0);
    const totalUnrealizedPnlPercent = aggregatedHoldings.reduce((sum, h) => sum + h.totalEntryValue, 0) > 0
      ? (totalUnrealizedPnl / aggregatedHoldings.reduce((sum, h) => sum + h.totalEntryValue, 0)) * 100
      : 0;
    
    return c.json({
      bot: {
        id: botId,
        name: config.name,
        avatar: config.avatar,
        personality: config.personality,
        style: config.style,
        walletAddress: config.walletAddress,
      },
      stats: {
        // Open positions (current)
        openPositions: openPositions.length,
        
        // Closed trades (realized)
        totalTrades: totalClosedTrades,
        wins,
        losses,
        winRate: Math.round(winRate * 10) / 10,
        
        // PnL
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
        unrealizedPnl: Math.round(totalUnrealizedPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(totalUnrealizedPnlPercent * 10) / 10,
        totalPnl: Math.round((realizedPnl + totalUnrealizedPnl) * 1000) / 1000,
        
        // Streaks
        currentStreak,
        bestStreak,
      },
      balance: {
        mon: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(totalHoldingsValue * 1000) / 1000,
        totalValue: Math.round((balance + totalHoldingsValue) * 1000) / 1000,
      },
      holdings: aggregatedHoldings,
      recentTrades: closedPositions.slice(0, 10).map(t => ({
        id: t.id,
        tokenSymbol: t.tokenSymbol,
        pnl: t.pnl ? Number(t.pnl) : 0,
        pnlPercent: t.entryPrice && t.exitPrice 
          ? ((Number(t.exitPrice) - Number(t.entryPrice)) / Number(t.entryPrice)) * 100 
          : 0,
        closedAt: t.closedAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching bot:', error);
    return c.json({ error: 'Failed to fetch bot' }, 500);
  }
});

// ============================================================
// GET /api/bots/:botId/holdings — Bot holdings (aggregated)
// ============================================================

botsRouter.get('/:botId/holdings', async (c) => {
  try {
    const botId = c.req.param('botId') as BotId;
    
    const positions = await prisma.position.findMany({
      where: { botId, isOpen: true },
    });
    
    const aggregatedHoldings = await aggregateHoldings(positions);
    
    const totalEntryValue = aggregatedHoldings.reduce((sum, h) => sum + h.totalEntryValue, 0);
    const totalValue = aggregatedHoldings.reduce((sum, h) => sum + h.currentValue, 0);
    const totalUnrealizedPnl = aggregatedHoldings.reduce((sum, h) => sum + h.unrealizedPnl, 0);
    
    return c.json({
      holdings: aggregatedHoldings,
      summary: {
        totalTokens: aggregatedHoldings.length,
        totalEntryValue: Math.round(totalEntryValue * 1000) / 1000,
        totalValue: Math.round(totalValue * 1000) / 1000,
        totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 1000) / 1000,
        totalUnrealizedPnlPercent: totalEntryValue > 0 
          ? Math.round((totalUnrealizedPnl / totalEntryValue) * 1000) / 10
          : 0,
      },
    });
  } catch (error) {
    console.error('Error fetching holdings:', error);
    return c.json({ error: 'Failed to fetch holdings' }, 500);
  }
});

// ============================================================
// GET /api/bots/:botId/trades — Bot trade history (closed positions)
// ============================================================

botsRouter.get('/:botId/trades', async (c) => {
  try {
    const botId = c.req.param('botId') as BotId;
    const limit = parseInt(c.req.query('limit') || '50');
    
    const trades = await prisma.position.findMany({
      where: { 
        botId,
        isOpen: false,
      },
      orderBy: { closedAt: 'desc' },
      take: limit,
    });
    
    return c.json({
      trades: trades.map(t => ({
        id: t.id,
        tokenSymbol: t.tokenSymbol,
        tokenAddress: t.tokenAddress,
        amount: Number(t.amount),
        entryPrice: Number(t.entryPrice),
        exitPrice: t.exitPrice ? Number(t.exitPrice) : null,
        entryValueMon: Number(t.entryValueMon),
        pnl: t.pnl ? Number(t.pnl) : 0,
        pnlPercent: t.entryValueMon && t.pnl
          ? (Number(t.pnl) / Number(t.entryValueMon)) * 100 
          : 0,
        entryTxHash: t.entryTxHash,
        exitTxHash: t.exitTxHash,
        openedAt: t.createdAt,
        closedAt: t.closedAt,
        durationMinutes: t.closedAt && t.createdAt 
          ? Math.floor((new Date(t.closedAt).getTime() - new Date(t.createdAt).getTime()) / 1000 / 60)
          : null,
      })),
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return c.json({ error: 'Failed to fetch trades' }, 500);
  }
});

// ============================================================
// HELPER: Aggregate holdings by token
// ============================================================

interface AggregatedHolding {
  tokenAddress: string;
  tokenSymbol: string;
  totalAmount: number;
  avgEntryPrice: number;
  totalEntryValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  positionCount: number;
  firstEntry: Date;
  lastEntry: Date;
}

async function aggregateHoldings(positions: any[]): Promise<AggregatedHolding[]> {
  if (!positions || positions.length === 0) return [];
  
  // Group by token address
  const byToken: Record<string, any[]> = {};
  for (const pos of positions) {
    const addr = pos.tokenAddress;
    if (!byToken[addr]) byToken[addr] = [];
    byToken[addr].push(pos);
  }
  
  const holdings: AggregatedHolding[] = [];
  
  for (const [tokenAddress, tokenPositions] of Object.entries(byToken)) {
    const totalAmount = tokenPositions.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalEntryValue = tokenPositions.reduce((sum, p) => sum + Number(p.entryValueMon || 0), 0);
    
    // Weighted average entry price
    const weightedPriceSum = tokenPositions.reduce(
      (sum, p) => sum + (Number(p.entryPrice) * Number(p.amount)), 
      0
    );
    const avgEntryPrice = totalAmount > 0 ? weightedPriceSum / totalAmount : 0;
    
    // Get current price
    let currentPrice = avgEntryPrice;
    try {
      const priceData = await getTokenPrice(tokenAddress);
      if (priceData) {
        currentPrice = typeof priceData === 'number' ? priceData : priceData.price || avgEntryPrice;
      }
    } catch (e) {
      console.error(`Failed to get price for ${tokenAddress}:`, e);
    }
    
    const currentValue = totalAmount * currentPrice;
    const unrealizedPnl = currentValue - totalEntryValue;
    const unrealizedPnlPercent = totalEntryValue > 0 
      ? (unrealizedPnl / totalEntryValue) * 100 
      : 0;
    
    const dates = tokenPositions.map(p => new Date(p.createdAt));
    const firstEntry = new Date(Math.min(...dates.map(d => d.getTime())));
    const lastEntry = new Date(Math.max(...dates.map(d => d.getTime())));
    
    holdings.push({
      tokenAddress,
      tokenSymbol: tokenPositions[0].tokenSymbol,
      totalAmount: Math.round(totalAmount * 100) / 100,
      avgEntryPrice,
      totalEntryValue: Math.round(totalEntryValue * 1000) / 1000,
      currentPrice,
      currentValue: Math.round(currentValue * 1000) / 1000,
      unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
      unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 10) / 10,
      positionCount: tokenPositions.length,
      firstEntry,
      lastEntry,
    });
  }
  
  // Sort by current value descending
  holdings.sort((a, b) => b.currentValue - a.currentValue);
  
  return holdings;
}

export default botsRouter;