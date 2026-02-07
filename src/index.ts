import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initDatabase, closeDatabase, prisma } from './db/index.js';
import { initWebSocket, closeWebSocket } from './services/websocket.js';
import { startOrchestrator } from './services/orchestrator.js';
import { getCurrentToken, getRecentMessages } from './services/messageBus.js';
import { getTokenPrice } from './services/nadfun.js';
import { getBotConfig, ALL_BOT_IDS } from './bots/personalities.js';

// ============================================================
// CONFIG
// ============================================================

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3005');
const WS_PORT = parseInt(process.env.WS_PORT || '8080');

// ============================================================
// HONO APP
// ============================================================

const app = new Hono();

// CORS
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// CURRENT TOKEN & MESSAGES
// ============================================================

app.get('/api/current-token', (c) => {
  const token = getCurrentToken();
  const messages = getRecentMessages(50);
  
  return c.json({
    token: token || null,
    messages: messages || [],
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// POSITIONS ROUTES
// ============================================================

// GET /api/positions — All positions grouped by bot (for frontend)
// GET /api/positions — All positions grouped by bot (for frontend)
app.get('/api/positions', async (c) => {
  try {
    const positions = await prisma.position.findMany({
      where: { isOpen: true },
      orderBy: { createdAt: 'desc' },
    });

    // Get unique token addresses to fetch current prices
    const tokenAddresses = [...new Set(positions.map(p => p.tokenAddress))];
    
    // Fetch current prices
    const priceMap: Record<string, number> = {};
    for (const address of tokenAddresses) {
      const price = await getTokenPrice(address);
      if (price) priceMap[address] = price;
    }

    // Enrich positions with current price and PnL
    const enrichedPositions = positions.map(p => {
      const currentPrice = priceMap[p.tokenAddress] || 0;
      const amount = Number(p.amount);
      
      // USE entryValueMon (what we paid), NOT entryPrice * amount
      const entryValueMON = Number(p.entryValueMon) || 0;
      const currentValueMON = amount * currentPrice;
      const pnlMON = currentValueMON - entryValueMON;
      const pnlPercent = entryValueMON > 0 ? (pnlMON / entryValueMON) * 100 : 0;

      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount,
        entryValueMON,
        currentValueMON,
        currentPrice,
        pnlMON: Math.round(pnlMON * 1000) / 1000,
        pnlPercent: Math.round(pnlPercent * 10) / 10,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
      };
    });

    // Build portfolios per bot
    const portfolios = ALL_BOT_IDS.map(botId => {
      const config = getBotConfig(botId);
      const botPositions = enrichedPositions.filter(p => p.botId === botId);
      
      const totalInvested = botPositions.reduce((sum, p) => sum + p.entryValueMON, 0);
      const totalValue = botPositions.reduce((sum, p) => sum + p.currentValueMON, 0);
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

    return c.json({
      positions: enrichedPositions,
      portfolios,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching positions:', error);
    return c.json({ error: 'Failed to fetch positions' }, 500);
  }
});

// GET /api/positions/:botId — Positions for specific bot
app.get('/api/positions/:botId', async (c) => {
  try {
    const botId = c.req.param('botId');
    const config = getBotConfig(botId as any);

    const positions = await prisma.position.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
    });

    // Fetch current prices
    const tokenAddresses = [...new Set(positions.map(p => p.tokenAddress))];
    const priceMap: Record<string, number> = {};
    
    await Promise.all(
      tokenAddresses.map(async (address) => {
        const price = await getTokenPrice(address);
        if (price) priceMap[address] = price;
      })
    );

    const enrichedPositions = positions.map(p => {
      const currentPrice = priceMap[p.tokenAddress] || Number(p.entryPrice);
      const entryPrice = Number(p.entryPrice);
      const amount = Number(p.amount);
      const totalInvested = amount * entryPrice;
      const currentValue = amount * currentPrice;
      const pnl = currentValue - totalInvested;
      const pnlPercent = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;

      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount,
        entryPrice,
        currentPrice,
        totalInvested,
        currentValue,
        pnl,
        pnlPercent,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
        closedAt: p.closedAt,
      };
    });

    const openPositions = enrichedPositions.filter(p => p.isOpen);
    const closedPositions = enrichedPositions.filter(p => !p.isOpen);

    return c.json({
      botId,
      name: config?.name || botId,
      positions: enrichedPositions,
      summary: {
        openPositions: openPositions.length,
        closedPositions: closedPositions.length,
        totalInvested: openPositions.reduce((sum, p) => sum + p.totalInvested, 0),
        totalValue: openPositions.reduce((sum, p) => sum + p.currentValue, 0),
        totalPnl: openPositions.reduce((sum, p) => sum + p.pnl, 0),
        realizedPnl: closedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching bot positions:', error);
    return c.json({ error: 'Failed to fetch positions' }, 500);
  }
});

// ============================================================
// BOTS ROUTES
// ============================================================

// GET /api/bots — Leaderboard
app.get('/api/bots', async (c) => {
  try {
    const stats = await prisma.botStats.findMany({
      orderBy: { totalPnl: 'desc' },
    });

    const leaderboard = stats.map((s, index) => {
      const config = getBotConfig(s.botId as any);
      return {
        rank: index + 1,
        botId: s.botId,
        name: config?.name || s.botId,
        avatar: config?.avatar || '🤖',
        color: config?.color || '#888',
        totalTrades: s.totalTrades,
        wins: s.wins,
        losses: s.losses,
        winRate: Number(s.winRate),
        totalPnl: Number(s.totalPnl),
        currentStreak: s.currentStreak,
        bestStreak: s.bestStreak,
      };
    });

    return c.json({
      leaderboard,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching bots:', error);
    return c.json({ error: 'Failed to fetch bots' }, 500);
  }
});

// GET /api/bots/:botId — Bot profile
app.get('/api/bots/:botId', async (c) => {
  try {
    const botId = c.req.param('botId');
    const config = getBotConfig(botId as any);

    const [stats, recentTrades, positions] = await Promise.all([
      prisma.botStats.findUnique({ where: { botId } }),
      prisma.trade.findMany({
        where: { botId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.position.findMany({
        where: { botId, isOpen: true },
      }),
    ]);

    return c.json({
      botId,
      name: config?.name || botId,
      avatar: config?.avatar || '🤖',
      color: config?.color || '#888',
      personality: config?.personality || '',
      stats: stats ? {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        winRate: Number(stats.winRate),
        totalPnl: Number(stats.totalPnl),
        currentStreak: stats.currentStreak,
        bestStreak: stats.bestStreak,
      } : null,
      recentTrades: recentTrades.map(t => ({
        id: t.id,
        tokenSymbol: t.tokenSymbol,
        side: t.side,
        amountIn: Number(t.amountIn),
        amountOut: Number(t.amountOut),
        price: Number(t.price),
        status: t.status,
        pnl: t.pnl ? Number(t.pnl) : null,
        createdAt: t.createdAt,
      })),
      openPositions: positions.length,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching bot:', error);
    return c.json({ error: 'Failed to fetch bot' }, 500);
  }
});

// ============================================================
// STATS ROUTES
// ============================================================

// GET /api/stats — Global stats
app.get('/api/stats', async (c) => {
  try {
    const [totalTrades, totalPositions, botStats] = await Promise.all([
      prisma.trade.count(),
      prisma.position.count({ where: { isOpen: true } }),
      prisma.botStats.findMany(),
    ]);

    const totalPnl = botStats.reduce((sum, s) => sum + Number(s.totalPnl), 0);
    const totalWins = botStats.reduce((sum, s) => sum + s.wins, 0);
    const totalLosses = botStats.reduce((sum, s) => sum + s.losses, 0);

    return c.json({
      totalTrades,
      totalPositions,
      totalPnl,
      totalWins,
      totalLosses,
      winRate: totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// GET /api/stats/today — Today's stats
app.get('/api/stats/today', async (c) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const dailyStats = await prisma.botDailyStats.findMany({
      where: { date: today },
    });

    const stats = dailyStats.map(s => {
      const config = getBotConfig(s.botId as any);
      return {
        botId: s.botId,
        name: config?.name || s.botId,
        trades: s.trades,
        wins: s.wins,
        pnl: Number(s.pnl),
        volume: Number(s.volume),
      };
    });

    return c.json({
      date: today,
      stats,
      totals: {
        trades: stats.reduce((sum, s) => sum + s.trades, 0),
        wins: stats.reduce((sum, s) => sum + s.wins, 0),
        pnl: stats.reduce((sum, s) => sum + s.pnl, 0),
        volume: stats.reduce((sum, s) => sum + s.volume, 0),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching today stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   🏛️  THE COUNCIL                                         ║
  ║   ─────────────────────────────────────────────────────   ║
  ║   5 AI Traders. 1 Mission. Infinite Degen Energy.        ║
  ║                                                           ║
  ║   🎌 Sensei    │ Vibes & Community                        ║
  ║   🤓 Quantum   │ Stats & Analysis                         ║
  ║   🦍 Chad      │ Degen Hunter                             ║
  ║   🎩 Sterling  │ Risk & Due Diligence                     ║
  ║   👁️ Oracle    │ The Unknown                              ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  // Check required env vars
  const requiredEnvVars = ['XAI_API_KEY'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  try {
    // Initialize database
    console.log('📦 Initializing database...');
    await initDatabase();

    // Start HTTP server
    console.log(`🌐 Starting HTTP server on port ${HTTP_PORT}...`);
    serve({
      fetch: app.fetch,
      port: HTTP_PORT,
    });
    console.log(`✅ HTTP API running at http://localhost:${HTTP_PORT}`);

    // Initialize WebSocket server
    console.log(`🔌 Starting WebSocket server on port ${WS_PORT}...`);
    initWebSocket(WS_PORT);

    // Start the orchestrator
    console.log('🤖 Starting bot orchestrator...');
    await startOrchestrator();

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await shutdown();
    process.exit(1);
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(): Promise<void> {
  console.log('\n🛑 Shutting down The Council...');
  closeWebSocket();
  await closeDatabase();
  console.log('👋 Goodbye.');
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

// ============================================================
// RUN
// ============================================================

main().catch(console.error);