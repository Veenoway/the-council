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

    // Fetch prices once per unique token
    const tokenAddresses = [...new Set(positions.map((p: any) => p.tokenAddress))];
    const prices: Record<string, number> = {};

    for (const addr of tokenAddresses) {
      prices[addr as string] = (await getTokenPrice(addr as string)) || 0;
    }

    // Enrich positions
    const enriched = positions.map((p: any) => {
      const amount = Number(p.amount);
      const currentPrice = prices[p.tokenAddress] || 0;
      
      // IMPORTANT: Use entryValueMon (what we paid in MON), NOT entryPrice * amount
      const entryValueMON = Number(p.entryValueMon) || 0;
      const currentValueMON = amount * currentPrice;

      // PnL calculation
      let pnlMON = 0;
      let pnlPercent = 0;
      
      if (entryValueMON > 0) {
        pnlMON = currentValueMON - entryValueMON;
        pnlPercent = (pnlMON / entryValueMON) * 100;
      }

      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount,
        entryValueMON,       // What we paid (e.g., 2 MON)
        currentValueMON,     // Current value (e.g., 1.97 MON)
        currentPrice,        // Current price per token
        pnlMON: Math.round(pnlMON * 1000) / 1000,
        pnlPercent: Math.round(pnlPercent * 10) / 10,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
      };
    });

    // Group by bot - create portfolios
    const portfolios = ALL_BOT_IDS.map((botId: BotId) => {
      const config = getBotConfig(botId);
      const botPositions = enriched.filter((p: any) => p.botId === botId);

      const totalInvested = botPositions.reduce((sum: any, p: any) => sum + p.entryValueMON, 0);
      const totalValue = botPositions.reduce((sum: any, p: any) => sum + p.currentValueMON, 0);
      const totalPnl = totalValue - totalInvested;
      const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

      return {
        botId,
        name: config?.name || botId,
        positions: botPositions,
        totalInvested: Math.round(totalInvested * 1000) / 1000,
        totalValue: Math.round(totalValue * 1000) / 1000,
        totalPnl: Math.round(totalPnl * 1000) / 1000,
        totalPnlPercent: Math.round(totalPnlPercent * 10) / 10,
        openPositions: botPositions.length,
      };
    });

    // Council totals
    const totalInvested = enriched.reduce((sum: any, p: any) => sum + p.entryValueMON, 0);
    const totalValue = enriched.reduce((sum: any, p: any) => sum + p.currentValueMON, 0);
    const totalPnl = totalValue - totalInvested;
    const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    return c.json({
      positions: enriched,
      portfolios,
      summary: {
        totalPositions: enriched.length,
        totalInvested: Math.round(totalInvested * 1000) / 1000,
        totalValue: Math.round(totalValue * 1000) / 1000,
        totalPnl: Math.round(totalPnl * 1000) / 1000,
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

    const enriched = positions.map((p: any) => {
      const config = getBotConfig(p.botId as any) as any;

      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount: Number(p.amount),
        entryValueMON: Number(p.entryValueMon) || 0,
        pnlPercent: Number(p.pnl) || 0,
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

    const currentPrice = (await getTokenPrice(tokenAddress)) || 0;

    const enriched = positions.map((p: any) => {
      const amount = Number(p.amount);
      const entryValueMON = Number(p.entryValueMon) || 0;
      const config = getBotConfig(p.botId as any);

      const currentValueMON = p.isOpen
        ? amount * currentPrice
        : Number(p.exitPrice) * amount;

      let pnlPercent = 0;
      if (entryValueMON > 0) {
        pnlPercent = ((currentValueMON - entryValueMON) / entryValueMON) * 100;
      }

      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        amount,
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
      currentPrice,
      positions: enriched,
    });
  } catch (error) {
    console.error('Error fetching token positions:', error);
    return c.json({ error: 'Failed to fetch token positions' }, 500);
  }
});

export default positionsRouter;