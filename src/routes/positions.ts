// ============================================================
// POSITIONS ROUTES — All open positions
// ============================================================

import { Hono } from 'hono';
import { prisma } from '../db/index.js';
import { getTokenPrice } from '../services/nadfun.js';
import { getBotConfig, ALL_BOT_IDS } from '../bots/personalities.js';
import type { BotId } from '../types/index.js';

export const positionsRouter = new Hono();

// ============================================================
// GET /api/positions — All open positions with portfolios by bot
// ============================================================

positionsRouter.get('/', async (c) => {
  try {
    const positions = await prisma.position.findMany({
      where: { isOpen: true },
      orderBy: { createdAt: 'desc' },
    });
    
    // Enrich with current prices
    const enriched = await Promise.all(positions.map(async (p) => {
      const tokenAmount = Number(p.amount);
      const entryValueMON = Number((p as any).entryValueMon) || 0;
      const currentPricePerToken = await getTokenPrice(p.tokenAddress);
      const currentValueMON = currentPricePerToken ? tokenAmount * currentPricePerToken : entryValueMON;
      
      let pnlPercent = 0;
      if (entryValueMON > 0) {
        pnlPercent = ((currentValueMON - entryValueMON) / entryValueMON) * 100;
      }
      pnlPercent = Math.max(-99, Math.min(9999, pnlPercent));
      
      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount: tokenAmount,
        entryPrice: Number(p.entryPrice),
        currentPrice: currentPricePerToken || Number(p.entryPrice),
        entryValueMON,
        currentValueMON,
        totalInvested: entryValueMON,  // For backwards compatibility
        currentValue: currentValueMON,
        pnl: currentValueMON - entryValueMON,
        pnlPercent: Math.round(pnlPercent * 10) / 10,
        isOpen: true,
        createdAt: p.createdAt,
      };
    }));
    
    // Group by bot - create portfolios
    const portfolios = ALL_BOT_IDS.map((botId: BotId) => {
      const config = getBotConfig(botId);
      const botPositions = enriched.filter(p => p.botId === botId);
      
      const totalInvested = botPositions.reduce((sum, p) => sum + p.entryValueMON, 0);
      const totalValue = botPositions.reduce((sum, p) => sum + p.currentValueMON, 0);
      const totalPnl = totalValue - totalInvested;
      const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
      
      return {
        botId,
        name: config?.name || botId,
        positions: botPositions,
        totalInvested,
        totalValue,
        totalPnl,
        totalPnlPercent: Math.round(totalPnlPercent * 10) / 10,
        openPositions: botPositions.length,
      };
    });
    
    // Calculate council totals
    const totalValue = enriched.reduce((sum, p) => sum + p.currentValueMON, 0);
    const totalEntry = enriched.reduce((sum, p) => sum + p.entryValueMON, 0);
    const totalPnl = totalValue - totalEntry;
    const totalPnlPercent = totalEntry > 0 ? (totalPnl / totalEntry) * 100 : 0;
    
    return c.json({
      positions: enriched,
      portfolios,
      summary: {
        totalPositions: enriched.length,
        totalValue,
        totalInvested: totalEntry,
        totalPnl,
        totalPnlPercent: Math.round(totalPnlPercent * 10) / 10,
      },
    });
  } catch (error) {
    console.error('Error fetching positions:', error);
    return c.json({ error: 'Failed to fetch positions' }, 500);
  }
});

// ============================================================
// GET /api/positions/history — Closed positions
// ============================================================

positionsRouter.get('/history', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    
    const positions = await prisma.position.findMany({
      where: { isOpen: false },
      orderBy: { closedAt: 'desc' },
      take: limit,
    });
    
    const enriched = positions.map((p) => {
      const config = getBotConfig(p.botId as any);
      const entryValueMON = Number((p as any).entryValueMon) || 0;
      
      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        botAvatar: config?.avatar || '🤖',
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount: Number(p.amount),
        entryValueMON,
        totalInvested: entryValueMON,
        pnl: Number(p.pnl),
        holdTimeHours: p.closedAt && p.createdAt 
          ? (p.closedAt.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60)
          : 0,
        createdAt: p.createdAt,
        closedAt: p.closedAt,
      };
    });
    
    return c.json({ positions: enriched });
  } catch (error) {
    console.error('Error fetching position history:', error);
    return c.json({ error: 'Failed to fetch position history' }, 500);
  }
});

// ============================================================
// GET /api/positions/token/:address — Positions for specific token
// ============================================================

positionsRouter.get('/token/:address', async (c) => {
  try {
    const tokenAddress = c.req.param('address');
    
    const positions = await prisma.position.findMany({
      where: { tokenAddress },
      orderBy: { createdAt: 'desc' },
    });
    
    const currentPricePerToken = await getTokenPrice(tokenAddress);
    
    const enriched = positions.map((p) => {
      const tokenAmount = Number(p.amount);
      const entryValueMON = Number((p as any).entryValueMon) || 0;
      const config = getBotConfig(p.botId as any);
      
      const currentValueMON = p.isOpen 
        ? (currentPricePerToken ? tokenAmount * currentPricePerToken : entryValueMON)
        : Number(p.exitPrice) * tokenAmount;
      
      let pnlPercent = 0;
      if (entryValueMON > 0) {
        pnlPercent = ((currentValueMON - entryValueMON) / entryValueMON) * 100;
      }
      
      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        amount: tokenAmount,
        entryValueMON,
        currentValueMON,
        pnlPercent: Math.round(pnlPercent * 10) / 10,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
        closedAt: p.closedAt,
      };
    });
    
    return c.json({ 
      tokenAddress,
      currentPricePerToken,
      positions: enriched,
    });
  } catch (error) {
    console.error('Error fetching token positions:', error);
    return c.json({ error: 'Failed to fetch token positions' }, 500);
  }
});

export default positionsRouter;