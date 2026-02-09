import { Hono } from 'hono';
import { prisma } from '../db/index.js';
import { getTodayStats } from '../services/monitor.js';
import { getBotConfig, ALL_BOT_IDS } from '../bots/personalities.js';

export const statsRouter = new Hono();

// ============================================================
// GET /api/stats/today — Today's leaderboard
// ============================================================

statsRouter.get('/today', async (c) => {
  try {
    const stats = await getTodayStats();
    
    // Enrich with bot info
    const enriched = stats.map(s => {
      const config = getBotConfig(s.botId as any);
      return {
        ...s,
        botName: config?.name || s.botId,
        botAvatar: config?.emoji || '🤖',
      };    
    });
    
    // Add bots with no trades today
    const botsWithStats = new Set(stats.map(s => s.botId));
    for (const botId of ALL_BOT_IDS) {
      if (!botsWithStats.has(botId)) {
        const config = getBotConfig(botId) as any;
        enriched.push({
          botId,
          botName: config?.name || botId,
          botAvatar: config?.emoji || '🤖',
          trades: 0,
          wins: 0,
          winrate: 0,
          pnl: 0,
          volume: 0,
        });
      }
    }
    
    // Sort by PnL
    enriched.sort((a, b) => b.pnl - a.pnl);
    
    // Find today's leader
    const leader = enriched.find(s => s.trades > 0);
    
    return c.json({
      date: new Date().toISOString().split('T')[0],
      leaderboard: enriched,
      leader: leader || null,
      summary: {
        totalTrades: enriched.reduce((sum, s) => sum + s.trades, 0),
        totalVolume: enriched.reduce((sum, s) => sum + s.volume, 0),
        totalPnl: enriched.reduce((sum, s) => sum + s.pnl, 0),
      },
    });
  } catch (error) {
    console.error('Error fetching today stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// ============================================================
// GET /api/stats/history — Historical daily stats
// ============================================================

statsRouter.get('/history', async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '7');
    
    // Get stats for last N days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];
    
    const stats = await prisma.botDailyStats.findMany({
      where: {
        date: { gte: startDateStr },
      },
      orderBy: { date: 'desc' },
    });
    
    // Group by date
    const byDate: Record<string, any[]> = {};
    for (const s of stats) {
      if (!byDate[s.date]) byDate[s.date] = [];
      const config = getBotConfig(s.botId as any);
      byDate[s.date].push({
        botId: s.botId,
        botName: config?.name || s.botId,
        trades: s.trades,
        wins: s.wins,
        winrate: s.trades > 0 ? (s.wins / s.trades) * 100 : 0,
        pnl: Number(s.pnl),
        volume: Number(s.volume),
      });
    }
    
    // Find winner for each day
    const dailyWinners: Record<string, string> = {};
    for (const [date, dayStats] of Object.entries(byDate)) {
      const winner = dayStats.reduce((best, s) => 
        (s.trades > 0 && s.winrate > (best?.winrate || 0)) ? s : best, 
        null as any
      );
      if (winner) dailyWinners[date] = winner.botId;
    }
    
    return c.json({
      days,
      history: byDate,
      dailyWinners,
    });
  } catch (error) {
    console.error('Error fetching stats history:', error);
    return c.json({ error: 'Failed to fetch stats history' }, 500);
  }
});

// ============================================================
// GET /api/stats/overall — All-time stats
// ============================================================

statsRouter.get('/overall', async (c) => {
  try {
    const stats = await prisma.botStats.findMany({
      orderBy: { winRate: 'desc' },
    });
    
    const enriched = stats.map((s: any) => {
      const config = getBotConfig(s.botId as any);
      return {
        botId: s.botId,
        botName: config?.name || s.botId,
        botAvatar: config?.emoji || '🤖',  
        totalTrades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: Number(s.winRate),
        totalPnl: Number(s.totalPnl),
        currentStreak: s.currentStreak,
        bestStreak: s.bestStreak,
      };
    });
    
    // Add bots with no stats
    const botsWithStats = new Set(stats.map((s: any) => s.botId));
    for (const botId of ALL_BOT_IDS) {
      if (!botsWithStats.has(botId)) {
        const config = getBotConfig(botId) as any;
        enriched.push({
          botId,
          botName: config?.name || botId,
          botAvatar: config?.emoji || '🤖',
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalPnl: 0,
          currentStreak: 0,
          bestStreak: 0,
        });
      }
    }
    
    return c.json({
      bots: enriched,
      summary: {
        totalTrades: enriched.reduce((sum: any, s: any) => sum + s.totalTrades, 0),
        totalPnl: enriched.reduce((sum: any, s: any) => sum + s.totalPnl, 0),
        bestWinRate: Math.max(...enriched.map((s: any) => s.winRate)),
        bestStreak: Math.max(...enriched.map((s: any) => s.bestStreak)),
      },
    });
  } catch (error) {
    console.error('Error fetching overall stats:', error);
    return c.json({ error: 'Failed to fetch overall stats' }, 500);
  }
});

export default statsRouter;