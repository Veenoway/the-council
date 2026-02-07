// ============================================================
// BOTS ROUTES — Bot profiles, stats, trades
// ============================================================

import { Hono } from 'hono';
import { prisma } from '../db/index.js';
import { getBotOpenPositions } from '../services/monitor.js';
import { getBotBalance } from '../services/trading.js';
import { getBotConfig, ALL_BOT_IDS } from '../bots/personalities.js';
import type { BotId } from '../types/index.js';
import type { Trade } from '../types/index.js';

export const botsRouter = new Hono();

// ============================================================
// GET /api/bots — Leaderboard (all bots)
// ============================================================

botsRouter.get('/', async (c) => {
  try {
    const bots = await Promise.all(ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId);
      
      // Get stats
      const stats = await prisma.botStats.findUnique({
        where: { botId },
      });
      
      // Get open positions count
      const openPositions = await prisma.position.count({
        where: { botId, isOpen: true },
      });
      
      // Get balance
      const balance = await getBotBalance(botId);
      
      return {
        botId,
        name: config?.name || botId,
        imgURL: config?.imgURL || '',
        personality: config?.personality || '',
        stats: stats ? {
          totalTrades: stats.totalTrades,
          wins: stats.wins,
          losses: stats.losses,
          winRate: Number(stats.winRate),
          totalPnl: Number(stats.totalPnl),
          currentStreak: stats.currentStreak,
          bestStreak: stats.bestStreak,
        } : {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalPnl: 0,
          currentStreak: 0,
          bestStreak: 0,
        },
        openPositions,
        balance,
      };
    }));
    
    // Sort by winRate desc
    bots.sort((a, b) => b.stats.winRate - a.stats.winRate);
    
    return c.json({ bots });
  } catch (error) {
    console.error('Error fetching bots:', error);
    return c.json({ error: 'Failed to fetch bots' }, 500);
  }
});

// ============================================================
// GET /api/bots/:id — Bot profile
// ============================================================

botsRouter.get('/:id', async (c) => {
  try {
    const botId = c.req.param('id') as BotId;
    
    if (!ALL_BOT_IDS.includes(botId)) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    
    const config = getBotConfig(botId);
    
    // Get stats
    const stats = await prisma.botStats.findUnique({
      where: { botId },
    });
    
    // Get open positions with current PnL
    const positions = await getBotOpenPositions(botId);
    
    // Get recent trades
    const recentTrades = await prisma.trade.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    
    // Get balance
    const balance = await getBotBalance(botId);
    
    // Calculate total holdings value
    const holdingsValue = positions.reduce((sum, p) => sum + (p.amount * p.currentPrice), 0);
    
    return c.json({
      botId,
      name: config?.name || botId,
      imgURL: config?.imgURL || '',
      personality: config?.personality || '',
      style: config?.style || '',
      balance,
      holdingsValue,
      stats: stats ? {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        winRate: Number(stats.winRate),
        totalPnl: Number(stats.totalPnl),
        currentStreak: stats.currentStreak,
        bestStreak: stats.bestStreak,
      } : null,
      positions: positions.map(p => ({
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount: p.amount,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnlPercent: p.pnlPercent,
        holdTimeHours: p.holdTimeHours,
        createdAt: p.createdAt,
      })),
      recentTrades: recentTrades.map((t: Trade) => ({
        id: t.id,
        tokenSymbol: t.tokenSymbol,
        side: t.side,
        amountIn: Number(t.amountIn),
        amountOut: Number(t.amountOut),
        price: Number(t.price),
        pnl: t.pnl ? Number(t.pnl) : null,
        status: t.status,
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching bot:', error);
    return c.json({ error: 'Failed to fetch bot' }, 500);
  }
});

// ============================================================
// GET /api/bots/:id/trades — Bot trade history
// ============================================================

botsRouter.get('/:id/trades', async (c) => {
  try {
    const botId = c.req.param('id') as BotId;
    const limit = parseInt(c.req.query('limit') || '50');
    
    if (!ALL_BOT_IDS.includes(botId)) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    
    const trades = await prisma.trade.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    
    return c.json({
      trades: trades.map((t: Trade) => ({
        id: t.id,
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.tokenSymbol,
        side: t.side,
        amountIn: Number(t.amountIn),
        amountOut: Number(t.amountOut),
        price: Number(t.price),
        pnl: t.pnl ? Number(t.pnl) : null,
        status: t.status,
        txHash: t.txHash,
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return c.json({ error: 'Failed to fetch trades' }, 500);
  }
});

// ============================================================
// GET /api/bots/:id/positions — Bot open positions
// ============================================================

botsRouter.get('/:id/positions', async (c) => {
  try {
    const botId = c.req.param('id') as BotId;
    
    if (!ALL_BOT_IDS.includes(botId)) {
      return c.json({ error: 'Bot not found' }, 404);
    }
    
    const positions = await getBotOpenPositions(botId);
    
    return c.json({ positions });
  } catch (error) {
    console.error('Error fetching positions:', error);
    return c.json({ error: 'Failed to fetch positions' }, 500);
  }
});

export default botsRouter;