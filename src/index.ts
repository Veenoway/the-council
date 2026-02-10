import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initDatabase, closeDatabase, prisma } from './db/index.js';
import { initWebSocket, closeWebSocket } from './services/websocket.js';
import { startOrchestrator } from './services/orchestrator.js';
import { getCurrentToken, getRecentMessages } from './services/messageBus.js';
import { getWalletBalance, getWalletHoldings } from './services/nadfun.js';
import { getBotConfig, ALL_BOT_IDS,  } from './bots/personalities.js';
import { getBotBalance, getBotWallet,  } from './services/trading.js';
import { startPredictionsResolver } from './jobs/prediction-resolver.js';
import { getRecentMessages as getRecentMessagesFromDB } from './db/index.js';
import { startPriceUpdater } from './jobs/price-updater.js';
import { startImageUpdater } from './jobs/image-updater.js';
import agentsRouter from './routes/agents.js';

// ============================================================
// CONFIG
// ============================================================

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3005');
const WS_PORT = parseInt(process.env.WS_PORT || '8080');

// ============================================================
// HONO APP
// ============================================================

const app = new Hono();

app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE'] }));

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ============================================================
// CURRENT STATE
// ============================================================

app.get('/api/current-token', async (c) => {
  const token = getCurrentToken();
  
  // Get messages from memory first (live), fallback to DB
  let messages = getRecentMessages(50);
  
  // If no messages in memory, fetch from DB (for SSR on cold start)
  if (!messages || messages.length === 0) {
    messages = await getRecentMessagesFromDB(10);
  }
  
  return c.json({ token: token || null, messages: messages || [], timestamp: new Date().toISOString() });
});

// ============================================================
// TRADES — Recent trades (no live price fetching to avoid rate limits)
// ============================================================

app.get('/api/trades', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    
    const positions = await prisma.position.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Don't fetch live prices here - use entry price for closed, 
    // frontend can fetch live prices separately if needed
    const trades = positions.map((p:any) => {
      const entryValue = Number(p.entryValueMon) || 0;
      const config = getBotConfig(p.botId as any) as any;

      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        botAvatar: config?.emoji || '🤖',
        botColor: config?.color || '#888',
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        amount: Number(p.amount),
        entryPrice: Number(p.entryPrice),
        entryValue: Math.round(entryValue * 1000) / 1000,
        pnl: p.pnl ? Math.round(Number(p.pnl) * 1000) / 1000 : 0,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
        closedAt: p.closedAt,
        txHash: p.entryTxHash,
      };
    });

    return c.json({ trades, count: trades.length, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return c.json({ error: 'Failed to fetch trades' }, 500);
  }
});

app.get('/api/trades/live', async (c) => {
  try {
    const since = c.req.query('since');
    const where: any = {};
    if (since) where.createdAt = { gt: new Date(since) };

    const positions = await prisma.position.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const trades = positions.map((p: any) => {
        const config = getBotConfig(p.botId as any) as any;
      return {
        id: p.id,
        botId: p.botId,
        botName: config?.name || p.botId,
        botAvatar: config?.emoji || '🤖',
        botColor: config?.color || '#888',
        tokenSymbol: p.tokenSymbol,
        tokenAddress: p.tokenAddress,
        amount: Number(p.amount),
        valueMon: Math.round(Number(p.entryValueMon) * 1000) / 1000,
        createdAt: p.createdAt,
        txHash: p.entryTxHash,
      };
    });

    return c.json({ trades, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching live trades:', error);
    return c.json({ error: 'Failed to fetch trades' }, 500);
  }
});

// ============================================================
// TOKENS — Analyzed tokens history
// ============================================================

app.get('/api/tokens', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');

    const tokens = await prisma.token.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    const enrichedTokens = tokens.map((t: any) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      price: t.price ? Number(t.price) : null,
      mcap: t.mcap ? Number(t.mcap) : null,
      liquidity: t.liquidity ? Number(t.liquidity) : null,
      holders: t.holders,
      verdict: t.verdict,
      riskScore: t.riskScore,
      // analysis contient riskFlags et opinions
      riskFlags: (t.analysis as any)?.flags || null,
      opinions: (t.analysis as any)?.opinions || null,
      analyzedAt: t.updatedAt,
    }));

    return c.json({ tokens: enrichedTokens, count: enrichedTokens.length, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return c.json({ error: 'Failed to fetch tokens' }, 500);
  }
});

app.get('/api/tokens/verdicts', async (c) => {
  try {
    const tokens = await prisma.token.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const buys = tokens.filter((t: any) => t.verdict === 'buy');
    const passes = tokens.filter((t: any) => t.verdict === 'pass');

    return c.json({
      summary: {
        total: tokens.length,
        buys: buys.length,
        passes: passes.length,
        buyRate: tokens.length > 0 ? Math.round((buys.length / tokens.length) * 100) : 0,
      },
      recentBuys: buys.slice(0, 10).map((t: any) => ({
        symbol: t.symbol,
        address: t.address,
        riskScore: t.riskScore,
        analyzedAt: t.updatedAt,
      })),
      recentPasses: passes.slice(0, 10).map((t: any) => ({
        symbol: t.symbol,
        address: t.address,
        riskScore: t.riskScore,
        analyzedAt: t.updatedAt,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching verdicts:', error);
    return c.json({ error: 'Failed to fetch verdicts' }, 500);
  }
});

app.get('/api/tokens/analysis/:address', async (c) => {
  try {
    const address = c.req.param('address');
    const token = await prisma.token.findUnique({ where: { address } });

    if (!token) return c.json({ error: 'Token not found' }, 404);

    const positions = await prisma.position.findMany({
      where: { tokenAddress: address },
      orderBy: { createdAt: 'desc' },
    });

    const botsInvested = positions.filter((p: any) => p.isOpen).map((p: any) => {
      const config = getBotConfig(p.botId as any) as any;
      return {
        botId: p.botId,
        botName: config?.name || p.botId,
        amount: Number(p.amount),
        entryValue: Number(p.entryValueMon),
      };
    });

    return c.json({
      token: {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        price: token.price ? Number(token.price) : null,
        mcap: token.mcap ? Number(token.mcap) : null,
        liquidity: token.liquidity ? Number(token.liquidity) : null,
        holders: token.holders,
        verdict: token.verdict,
        riskScore: token.riskScore,
        riskFlags: (token.analysis as any)?.flags || null,
        opinions: (token.analysis as any)?.opinions || null,
        analyzedAt: token.updatedAt,
        image: token.image,
      },
      positions: {
        total: positions.length,
        open: positions.filter((p: any) => p.isOpen).length,
        botsInvested,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching token:', error);
    return c.json({ error: 'Failed to fetch token' }, 500);
  }
});

// ============================================================
// POSITIONS — No live price fetching to avoid rate limits
// ============================================================


app.get('/api/positions', async (c) => {
  try {
    const MON_PRICE_USD = 0.01795;
    
    const positions = await prisma.position.findMany({ 
      where: { isOpen: true }, 
      orderBy: { createdAt: 'desc' },
    });
    
    // Récupère les prix ET images depuis la DB
    const tokenAddresses = [...new Set(positions.map((p: any) => p.tokenAddress))];
    console.log("tokenAddresses =====>", tokenAddresses);
    const tokens = await prisma.token.findMany({
      where: { address: { in: tokenAddresses } },
      select: { address: true, price: true, image: true },
    });
    console.log("tokens =====>", tokens);
    
    const tokenMap: Record<string, { price: number; image: string | null }> = {};
    tokens.forEach((t: any) => {
      tokenMap[t.address.toLowerCase()] = {
        price: t.price || 0,
        image: t.image || null,
      };
    });

    const enrichedPositions = positions.map((p: any) => {
      const entryPrice = Number(p.entryPrice) || 0;
      const tokenData = tokenMap[p.tokenAddress.toLowerCase()];
      const currentPrice = tokenData?.price || 0;
      const tokenImage = tokenData?.image;
      const amount = Number(p.amount) || 0;
      const entryValueMON = Number(p.entryValueMon) || 0;
      
      const profitUSD = amount * (currentPrice - entryPrice);
      const profitMON = profitUSD / MON_PRICE_USD;
      const currentValueMON = entryValueMON + profitMON;
      const profitPercent = entryValueMON > 0 ? (profitMON / entryValueMON) * 100 : 0;
     
      return {
        id: p.id,
        botId: p.botId,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        tokenImage, 
        amount,
        entryValueMON,
        currentValueMON: Math.round(currentValueMON * 1000) / 1000,
        pnlMON: Math.round(profitMON * 1000) / 1000,
        pnlPercent: Math.round(profitPercent * 10) / 10,
        isOpen: p.isOpen,
        createdAt: p.createdAt,
      };
    });

    console.log("enrichedPositions =====>", enrichedPositions[0]);

    const portfolios = await Promise.all(ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId);
      const botPositions = enrichedPositions.filter((p: any) => p.botId === botId);
      
      const totalInvested = botPositions.reduce((sum: any, p: any) => sum + p.entryValueMON, 0);
      const totalPnlMON = botPositions.reduce((sum: any, p: any) => sum + p.pnlMON, 0);
      const totalCurrentValue = totalInvested + totalPnlMON;
      const totalPnlPercent = totalInvested > 0 ? (totalPnlMON / totalInvested) * 100 : 0;
      
      const wins = botPositions.filter((p: any) => p.pnlMON > 0).length;
      const losses = botPositions.filter((p: any) => p.pnlMON < 0).length;
      
      let balance = 0;
      try {
        balance = await getBotBalance(botId);
      } catch (e) {
        console.error(`Error fetching balance for ${botId}:`, e);
      }
      
      return {
        botId,
        name: config?.name || botId,
        positions: botPositions,
        totalInvested: Math.round(totalInvested * 1000) / 1000,
        totalCurrentValue: Math.round(totalCurrentValue * 1000) / 1000,
        pnlMON: Math.round(totalPnlMON * 1000) / 1000,
        pnlPercent: Math.round(totalPnlPercent * 10) / 10,
        wins,
        losses,
        winRate: botPositions.length > 0 ? Math.round((wins / botPositions.length) * 100) : 0,
        openPositions: botPositions.length,
        monBalance: Math.round(balance * 1000) / 1000,
      };
    }));

    return c.json({ positions: enrichedPositions, portfolios, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching positions:', error);
    return c.json({ error: 'Failed to fetch positions' }, 500);
  }
});

// ============================================================
// BOTS
// ============================================================

app.get('/api/bots', async (c) => {
  try {
    // Get closed positions from DB for win/loss stats
    const allPositions = await prisma.position.findMany();
    const closedPositions = allPositions.filter((p:any) => !p.isOpen);

    const bots = await Promise.all(ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId) as any;
      const walletAddress = getBotWallet(botId);
      
      // Get bot's closed positions for stats
      const botClosedPositions = closedPositions.filter((p:any)  => p.botId === botId);
      const realizedPnl = botClosedPositions.reduce((sum:any, p:any) => sum + (p.pnl ? Number(p.pnl) : 0), 0);
      const wins = botClosedPositions.filter((p:any) => p.pnl && Number(p.pnl) > 0).length;
      const losses = botClosedPositions.filter((p:any) => p.pnl && Number(p.pnl) <= 0).length;

      // Get balance
      let balance = 0;
      try { balance = await getBotBalance(botId); } catch (e) {}

      // Get holdings from API (more reliable than calculating from DB)
      let holdingsValue = 0;
      let openPositions = 0;
      
      if (walletAddress) {
        try {
          const holdings = await getWalletHoldings(walletAddress);
          holdingsValue = holdings.reduce((sum, h) => sum + h.valueMon, 0);
          openPositions = holdings.length;
        } catch (e) {
          console.error(`Error fetching holdings for ${botId}:`, e);
        }
      }

      return {
        botId,
        name: config?.name || botId,
        avatar: config?.avatar || '🤖',
        color: config?.color || '#888',
        walletAddress: walletAddress || null,
        openPositions,
        closedTrades: botClosedPositions.length,
        wins,
        losses,
        winRate: botClosedPositions.length > 0 ? Math.round((wins / botClosedPositions.length) * 100) : 0,
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
        unrealizedPnl: 0, // TODO: calculate from holdings vs entry
        totalPnl: Math.round(realizedPnl * 1000) / 1000,
        balance: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(holdingsValue * 1000) / 1000,
        totalValue: Math.round((balance + holdingsValue) * 1000) / 1000,
      };
    }));

    bots.sort((a, b) => b.totalValue - a.totalValue);
    return c.json({ bots, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching bots:', error);
    return c.json({ error: 'Failed to fetch bots' }, 500);
  }
});



app.get('/api/bots/:botId', async (c) => {
  try {
    const botId = c.req.param('botId') as any;
    const config = getBotConfig(botId);
    if (!config) return c.json({ error: 'Bot not found' }, 404);

    const walletAddress = getBotWallet(botId) as string;
    
    // Get closed positions from DB for stats
    const closedPositions = await prisma.position.findMany({ 
      where: { botId, isOpen: false }, 
      orderBy: { createdAt: 'desc' } 
    });
    
    const realizedPnl = closedPositions.reduce((s:any, p:any) => s + (p.pnl ? Number(p.pnl) : 0), 0);
    const wins = closedPositions.filter((p:any) => p.pnl && Number(p.pnl) > 0).length;

    // Get balance
    let balance = 0;
    try { balance = await getBotBalance(botId); } catch (e) {}

    // Get holdings from API (more reliable)
    let holdings: any[] = [];
    let totalCurrentValue = 0;
    
    if (walletAddress) {
      try {
        const apiHoldings = await getWalletHoldings(walletAddress);
        holdings = apiHoldings.map(h => ({
          tokenSymbol: h.tokenSymbol,
          tokenAddress: h.tokenAddress,
          amount: h.amount,
          currentValue: Math.round(h.valueMon * 1000) / 1000,
          priceUsd: h.priceUsd,
        }));
        totalCurrentValue = apiHoldings.reduce((sum, h) => sum + h.valueMon, 0);
      } catch (e) {
        console.error(`Error fetching holdings for ${botId}:`, e);
      }
    }

    return c.json({
      bot: { 
        id: botId, 
        name: config.name, 
        avatar: config.emoji, 
        color: (config as any).color as any, 
        personality: config.personality,
        walletAddress: walletAddress || null,
      },
      stats: {
        openPositions: holdings.length,
        closedTrades: closedPositions.length,
        wins,
        losses: closedPositions.length - wins,
        winRate: closedPositions.length > 0 ? Math.round((wins / closedPositions.length) * 100) : 0,
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
      },
      balance: { 
        mon: Math.round(balance * 1000) / 1000, 
        holdingsValue: Math.round(totalCurrentValue * 1000) / 1000, 
        totalValue: Math.round((balance + totalCurrentValue) * 1000) / 1000 
      },
      holdings,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching bot:', error);
    return c.json({ error: 'Failed to fetch bot' }, 500);
  }
});

// ============================================================
// STATS
// ============================================================

app.get('/api/stats', async (c) => {
  try {
    const allPositions = await prisma.position.findMany();
    const closedPositions = allPositions.filter((p:any) => !p.isOpen);
    const totalPnl = closedPositions.reduce((s:any, p:any) => s + (p.pnl ? Number(p.pnl) : 0), 0);
    const wins = closedPositions.filter((p:any) => p.pnl && Number(p.pnl) > 0).length;

    return c.json({
      totalTrades: allPositions.length,
      openPositions: allPositions.filter((p:any) => p.isOpen).length,
      closedTrades: closedPositions.length,
      totalPnl: Math.round(totalPnl * 1000) / 1000,
      wins,
      losses: closedPositions.length - wins,
      winRate: closedPositions.length > 0 ? Math.round((wins / closedPositions.length) * 100) : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// ============================================================
// TOKEN ANALYSIS REQUEST — For Council holders
// ============================================================

// Council token address (replace with actual)
const COUNCIL_TOKEN_ADDRESS = process.env.COUNCIL_TOKEN_ADDRESS || '0x0000000000000000000000000000000000000000';

app.post('/api/analyze/request', async (c) => {
  try {
    const body = await c.req.json();
    const { tokenAddress, requestedBy, symbol, name } = body;

    if (!tokenAddress) {
      return c.json({ error: 'Token address required' }, 400);
    }

    // Validate token address format
    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      return c.json({ error: 'Invalid token address format' }, 400);
    }

    // TODO: Verify user holds Council token
    // For now, we'll trust the frontend validation
    // In production, check on-chain balance

    // Import the function to queue token for analysis
    const { queueTokenForAnalysis, getIsAnalyzing } = await import('./services/orchestrator.js');

    // Queue the token with symbol/name from frontend
    const success = await queueTokenForAnalysis(tokenAddress, requestedBy, { symbol, name });

    if (!success) {
      return c.json({ error: 'Failed to queue token for analysis' }, 500);
    }

    // Log the request
    const wasAnalyzing = getIsAnalyzing();
    console.log(`👑 Analysis requested by ${requestedBy} for $${symbol || tokenAddress}${wasAnalyzing ? ' (INTERRUPTING)' : ''}`);

    return c.json({ 
      success: true, 
      message: wasAnalyzing ? 'Interrupting current analysis...' : 'Token queued for analysis',
      interrupted: wasAnalyzing,
      tokenAddress,
      symbol,
      requestedBy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing analysis request:', error);
    return c.json({ error: 'Failed to process request' }, 500);
  }
});

// Check if user holds Council token
app.get('/api/holder/check/:address', async (c) => {
  try {
    const address = c.req.param('address');
    
    // TODO: Check on-chain if user holds Council token
    // For now, return true for testing
    const isHolder = true; // Replace with actual check
    const balance = 1000; // Replace with actual balance

    return c.json({
      address,
      isHolder,
      balance,
      councilToken: COUNCIL_TOKEN_ADDRESS,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error checking holder status:', error);
    return c.json({ error: 'Failed to check holder status' }, 500);
  }
});
app.route('/api/agents', agentsRouter);
// ============================================================
// USER TRADE NOTIFICATION — Bots react when users buy
// ============================================================

app.post('/api/trade/notify', async (c) => {
  try {
    const body = await c.req.json();
    const { userAddress, tokenAddress, tokenSymbol, amountMon, amountTokens, txHash } = body;

    if (!userAddress || !tokenAddress || !tokenSymbol) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    // Import the handler
    const { handleUserTrade } = await import('./services/orchestrator.js');

    // Trigger bot reactions
    await handleUserTrade({
      userAddress,
      tokenAddress,
      tokenSymbol,
      amountMon: parseFloat(amountMon) || 0,
      amountTokens: parseFloat(amountTokens) || 0,
      txHash: txHash || '',
    });

    console.log(`💰 User trade notified: ${userAddress} bought $${tokenSymbol}`);

    return c.json({ 
      success: true, 
      message: 'Trade notification received',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing trade notification:', error);
    return c.json({ error: 'Failed to process trade notification' }, 500);
  }
});

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║   🏛️  THE COUNCIL                                         ║
  ║   5 AI Traders. 1 Mission. Infinite Degen Energy.        ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  const requiredEnvVars = ['XAI_API_KEY'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) { console.error('❌ Missing:', missing.join(', ')); process.exit(1); }

  try {
    console.log('📦 Initializing database...');
    await initDatabase();

    console.log(`🌐 Starting HTTP server on port ${HTTP_PORT}...`);
    serve({ fetch: app.fetch, port: HTTP_PORT });
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
  console.log('\n🛑 Shutting down...');
  closeWebSocket();
  await closeDatabase();
  console.log('👋 Goodbye.');
}

process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
startPriceUpdater();
startImageUpdater();
startPredictionsResolver();
main().catch(console.error);