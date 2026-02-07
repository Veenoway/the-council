import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initDatabase, closeDatabase, prisma } from './db/index.js';
import { initWebSocket, closeWebSocket } from './services/websocket.js';
import { startOrchestrator } from './services/orchestrator.js';
import { getCurrentToken, getRecentMessages } from './services/messageBus.js';
import { getTokenPrice } from './services/nadfun.js';
import { getBotConfig, ALL_BOT_IDS, type BotId } from './bots/personalities.js';
import { getBotBalance } from './services/trading.js';

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

app.get('/api/positions', async (c) => {
  try {
    const positions = await prisma.position.findMany({
      where: { isOpen: true },
      orderBy: { createdAt: 'desc' },
    });

    const tokenAddresses = [...new Set(positions.map(p => p.tokenAddress))];
    
    const priceMap: Record<string, number> = {};
    for (const address of tokenAddresses) {
      const price = await getTokenPrice(address);
      if (price) priceMap[address] = price;
    }

    const enrichedPositions = positions.map(p => {
      const currentPrice = priceMap[p.tokenAddress] || 0;
      const amount = Number(p.amount);
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

app.get('/api/positions/:botId', async (c) => {
  try {
    const botId = c.req.param('botId');
    const config = getBotConfig(botId as any);

    const positions = await prisma.position.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
    });

    const tokenAddresses = [...new Set(positions.map(p => p.tokenAddress))];
    const priceMap: Record<string, number> = {};
    
    for (const address of tokenAddresses) {
      const price = await getTokenPrice(address);
      if (price) priceMap[address] = price;
    }

    const enrichedPositions = positions.map(p => {
      const currentPrice = priceMap[p.tokenAddress] || Number(p.entryPrice);
      const entryPrice = Number(p.entryPrice);
      const amount = Number(p.amount);
      const entryValueMon = Number(p.entryValueMon) || (amount * entryPrice);
      const currentValue = amount * currentPrice;
      const pnl = currentValue - entryValueMon;
      const pnlPercent = entryValueMon > 0 ? (pnl / entryValueMon) * 100 : 0;

      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount,
        entryPrice,
        entryValueMon,
        currentPrice,
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
        totalInvested: openPositions.reduce((sum, p) => sum + p.entryValueMon, 0),
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

const tokenCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/token/:address', async (c) => {
  try {
    const address = c.req.param('address');
    
    // Check cache
    const cached = tokenCache.get(address);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return c.json(cached.data);
    }
    
    const response = await fetch(`https://api.nad.fun/token/${address}`);
    
    if (!response.ok) {
      return c.json({ error: 'Token not found' }, response?.status);
    }
    
    const data = await response.json();
    
    
    // Cache result
    tokenCache.set(address, { data, timestamp: Date.now() });
    
    return c.json(data);
  } catch (error) {
    console.error('Error fetching token:', error);
    return c.json({ error: 'Failed to fetch token data' }, 500);
  }
});
// ============================================================
// BOTS ROUTES — Read from Position table (REAL DATA)
// ============================================================

// GET /api/bots — All bots with stats from positions
app.get('/api/bots', async (c) => {
  try {
    const allPositions = await prisma.position.findMany();
    
    // Get current prices for open positions
    const openPositions = allPositions.filter(p => p.isOpen);
    const tokenAddresses = [...new Set(openPositions.map(p => p.tokenAddress))];
    const priceMap: Record<string, number> = {};
    
    for (const address of tokenAddresses) {
      try {
        const price = await getTokenPrice(address);
        if (price) priceMap[address] = price;
      } catch (e) {
        // ignore
      }
    }
    
    const bots = await Promise.all(ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId);
      const botPositions = allPositions.filter(p => p.botId === botId);
      const botOpenPositions = botPositions.filter(p => p.isOpen);
      const botClosedPositions = botPositions.filter(p => !p.isOpen);
      
      // Calculate unrealized PnL from open positions
      let totalEntryValue = 0;
      let totalCurrentValue = 0;
      
      for (const p of botOpenPositions) {
        const entryValue = Number(p.entryValueMon) || 0;
        const currentPrice = priceMap[p.tokenAddress] || Number(p.entryPrice);
        const currentValue = Number(p.amount) * currentPrice;
        totalEntryValue += entryValue;
        totalCurrentValue += currentValue;
      }
      
      const unrealizedPnl = totalCurrentValue - totalEntryValue;
      const unrealizedPnlPercent = totalEntryValue > 0 ? (unrealizedPnl / totalEntryValue) * 100 : 0;
      
      // Calculate realized PnL from closed positions
      const realizedPnl = botClosedPositions.reduce((sum, p) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
      const wins = botClosedPositions.filter(p => p.pnl && Number(p.pnl) > 0).length;
      const losses = botClosedPositions.filter(p => p.pnl && Number(p.pnl) <= 0).length;
      
      // Get balance
      let balance = 0;
      try {
        balance = await getBotBalance(botId);
      } catch (e) {
        // ignore
      }
      
      return {
        botId,
        name: config?.name || botId,
        avatar: config?.avatar || '🤖',
        color: config?.color || '#888',
        personality: config?.personality || '',
        
        // Stats
        openPositions: botOpenPositions.length,
        closedTrades: botClosedPositions.length,
        totalTrades: botPositions.length,
        wins,
        losses,
        winRate: botClosedPositions.length > 0 ? (wins / botClosedPositions.length) * 100 : 0,
        
        // PnL
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
        unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 10) / 10,
        totalPnl: Math.round((realizedPnl + unrealizedPnl) * 1000) / 1000,
        
        // Balance
        balance: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(totalCurrentValue * 1000) / 1000,
        totalValue: Math.round((balance + totalCurrentValue) * 1000) / 1000,
      };
    }));

    // Sort by total value
    bots.sort((a, b) => b.totalValue - a.totalValue);

    return c.json({
      bots,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching bots:', error);
    return c.json({ error: 'Failed to fetch bots' }, 500);
  }
});

// GET /api/bots/:botId — Single bot profile with holdings
app.get('/api/bots/:botId', async (c) => {
  try {
    const botId = c.req.param('botId') as BotId;
    const config = getBotConfig(botId);

    if (!config) {
      return c.json({ error: 'Bot not found' }, 404);
    }

    // Get all positions for this bot
    const allPositions = await prisma.position.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
    });

    const openPositions = allPositions.filter(p => p.isOpen);
    const closedPositions = allPositions.filter(p => !p.isOpen);

    // Get current prices
    const tokenAddresses = [...new Set(openPositions.map(p => p.tokenAddress))];
    const priceMap: Record<string, number> = {};
    
    for (const address of tokenAddresses) {
      try {
        const price = await getTokenPrice(address);
        if (price) priceMap[address] = price;
      } catch (e) {
        // ignore
      }
    }

    // Aggregate holdings by token
    const holdingsMap: Record<string, any> = {};
    
    for (const p of openPositions) {
      const addr = p.tokenAddress;
      if (!holdingsMap[addr]) {
        holdingsMap[addr] = {
          tokenAddress: addr,
          tokenSymbol: p.tokenSymbol,
          totalAmount: 0,
          totalEntryValue: 0,
          positions: [],
        };
      }
      holdingsMap[addr].totalAmount += Number(p.amount);
      holdingsMap[addr].totalEntryValue += Number(p.entryValueMon) || 0;
      holdingsMap[addr].positions.push(p.id);
    }

    const holdings = Object.values(holdingsMap).map((h: any) => {
      const currentPrice = priceMap[h.tokenAddress] || 0;
      const currentValue = h.totalAmount * currentPrice;
      const unrealizedPnl = currentValue - h.totalEntryValue;
      const unrealizedPnlPercent = h.totalEntryValue > 0 ? (unrealizedPnl / h.totalEntryValue) * 100 : 0;

      return {
        tokenAddress: h.tokenAddress,
        tokenSymbol: h.tokenSymbol,
        totalAmount: Math.round(h.totalAmount * 100) / 100,
        totalEntryValue: Math.round(h.totalEntryValue * 1000) / 1000,
        currentPrice,
        currentValue: Math.round(currentValue * 1000) / 1000,
        unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 10) / 10,
        positionCount: h.positions.length,
      };
    });

    // Sort by value
    holdings.sort((a, b) => b.currentValue - a.currentValue);

    // Calculate totals
    const totalEntryValue = holdings.reduce((sum, h) => sum + h.totalEntryValue, 0);
    const totalCurrentValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
    const totalUnrealizedPnl = totalCurrentValue - totalEntryValue;
    const totalUnrealizedPnlPercent = totalEntryValue > 0 ? (totalUnrealizedPnl / totalEntryValue) * 100 : 0;

    // Realized PnL
    const realizedPnl = closedPositions.reduce((sum, p) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
    const wins = closedPositions.filter(p => p.pnl && Number(p.pnl) > 0).length;
    const losses = closedPositions.filter(p => p.pnl && Number(p.pnl) <= 0).length;
    const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

    // Balance
    let balance = 0;
    try {
      balance = await getBotBalance(botId);
    } catch (e) {
      // ignore
    }

    // Recent trades (closed positions)
    const recentTrades = closedPositions.slice(0, 10).map(t => ({
      id: t.id,
      tokenSymbol: t.tokenSymbol,
      pnl: t.pnl ? Number(t.pnl) : 0,
      pnlPercent: t.entryValueMon && t.pnl 
        ? (Number(t.pnl) / Number(t.entryValueMon)) * 100 
        : 0,
      closedAt: t.closedAt,
    }));

    return c.json({
      bot: {
        id: botId,
        name: config.name,
        avatar: config.avatar,
        color: config.color,
        personality: config.personality,
        walletAddress: config.walletAddress,
      },
      stats: {
        openPositions: openPositions.length,
        closedTrades: closedPositions.length,
        totalTrades: allPositions.length,
        wins,
        losses,
        winRate: Math.round(winRate * 10) / 10,
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
        unrealizedPnl: Math.round(totalUnrealizedPnl * 1000) / 1000,
        unrealizedPnlPercent: Math.round(totalUnrealizedPnlPercent * 10) / 10,
        totalPnl: Math.round((realizedPnl + totalUnrealizedPnl) * 1000) / 1000,
      },
      balance: {
        mon: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(totalCurrentValue * 1000) / 1000,
        totalValue: Math.round((balance + totalCurrentValue) * 1000) / 1000,
      },
      holdings,
      recentTrades,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching bot:', error);
    return c.json({ error: 'Failed to fetch bot' }, 500);
  }
});

// ============================================================
// STATS ROUTES — Read from Position table (REAL DATA)
// ============================================================

app.get('/api/stats', async (c) => {
  try {
    const allPositions = await prisma.position.findMany();
    const openPositions = allPositions.filter(p => p.isOpen);
    const closedPositions = allPositions.filter(p => !p.isOpen);

    const totalPnl = closedPositions.reduce((sum, p) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
    const wins = closedPositions.filter(p => p.pnl && Number(p.pnl) > 0).length;
    const losses = closedPositions.filter(p => p.pnl && Number(p.pnl) <= 0).length;

    return c.json({
      totalTrades: allPositions.length,
      openPositions: openPositions.length,
      closedTrades: closedPositions.length,
      totalPnl,
      wins,
      losses,
      winRate: closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

app.get('/api/stats/today', async (c) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get positions created today
    const todayPositions = await prisma.position.findMany({
      where: {
        createdAt: { gte: today },
      },
    });

    // Group by bot
    const statsByBot: Record<string, any> = {};
    
    for (const botId of ALL_BOT_IDS) {
      const config = getBotConfig(botId);
      const botPositions = todayPositions.filter(p => p.botId === botId);
      const closedToday = botPositions.filter(p => !p.isOpen);
      
      const pnl = closedToday.reduce((sum, p) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
      const volume = botPositions.reduce((sum, p) => sum + (Number(p.entryValueMon) || 0), 0);
      const wins = closedToday.filter(p => p.pnl && Number(p.pnl) > 0).length;

      statsByBot[botId] = {
        botId,
        name: config?.name || botId,
        trades: botPositions.length,
        wins,
        pnl: Math.round(pnl * 1000) / 1000,
        volume: Math.round(volume * 1000) / 1000,
      };
    }

    const stats = Object.values(statsByBot);

    return c.json({
      date: today.toISOString().split('T')[0],
      stats,
      totals: {
        trades: stats.reduce((sum, s: any) => sum + s.trades, 0),
        wins: stats.reduce((sum, s: any) => sum + s.wins, 0),
        pnl: stats.reduce((sum, s: any) => sum + s.pnl, 0),
        volume: stats.reduce((sum, s: any) => sum + s.volume, 0),
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

  const requiredEnvVars = ['XAI_API_KEY'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  try {
    console.log('📦 Initializing database...');
    await initDatabase();

    console.log(`🌐 Starting HTTP server on port ${HTTP_PORT}...`);
    serve({
      fetch: app.fetch,
      port: HTTP_PORT,
    });
    console.log(`✅ HTTP API running at http://localhost:${HTTP_PORT}`);

    console.log(`🔌 Starting WebSocket server on port ${WS_PORT}...`);
    initWebSocket(WS_PORT);

    console.log('🤖 Starting bot orchestrator...');
    await startOrchestrator();

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await shutdown();
    process.exit(1);
  }
}

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

main().catch(console.error);