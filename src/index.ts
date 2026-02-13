import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  initDatabase,
  closeDatabase,
  prisma,
  createPosition,
} from "./db/index.js";
import {
  initWebSocketWithServer,
  closeWebSocket,
  broadcastNewToken,
  broadcastTrade,
  broadcastMessage,
} from "./services/websocket.js";
import { startOrchestrator } from "./services/orchestrator.js";
import { getCurrentToken, getRecentMessages } from "./services/messageBus.js";
import {
  getTokenByAddress,
  getWalletBalance,
  getWalletHoldings,
} from "./services/nadfun.js";
import { getBotConfig, ALL_BOT_IDS } from "./bots/personalities.js";
import { getBotBalance, getBotWallet } from "./services/trading.js";
import { startPredictionsResolver } from "./jobs/prediction-resolver.js";
import { getRecentMessages as getRecentMessagesFromDB } from "./db/index.js";
import { startPriceUpdater } from "./jobs/price-updater.js";
import { startImageUpdater } from "./jobs/image-updater.js";
import agentsRouter from "./routes/agents.js";
import { randomUUID } from "node:crypto";
import { startDailyRecap } from "./jobs/daily-recap.js";
import { initTwitter } from "./twitter/main.js";

// ============================================================
// CONFIG — Railway uses PORT env var
// ============================================================

const PORT = parseInt(process.env.PORT || "3005", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ============================================================
// HONO APP
// ============================================================

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  }),
);

// ============================================================
// CURRENT STATE
// ============================================================

app.get("/api/current-token", async (c) => {
  const token = getCurrentToken();
  let messages = await getRecentMessagesFromDB(50);
  return c.json({
    token: token || null,
    messages: messages || [],
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// TRADES
// ============================================================

app.get("/api/trades", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "50");
    const positions = await prisma.position.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const trades = await Promise.all(
      positions.map(async (p: any) => {
        const entryValue = Number(p.entryValueMon) || 0;
        let botName = p.botId;
        let botAvatar = "🤖";
        let botColor = "#888";

        if (p.botId.startsWith("agent_")) {
          // Fetch agent info from DB
          const agentId = p.botId.replace("agent_", "");
          const agent = await prisma.agent.findUnique({
            where: { id: agentId },
          });
          if (agent) {
            botName = agent.name;
            botAvatar = agent.avatar || "🤖";
            botColor = agent.color || "#06b6d4";
          }
        } else {
          const config = getBotConfig(p.botId as any) as any;
          if (config) {
            botName = config.name;
            botAvatar = config.emoji || "🤖";
            botColor = config.color || "#888";
          }
        }

        return {
          id: p.id,
          botId: p.botId,
          botName,
          botAvatar,
          botColor,
          isAgent: p.botId.startsWith("agent_"),
          tokenAddress: p.tokenAddress,
          tokenSymbol: p.tokenSymbol,
          amount: Number(p.amount),
          entryPrice: Number(p.entryPrice),
          entryValue: Math.round(entryValue * 1000) / 1000,
          pnl: p.pnl ? Math.round(Number(p.pnl) * 1000) / 1000 : 0,
          isOpen: p.isOpen,
          createdAt: p.createdAt,
          txHash: p.entryTxHash,
        };
      }),
    );

    return c.json({
      trades,
      count: trades.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching trades:", error);
    return c.json({ error: "Failed to fetch trades" }, 500);
  }
});

app.get("/api/trades/live", async (c) => {
  try {
    const since = c.req.query("since");
    const where: any = {};
    if (since) where.createdAt = { gt: new Date(since) };

    const positions = await prisma.position.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const agents = await prisma.agent.findMany({
      where: { trades: { some: {} } },
      include: { trades: { orderBy: { createdAt: "desc" }, take: 20 } },
    });

    const agentTradesFlat = agents.flatMap((agent: any) =>
      agent.trades.map((trade: any) => ({
        ...trade,
        name: agent.name,
        agentAvatar: agent.avatar || "🤖",
        agentColor: agent.color || "#06b6d4",
        isAgent: true,
      })),
    );

    const trades = [...positions, ...agentTradesFlat]
      .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p: any) => {
        const config = getBotConfig(p.botId as any) as any;
        return {
          id: p.id,
          botId: p.botId,
          botName: config?.name || p?.name || p.botId,
          botAvatar: config?.emoji || p?.agentAvatar || "🤖",
          botColor: config?.color || p?.agentColor || "#888",
          tokenSymbol: p.tokenSymbol,
          tokenAddress: p.tokenAddress,
          amount: Number(p.amount || p.amountIn),
          valueMon:
            Math.round(Number(p.entryValueMon || p.amountIn) * 1000) / 1000,
          createdAt: p.createdAt,
          txHash: p.entryTxHash || p.txHash,
        };
      });

    return c.json({ trades, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Error fetching live trades:", error);
    return c.json({ error: "Failed to fetch trades" }, 500);
  }
});

// ============================================================
// TOKENS
// ============================================================

app.get("/api/trades/:tokenAddress", async (c) => {
  try {
    const tokenAddress = c.req.param("tokenAddress");

    // Get bot positions for this token
    const positions = await prisma.position.findMany({
      where: { tokenAddress },
      orderBy: { createdAt: "asc" },
    });

    // Get agent trades for this token
    const agentTrades = await prisma.agentTrade.findMany({
      where: { tokenAddress },
      orderBy: { createdAt: "asc" },
      include: { agent: { select: { name: true, avatar: true, color: true } } },
    });

    const trades = [
      ...positions.map((p: any) => {
        const config = getBotConfig(p.botId as any) as any;
        const isHuman = p.botId.startsWith("human_");
        return {
          id: p.id,
          botId: p.botId,
          botName:
            config?.name || (isHuman ? p.botId.slice(6, 12) + "..." : p.botId),
          botColor: config?.color || (isHuman ? "#06b6d4" : "#888"),
          botEmoji: config?.emoji || (isHuman ? "👤" : "🤖"),
          side: "buy" as const,
          amount: Number(p.amount),
          valueMon: Number(p.entryValueMon) || 0,
          price: Number(p.entryPrice),
          txHash: p.entryTxHash,
          timestamp: p.createdAt.getTime() / 1000, // Unix seconds for TradingView
          createdAt: p.createdAt,
        };
      }),
      ...agentTrades.map((t: any) => ({
        id: t.id,
        botId: `agent_${t.agentId}`,
        botName: t.agent?.name || "Agent",
        botColor: t.agent?.color || "#06b6d4",
        botEmoji: t.agent?.avatar || "🤖",
        side: t.side as "buy" | "sell",
        amount: t.amountOut,
        valueMon: t.amountIn,
        price: t.amountIn > 0 && t.amountOut > 0 ? t.amountIn / t.amountOut : 0,
        txHash: t.txHash,
        timestamp: t.createdAt.getTime() / 1000,
        createdAt: t.createdAt,
      })),
    ].sort((a, b) => a.timestamp - b.timestamp);

    return c.json({
      trades,
      count: trades.length,
      tokenAddress,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching token trades:", error);
    return c.json({ error: "Failed to fetch token trades" }, 500);
  }
});

app.get("/api/tokens", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "50");
    const tokens = await prisma.token.findMany({
      orderBy: { updatedAt: "desc" },
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
      riskFlags: (t.analysis as any)?.flags || null,
      opinions: (t.analysis as any)?.opinions || null,
      analyzedAt: t.updatedAt,
    }));

    return c.json({
      tokens: enrichedTokens,
      count: enrichedTokens.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching tokens:", error);
    return c.json({ error: "Failed to fetch tokens" }, 500);
  }
});

app.get("/api/tokens/verdicts", async (c) => {
  try {
    const tokens = await prisma.token.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    const buys = tokens.filter((t: any) => t.verdict === "buy");
    const passes = tokens.filter((t: any) => t.verdict === "pass");

    return c.json({
      summary: {
        total: tokens.length,
        buys: buys.length,
        passes: passes.length,
        buyRate:
          tokens.length > 0
            ? Math.round((buys.length / tokens.length) * 100)
            : 0,
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
    console.error("Error fetching verdicts:", error);
    return c.json({ error: "Failed to fetch verdicts" }, 500);
  }
});

app.get("/api/tokens/analysis/:address", async (c) => {
  try {
    const address = c.req.param("address");
    const token = await prisma.token.findUnique({ where: { address } });
    if (!token) return c.json({ error: "Token not found" }, 404);

    const positions = await prisma.position.findMany({
      where: { tokenAddress: address },
      orderBy: { createdAt: "desc" },
    });

    const botsInvested = positions
      .filter((p: any) => p.isOpen)
      .map((p: any) => {
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
    console.error("Error fetching token:", error);
    return c.json({ error: "Failed to fetch token" }, 500);
  }
});

// ============================================================
// POSITIONS
// ============================================================

app.get("/api/positions", async (c) => {
  try {
    const res = await fetch(
      "https://api.nadapp.net/trade/market/0x350035555E10d9AfAF1566AaebfCeD5BA6C27777",
    );
    const dataMon = await res.json();
    const MON_PRICE_USD = dataMon?.market_info?.native_price || 0.01795;

    const positions = await prisma.position.findMany({
      where: { isOpen: true },
      orderBy: { createdAt: "desc" },
    });

    const tokenAddresses = [
      ...new Set(positions.map((p: any) => p.tokenAddress)),
    ];
    const tokens = await prisma.token.findMany({
      where: { address: { in: tokenAddresses } },
      select: { address: true, price: true, image: true },
    });

    const tokenMap: Record<string, { price: number; image: string | null }> =
      {};
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
      const profitPercent =
        entryValueMON > 0 ? (profitMON / entryValueMON) * 100 : 0;

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

    const portfolios = await Promise.all(
      ALL_BOT_IDS.map(async (botId) => {
        const config = getBotConfig(botId);
        const botPositions = enrichedPositions.filter(
          (p: any) => p.botId === botId,
        );

        const totalInvested = botPositions.reduce(
          (sum: any, p: any) => sum + p.entryValueMON,
          0,
        );
        const totalPnlMON = botPositions.reduce(
          (sum: any, p: any) => sum + p.pnlMON,
          0,
        );
        const totalCurrentValue = totalInvested + totalPnlMON;
        const totalPnlPercent =
          totalInvested > 0 ? (totalPnlMON / totalInvested) * 100 : 0;

        const wins = botPositions.filter((p: any) => p.pnlMON > 0).length;
        const losses = botPositions.filter((p: any) => p.pnlMON < 0).length;

        let balance = 0;
        try {
          balance = await getBotBalance(botId);
        } catch (e) {}

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
          winRate:
            botPositions.length > 0
              ? Math.round((wins / botPositions.length) * 100)
              : 0,
          openPositions: botPositions.length,
          monBalance: Math.round(balance * 1000) / 1000,
        };
      }),
    );

    return c.json({
      positions: enrichedPositions,
      portfolios,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching positions:", error);
    return c.json({ error: "Failed to fetch positions" }, 500);
  }
});

// Add this to server.ts after the agents router section

// ============================================================
// TELEGRAM CHAT — Users talk to bots via Telegram
// ============================================================

app.post("/api/telegram/chat", async (c) => {
  try {
    const body = await c.req.json();
    const { message, username, targetBotId } = body;

    if (!message) return c.json({ error: "Message required" }, 400);

    const { postMessage, getCurrentToken, getRecentMessages } =
      await import("./services/messageBus.js");
    const { getBotConfig } = await import("./bots/personalities.js");
    const OpenAI = (await import("openai")).default;

    const displayName = username || "anon";

    // 1) Broadcast user message so frontend sees it
    await postMessage(`tg_${displayName}` as any, message);

    // 2) Pick which bot responds
    let respondingBotId = targetBotId;

    if (!respondingBotId || !getBotConfig(respondingBotId)) {
      const weights = {
        chad: 0.35,
        quantum: 0.2,
        sensei: 0.2,
        sterling: 0.15,
        oracle: 0.1,
      };
      const rand = Math.random();
      let cumulative = 0;
      for (const [botId, weight] of Object.entries(weights)) {
        cumulative += weight;
        if (rand < cumulative) {
          respondingBotId = botId;
          break;
        }
      }
      respondingBotId = respondingBotId || "chad";
    }

    const config = getBotConfig(respondingBotId as any);
    if (!config) return c.json({ error: "Bot not found" }, 404);

    // 3) Build context
    const token = getCurrentToken();
    const recentMessages = getRecentMessages(8);

    let chatLog = "";
    for (const m of recentMessages.slice(-6)) {
      const name = getBotConfig(m.botId as any)?.name || m.botId;
      chatLog += `${name}: ${m.content}\n`;
    }
    chatLog += `${displayName}: ${message}\n`;

    // 4) Generate response with custom prompt that includes user's name
    const openai = new OpenAI({
      apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });

    const tokenContext = token
      ? `Current token: $${token.symbol} | ${(token.mcap / 1000).toFixed(1)}K mcap | ${token.holders} holders`
      : "No token being analyzed right now.";

    const systemPrompt = `You are ${config.name}, an AI crypto trader in The Council group chat on Telegram.

Your personality: ${config.personality}

ABOUT THE COUNCIL:
The Council is an autonomous AI trading system on Monad. 5 AI agents (James, Keone, Portdev, Harpal, Mike) scan ALL memecoins on nad.fun 24/7 — not just AI tokens, not just one category. Every token listed on nad.fun is fair game. The bots run a full analysis pipeline: market data, risk assessment, community signals, liquidity checks, and Twitter sentiment. Then they debate, vote, and execute real onchain trades with real MON.

Users can:
- Watch the bots debate and trade live on the frontend
- Swap tokens alongside the bots
- Hold $COUNCIL token to request analysis on any specific token
- Place prediction bets on which bot performs best
- External AI agents can join via the API (0.1 MON entry fee)

${tokenContext}

Recent chat:
${chatLog}

A user named "${displayName}" just sent a message. Reply to them.

RULES:
- MAX 40 words
- If they ask about how The Council works, what it does, or what tokens it scans — answer factually FIRST, then give your opinion
- The Council scans ALL tokens on nad.fun, not just a specific category
- Actually answer their question with real info/opinion
- Mention ${displayName} by name once at the start
- Stay casual but informative — you're a knowledgeable trader, not a hype bot
- If they ask about a specific token, reference actual data (mcap, liquidity, holders)
- NO empty hype like "lfg" or "apin'" unless genuinely relevant
- NO formal language like "assessment", "indicates", "concerning"`;

    const aiResponse = await openai.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${displayName} says: "${message}"` },
      ],
      max_tokens: 100,
      temperature: 0.9,
    });

    let response = aiResponse.choices[0]?.message?.content?.trim() || "";

    // Clean up any tags that might slip through
    response = response
      .replace(/\[BULLISH\]/g, "")
      .replace(/\[BEARISH\]/g, "")
      .replace(/\[NEUTRAL\]/g, "")
      .replace(/\[CONFIDENCE:\s*\d+\]/g, "")
      .trim();

    if (!response) {
      response = `yo ${displayName}, lemme think on that one`;
    }

    // 5) Broadcast bot response
    await postMessage(respondingBotId as any, response);

    console.log(
      `💬 TG @${displayName} → ${config.name}: "${response.slice(0, 60)}"`,
    );

    return c.json({
      success: true,
      botId: respondingBotId,
      botName: config.name,
      response,
    });
  } catch (error) {
    console.error("Error in telegram chat:", error);
    return c.json({ error: "Failed to generate response" }, 500);
  }
});

// ============================================================
// LEADERBOARD — Humans + Agents ranked by PnL %
// ============================================================

app.get("/api/leaderboard", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const minHoldMon = parseFloat(c.req.query("minHold") || "0");

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const where: any = {};
    if (from || to) where.createdAt = dateFilter;

    // Fetch MON price
    const res = await fetch(
      "https://api.nadapp.net/trade/market/0x350035555E10d9AfAF1566AaebfCeD5BA6C27777",
    );
    const dataMon = await res.json();
    const MON_PRICE_USD = dataMon?.market_info?.native_price || 0.01795;

    // Get all positions
    const positions = await prisma.position.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    // Get current token prices
    const tokenAddresses = [
      ...new Set(positions.map((p: any) => p.tokenAddress)),
    ];
    const tokens = await prisma.token.findMany({
      where: { address: { in: tokenAddresses } },
      select: { address: true, price: true },
    });
    const priceMap: Record<string, number> = {};
    tokens.forEach((t: any) => {
      priceMap[t.address.toLowerCase()] = t.price || 0;
    });

    // Get agent trades
    const agentTrades = await prisma.agentTrade.findMany({
      where: from || to ? { createdAt: dateFilter } : {},
      include: { agent: { select: { name: true, avatar: true, color: true } } },
    });

    // Add agent trade token addresses to priceMap
    const agentTokenAddresses = [
      ...new Set(agentTrades.map((t: any) => t.tokenAddress)),
    ];
    const agentTokens = await prisma.token.findMany({
      where: { address: { in: agentTokenAddresses } },
      select: { address: true, price: true },
    });
    agentTokens.forEach((t: any) => {
      priceMap[t.address.toLowerCase()] = t.price || 0;
    });

    const traders = new Map<
      string,
      {
        id: string;
        name: string;
        avatar: string;
        color: string;
        type: "human" | "agent" | "bot";
        totalInvested: number;
        totalCurrentValue: number;
        trades: number;
        wins: number;
        losses: number;
        positions: Array<{
          symbol: string;
          pnlPercent: number;
          valueMon: number;
        }>;
      }
    >();

    // Process ALL positions (core bots + humans + agents)
    for (const p of positions) {
      const botId = p.botId;
      const entryValueMON = Number(p.entryValueMon) || 0;
      if (entryValueMON < minHoldMon) continue;

      const currentPrice = priceMap[p.tokenAddress.toLowerCase()] || 0;
      const entryPrice = Number(p.entryPrice) || 0;
      const amount = Number(p.amount) || 0;
      const profitUSD = amount * (currentPrice - entryPrice);
      const profitMON = profitUSD / MON_PRICE_USD;
      const currentValueMON = entryValueMON + profitMON;

      if (!traders.has(botId)) {
        const isHuman = botId.startsWith("human_");
        const isAgent = botId.startsWith("agent_");

        let name = botId;
        let avatar = "🤖";
        let color = "#888";
        let type: "human" | "agent" | "bot" = "bot";

        if (isHuman) {
          const addr = botId.replace("human_", "");
          name = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
          avatar = "👤";
          color = "#06b6d4";
          type = "human";
        } else if (isAgent) {
          const agentId = botId.replace("agent_", "");
          const agent = await prisma.agent.findUnique({
            where: { id: agentId },
          });
          if (agent) {
            name = agent.name;
            avatar = agent.avatar || "🤖";
            color = agent.color || "#06b6d4";
          }
          type = "agent";
        } else {
          // Core bot
          const config = getBotConfig(botId as any) as any;
          if (config) {
            name = config.name;
            avatar = config.emoji || "🤖";
            color = config.color || "#888";
          }
          type = "bot";
        }

        traders.set(botId, {
          id: botId,
          name,
          avatar,
          color,
          type,
          totalInvested: 0,
          totalCurrentValue: 0,
          trades: 0,
          wins: 0,
          losses: 0,
          positions: [],
        });
      }

      const trader = traders.get(botId)!;
      trader.totalInvested += entryValueMON;
      trader.totalCurrentValue += currentValueMON;
      trader.trades++;
      if (profitMON > 0) trader.wins++;
      else trader.losses++;
      trader.positions.push({
        symbol: p.tokenSymbol,
        pnlPercent: entryValueMON > 0 ? (profitMON / entryValueMON) * 100 : 0,
        valueMon: Math.round(entryValueMON * 1000) / 1000,
      });
    }

    // Process agent trades (from executeAgentTradeWithPK)
    for (const t of agentTrades) {
      const traderId = `agent_${t.agentId}`;
      const entryValueMON = t.amountIn;
      if (entryValueMON < minHoldMon) continue;

      const currentPrice = priceMap[t.tokenAddress.toLowerCase()] || 0;
      const amountOut = t.amountOut;
      const currentValueMON = (amountOut * currentPrice) / MON_PRICE_USD;

      if (!traders.has(traderId)) {
        traders.set(traderId, {
          id: traderId,
          name: t.agent?.name || "Agent",
          avatar: t.agent?.avatar || "🤖",
          color: t.agent?.color || "#06b6d4",
          type: "agent",
          totalInvested: 0,
          totalCurrentValue: 0,
          trades: 0,
          wins: 0,
          losses: 0,
          positions: [],
        });
      }

      const trader = traders.get(traderId)!;
      trader.totalInvested += entryValueMON;
      trader.totalCurrentValue += currentValueMON;
      trader.trades++;
      const pnl = currentValueMON - entryValueMON;
      if (pnl > 0) trader.wins++;
      else trader.losses++;
      trader.positions.push({
        symbol: t.tokenSymbol,
        pnlPercent: entryValueMON > 0 ? (pnl / entryValueMON) * 100 : 0,
        valueMon: Math.round(entryValueMON * 1000) / 1000,
      });
    }

    // Build leaderboard sorted by PnL %
    const leaderboard = Array.from(traders.values())
      .map((t) => {
        const pnlMon = t.totalCurrentValue - t.totalInvested;
        const pnlPercent =
          t.totalInvested > 0 ? (pnlMon / t.totalInvested) * 100 : 0;
        return {
          rank: 0,
          id: t.id,
          name: t.name,
          avatar: t.avatar,
          color: t.color,
          type: t.type,
          trades: t.trades,
          wins: t.wins,
          losses: t.losses,
          winRate: t.trades > 0 ? Math.round((t.wins / t.trades) * 100) : 0,
          totalInvested: Math.round(t.totalInvested * 1000) / 1000,
          totalCurrentValue: Math.round(t.totalCurrentValue * 1000) / 1000,
          pnlMon: Math.round(pnlMon * 1000) / 1000,
          pnlPercent: Math.round(pnlPercent * 10) / 10,
          topPositions: t.positions
            .sort((a, b) => b.pnlPercent - a.pnlPercent)
            .slice(0, 3),
        };
      })
      .sort((a, b) => b.pnlPercent - a.pnlPercent);

    leaderboard.forEach((entry, i) => {
      entry.rank = i + 1;
    });

    return c.json({
      leaderboard,
      count: leaderboard.length,
      filters: {
        from: from || null,
        to: to || null,
        minHoldMon,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    return c.json({ error: "Failed to fetch leaderboard" }, 500);
  }
});

// ============================================================
// BOTS
// ============================================================

app.get("/api/bots", async (c) => {
  try {
    const allPositions = await prisma.position.findMany();
    const closedPositions = allPositions.filter((p: any) => !p.isOpen);

    const bots = await Promise.all(
      ALL_BOT_IDS.map(async (botId) => {
        const config = getBotConfig(botId) as any;
        const walletAddress = getBotWallet(botId);

        const botClosedPositions = closedPositions.filter(
          (p: any) => p.botId === botId,
        );
        const realizedPnl = botClosedPositions.reduce(
          (sum: any, p: any) => sum + (p.pnl ? Number(p.pnl) : 0),
          0,
        );
        const wins = botClosedPositions.filter(
          (p: any) => p.pnl && Number(p.pnl) > 0,
        ).length;
        const losses = botClosedPositions.filter(
          (p: any) => p.pnl && Number(p.pnl) <= 0,
        ).length;

        let balance = 0;
        try {
          balance = await getBotBalance(botId);
        } catch (e) {}

        let holdingsValue = 0;
        let openPositions = 0;

        if (walletAddress) {
          try {
            const holdings = await getWalletHoldings(walletAddress);
            holdingsValue = holdings.reduce((sum, h) => sum + h.valueMon, 0);
            openPositions = holdings.length;
          } catch (e) {}
        }

        return {
          botId,
          name: config?.name || botId,
          avatar: config?.avatar || "🤖",
          color: config?.color || "#888",
          walletAddress: walletAddress || null,
          openPositions,
          closedTrades: botClosedPositions.length,
          wins,
          losses,
          winRate:
            botClosedPositions.length > 0
              ? Math.round((wins / botClosedPositions.length) * 100)
              : 0,
          realizedPnl: Math.round(realizedPnl * 1000) / 1000,
          unrealizedPnl: 0,
          totalPnl: Math.round(realizedPnl * 1000) / 1000,
          balance: Math.round(balance * 1000) / 1000,
          holdingsValue: Math.round(holdingsValue * 1000) / 1000,
          totalValue: Math.round((balance + holdingsValue) * 1000) / 1000,
        };
      }),
    );

    bots.sort((a, b) => b.totalValue - a.totalValue);
    return c.json({ bots, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Error fetching bots:", error);
    return c.json({ error: "Failed to fetch bots" }, 500);
  }
});

app.get("/api/bots/:botId", async (c) => {
  try {
    const botId = c.req.param("botId") as any;
    const config = getBotConfig(botId);
    if (!config) return c.json({ error: "Bot not found" }, 404);

    const walletAddress = getBotWallet(botId) as string;

    const closedPositions = await prisma.position.findMany({
      where: { botId, isOpen: false },
      orderBy: { createdAt: "desc" },
    });

    const realizedPnl = closedPositions.reduce(
      (s: any, p: any) => s + (p.pnl ? Number(p.pnl) : 0),
      0,
    );
    const wins = closedPositions.filter(
      (p: any) => p.pnl && Number(p.pnl) > 0,
    ).length;

    let balance = 0;
    try {
      balance = await getBotBalance(botId);
    } catch (e) {}

    let holdings: any[] = [];
    let totalCurrentValue = 0;

    if (walletAddress) {
      try {
        const apiHoldings = await getWalletHoldings(walletAddress);
        holdings = apiHoldings.map((h) => ({
          tokenSymbol: h.tokenSymbol,
          tokenAddress: h.tokenAddress,
          amount: h.amount,
          currentValue: Math.round(h.valueMon * 1000) / 1000,
          priceUsd: h.priceUsd,
        }));
        totalCurrentValue = apiHoldings.reduce((sum, h) => sum + h.valueMon, 0);
      } catch (e) {}
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
        winRate:
          closedPositions.length > 0
            ? Math.round((wins / closedPositions.length) * 100)
            : 0,
        realizedPnl: Math.round(realizedPnl * 1000) / 1000,
      },
      balance: {
        mon: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(totalCurrentValue * 1000) / 1000,
        totalValue: Math.round((balance + totalCurrentValue) * 1000) / 1000,
      },
      holdings,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching bot:", error);
    return c.json({ error: "Failed to fetch bot" }, 500);
  }
});

// ============================================================
// STATS
// ============================================================

app.get("/api/stats", async (c) => {
  try {
    const allPositions = await prisma.position.findMany();
    const closedPositions = allPositions.filter((p: any) => !p.isOpen);
    const totalPnl = closedPositions.reduce(
      (s: any, p: any) => s + (p.pnl ? Number(p.pnl) : 0),
      0,
    );
    const wins = closedPositions.filter(
      (p: any) => p.pnl && Number(p.pnl) > 0,
    ).length;

    return c.json({
      totalTrades: allPositions.length,
      openPositions: allPositions.filter((p: any) => p.isOpen).length,
      closedTrades: closedPositions.length,
      totalPnl: Math.round(totalPnl * 1000) / 1000,
      wins,
      losses: closedPositions.length - wins,
      winRate:
        closedPositions.length > 0
          ? Math.round((wins / closedPositions.length) * 100)
          : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});

// ============================================================
// TOKEN ANALYSIS REQUEST
// ============================================================

const COUNCIL_TOKEN_ADDRESS =
  process.env.COUNCIL_TOKEN_ADDRESS ||
  "0x0000000000000000000000000000000000000000";

// server.ts — /api/analyze/request — REPLACE the retry logic

app.post("/api/analyze/request", async (c) => {
  try {
    const body = await c.req.json();
    const { tokenAddress, requestedBy, tokenData } = body;

    if (!tokenAddress) return c.json({ error: "Token address required" }, 400);
    if (!tokenAddress.match(/^0x[a-fA-F0-9]{40}$/))
      return c.json({ error: "Invalid token address format" }, 400);

    // Use frontend-provided data if available
    let token =
      tokenData && tokenData.symbol
        ? {
            ...tokenData,
            createdAt:
              tokenData.createdAt instanceof Date
                ? tokenData.createdAt
                : new Date(tokenData.createdAt || 0),
            priceChange24h: tokenData.priceChange24h || 0,
            holders: tokenData.holders || 0,
            deployer: tokenData.deployer || "",
          }
        : await getTokenByAddress(tokenAddress);

    // Quick fallback if no data provided and fetch failed
    if (!token) {
      await new Promise((r) => setTimeout(r, 2000));
      token = await getTokenByAddress(tokenAddress);
    }

    if (!token) {
      return c.json({ error: "Token not found" }, 404);
    }

    // Ensure address is set
    token.address = tokenAddress;

    const { queueTokenForAnalysis, getIsAnalyzing } =
      await import("./services/orchestrator.js");
    const wasAnalyzing = getIsAnalyzing();
    const success = await queueTokenForAnalysis(
      token.address,
      requestedBy,
      token,
    );

    if (!success) return c.json({ error: "Failed to queue token" }, 500);

    console.log(
      `👑 Analysis requested by ${requestedBy} for $${token.symbol}${wasAnalyzing ? " (INTERRUPTING)" : ""}`,
    );

    return c.json({
      success: true,
      message: wasAnalyzing
        ? "Interrupting current analysis..."
        : "Token queued for analysis",
      interrupted: wasAnalyzing,
      tokenAddress: token.address,
      symbol: token.symbol,
    });
  } catch (error) {
    console.error("Error processing analysis request:", error);
    return c.json({ error: "Failed to process request" }, 500);
  }
});

app.get("/api/holder/check/:address", async (c) => {
  try {
    const address = c.req.param("address");
    const isHolder = true;
    const balance = 1000;

    return c.json({
      address,
      isHolder,
      balance,
      councilToken: COUNCIL_TOKEN_ADDRESS,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error checking holder status:", error);
    return c.json({ error: "Failed to check holder status" }, 500);
  }
});

// ============================================================
// AGENTS ROUTER
// ============================================================

app.route("/api/agents", agentsRouter);

// ============================================================
// USER TRADE NOTIFICATION
// ============================================================

app.post("/api/trade/notify", async (c) => {
  try {
    const body = await c.req.json();
    const {
      userAddress,
      tokenAddress,
      tokenSymbol,
      amountMon,
      amountTokens,
      txHash,
    } = body;

    if (!userAddress || !tokenAddress || !tokenSymbol) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Consistent botId everywhere
    const botId = `human_${userAddress}`;
    const displayName = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;

    const tokenData = await prisma.token.findUnique({
      where: { address: tokenAddress },
      select: { price: true },
    });

    const { handleUserTrade } = await import("./services/orchestrator.js");

    await handleUserTrade({
      userAddress,
      tokenAddress,
      tokenSymbol,
      amountMon: parseFloat(amountMon) || 0,
      amountTokens: parseFloat(amountTokens) || 0,
      txHash: txHash || "",
    });

    broadcastTrade({
      id: txHash || randomUUID(),
      botId: botId as any,
      tokenAddress,
      tokenSymbol,
      side: "buy",
      amountIn: parseFloat(amountMon) || 0,
      amountOut: parseFloat(amountTokens) || 0,
      price: tokenData?.price || 0,
      txHash: txHash || "",
      status: "confirmed",
      createdAt: new Date(),
    });

    await createPosition({
      botId: botId as any,
      tokenAddress,
      tokenSymbol,
      amount: parseFloat(amountTokens) || 0,
      entryPrice: tokenData?.price || 0,
      entryTxHash: txHash || "",
      entryValueMon: parseFloat(amountMon) || 0,
    });

    console.log(
      `💰 User trade notified: ${displayName} bought $${tokenSymbol}`,
    );

    return c.json({
      success: true,
      message: "Trade notification received",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error processing trade notification:", error);
    return c.json({ error: "Failed to process trade notification" }, 500);
  }
});

app.post("/api/twitter/recap", async (c) => {
  try {
    const { runDailyRecap } = await import("./jobs/daily-recap.js");
    await runDailyRecap();
    return c.json({ success: true, message: "Daily recap posted" });
  } catch (error) {
    console.error("Error posting recap:", error);
    return c.json({ error: "Failed to post recap" }, 500);
  }
});

// ============================================================
// MAIN — Combined HTTP + WebSocket on same port for Railway
// ============================================================

async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║   🏛️  THE COUNCIL                                         ║
  ║   5 AI Traders. 1 Mission. Infinite Degen Energy.        ║
  ╚═══════════════════════════════════════════════════════════╝
  `);
  console.log("🚀 Starting The Council Backend...");
  console.log(`   PORT: ${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(
    `   DATABASE_URL: ${process.env.DATABASE_URL ? "✅ Set" : "❌ Missing"}`,
  );
  console.log(
    `   XAI_API_KEY: ${process.env.XAI_API_KEY ? "✅ Set" : "❌ Missing"}`,
  );

  const requiredEnvVars = ["XAI_API_KEY"];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error("❌ Missing:", missing.join(", "));
    process.exit(1);
  }

  try {
    console.log("📦 Initializing database...");
    await initDatabase();

    console.log(`🚀 Starting server on port ${PORT}...`);

    // Start HTTP server and get the underlying Node.js server
    const server = serve(
      {
        fetch: app.fetch,
        port: PORT,
      },
      (info) => {
        console.log(`✅ HTTP API running on port ${info.port}`);
      },
    );

    // Attach WebSocket to the SAME server (required for Railway)
    console.log(`🔌 Attaching WebSocket to HTTP server...`);
    initWebSocketWithServer(server as any);

    console.log(`✅ Server ready:`);
    console.log(`   HTTP: http://localhost:${PORT}`);
    console.log(`   WS:   ws://localhost:${PORT}`);

    if (IS_PRODUCTION) {
      console.log(`   Mode: PRODUCTION`);
    }
    const twitterEnabled = initTwitter();
    // Start background jobs
    console.log("⏰ Starting background jobs...");
    startPriceUpdater();
    startImageUpdater();
    startPredictionsResolver();
    if (twitterEnabled) {
      startDailyRecap();
    }
    // Start orchestrator
    console.log("🤖 Starting bot orchestrator...");
    await startOrchestrator();
  } catch (error) {
    console.error("❌ Fatal error:", error);
    await shutdown();
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  console.log("\n🛑 Shutting down...");
  closeWebSocket();
  await closeDatabase();
  console.log("👋 Goodbye.");
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

main().catch(console.error);
