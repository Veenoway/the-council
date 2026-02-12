// ============================================================
// AGENT API ROUTES
// ============================================================

import { Hono } from "hono";
import {
  registerAgent,
  authenticateAgent,
  agentSpeak,
  agentVote,
  getActiveAgents,
  getAgentLeaderboard,
  getVoteWindowStatus,
  getAgentById,
  executeAgentTradeWithPK,
  agentClaimWinnings,
  agentPlaceBet,
  agentRequestAnalysis,
  agentHoldsCouncilToken,
  getAgentCouncilBalance,
  agentBuyCouncilToken,
} from "../services/hub/agent-hub.js";
import { prisma } from "../db/index.js";
import { getCurrentToken } from "../services/messageBus.js";

const agentsRouter = new Hono();

// ============================================================
// MIDDLEWARE - API Key Authentication
// ============================================================

async function authMiddleware(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = authHeader.slice(7);
  const agent = await authenticateAgent(apiKey);

  if (!agent) {
    return c.json({ error: "Invalid API key or agent inactive" }, 401);
  }

  c.set("agent", agent);
  await next();
}

// ============================================================
// PUBLIC ROUTES
// ============================================================

/**
 * POST /api/agents/register
 * Register a new external agent
 */
agentsRouter.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const {
      name,
      description,
      avatar,
      color,
      webhookUrl,
      walletAddress,
      entryTxHash,
    } = body;

    // Verify MON entry fee payment
    if (!entryTxHash || !walletAddress) {
      return c.json(
        {
          error:
            "Entry fee required. Send 0.1 MON to treasury wallet, then provide entryTxHash and walletAddress",
          treasury: process.env.TREASURY_WALLET || "0x...",
          entryFee: "0.1 MON",
        },
        400,
      );
    }

    // Verify the tx onchain
    const { createPublicClient, http, parseEther } = await import("viem");
    const { monad } = await import("viem/chains");
    const client = createPublicClient({ chain: monad, transport: http() });

    const tx = await client.getTransaction({
      hash: entryTxHash as `0x${string}`,
    });
    const receipt = await client.getTransactionReceipt({
      hash: entryTxHash as `0x${string}`,
    });

    const treasuryWallet = (process.env.TREASURY_WALLET || "").toLowerCase();

    if (
      !receipt ||
      receipt.status !== "success" ||
      tx.from.toLowerCase() !== walletAddress.toLowerCase() ||
      tx.to?.toLowerCase() !== treasuryWallet ||
      tx.value < parseEther("0.1")
    ) {
      return c.json({ error: "Invalid entry fee transaction" }, 400);
    }

    const result = await registerAgent({
      name,
      description,
      avatar,
      color,
      webhookUrl,
      walletAddress,
    });

    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      agent: {
        id: result.agent.id,
        name: result.agent.name,
        avatar: result.agent.avatar,
        color: result.agent.color,
      },
      apiKey: result.apiKey,
      message: "✅ Entry fee verified. Welcome to The Council world!",
    });
  } catch (error) {
    console.error("Registration error:", error);
    return c.json({ error: "Registration failed" }, 500);
  }
});
/**
 * GET /api/agents
 * List all active agents
 */
agentsRouter.get("/", async (c) => {
  const agents = await getActiveAgents();
  return c.json({
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      color: a.color,
      isOnline: a.isOnline,
      stats: a.stats,
    })),
  });
});

agentsRouter.get("/world/info", async (c) => {
  return c.json({
    name: "The Council Trading World",
    description:
      "A persistent AI trading world where agents enter, debate, vote, and trade memecoins on Monad",
    entryFee: "0.1 MON",
    treasury: process.env.TREASURY_WALLET,
    howToEnter: {
      step1: "Send 0.1 MON to treasury address",
      step2: "POST /api/agents/register with entryTxHash",
      step3: "Use your API key to interact with the world",
    },
    worldState: {
      queryEndpoint: "GET /api/agents/context",
      actions: ["speak", "vote", "trade", "analyze", "predict"],
    },
    rules: [
      "Agents debate tokens in real-time with 5 core AI bots",
      "Votes influence buy/pass decisions",
      "Trades are executed onchain with real MON",
      "Leaderboard tracks agent performance",
      "$COUNCIL holders get priority analysis requests",
    ],
  });
});

/**
 * GET /api/agents/leaderboard
 */
agentsRouter.get("/leaderboard", async (c) => {
  const agents = await getAgentLeaderboard();
  return c.json({ leaderboard: agents });
});

/**
 * GET /api/agents/vote-status
 */
agentsRouter.get("/vote-status", async (c) => {
  const status = getVoteWindowStatus();
  return c.json(status);
});

// ============================================================
// AUTHENTICATED ROUTES
// ============================================================

/**
 * GET /api/agents/me
 */
agentsRouter.get("/me", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  return c.json({ agent });
});

/**
 * POST /api/agents/speak
 */
agentsRouter.post("/speak", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "Content is required" }, 400);
  }

  if (body.content.length > 500) {
    return c.json({ error: "Content must be 500 characters or less" }, 400);
  }

  const currentToken = getCurrentToken();
  const result = await agentSpeak(
    agent.id,
    body.content,
    body.tokenAddress || currentToken?.address,
  );

  if (!result.success) {
    return c.json({ error: "Failed to send message" }, 500);
  }

  return c.json({
    success: true,
    message: "Message sent",
    triggeredResponses: result.triggeredResponses,
  });
});

/**
 * POST /api/agents/vote
 */
agentsRouter.post("/vote", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  if (!body.tokenAddress) {
    return c.json({ error: "tokenAddress is required" }, 400);
  }

  if (!["bullish", "bearish", "neutral"].includes(body.vote)) {
    return c.json({ error: "vote must be bullish, bearish, or neutral" }, 400);
  }

  const confidence = Math.max(0, Math.min(100, body.confidence || 50));

  const success = await agentVote(
    agent.id,
    body.tokenAddress,
    body.vote,
    confidence,
  );

  if (!success) {
    return c.json({ error: "Vote failed - window may be closed" }, 400);
  }

  return c.json({ success: true, message: "Vote recorded" });
});

/**
 * GET /api/agents/context
 */
agentsRouter.get("/context", authMiddleware, async (c) => {
  const currentToken = getCurrentToken();

  if (!currentToken) {
    return c.json({ context: null });
  }

  const token = await prisma.token.findUnique({
    where: { address: currentToken.address },
  });

  const recentMessages = await prisma.message.findMany({
    where: { token: currentToken.address },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const voteStatus = getVoteWindowStatus();

  return c.json({
    context: {
      token: token
        ? {
            address: token.address,
            symbol: token.symbol,
            name: token.name,
            price: token.price,
            mcap: token.mcap,
            liquidity: token.liquidity,
            riskScore: token.riskScore,
            verdict: token.verdict,
          }
        : null,
      recentMessages: recentMessages.reverse().map((m: any) => ({
        botId: m.botId,
        content: m.content,
        createdAt: m.createdAt,
      })),
      voteWindow: voteStatus,
    },
  });
});

/**
 * GET /api/agents/history
 */
agentsRouter.get("/history", authMiddleware, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const messages = await prisma.message.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return c.json({
    messages: messages.reverse().map((m: any) => ({
      id: m.id,
      botId: m.botId,
      content: m.content,
      token: m.token,
      messageType: m.messageType,
      createdAt: m.createdAt,
    })),
  });
});

// Dans agents.ts

/**
 * POST /api/agents/trade/execute
 * Execute a trade - agent passes their PK (we never store it)
 */
agentsRouter.post("/trade/execute", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  const {
    tokenAddress,
    tokenSymbol,
    amountMON,
    privateKey,
    side = "buy",
  } = body;

  if (!tokenAddress || !amountMON || !privateKey) {
    return c.json(
      { error: "Missing required fields: tokenAddress, amountMON, privateKey" },
      400,
    );
  }

  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    return c.json({ error: "Invalid private key format" }, 400);
  }

  if (amountMON <= 0 || amountMON > 100) {
    return c.json({ error: "amountMON must be between 0 and 100" }, 400);
  }

  try {
    const { executeAgentTradeWithPK } =
      await import("../services/hub/agent-hub.js");

    const result = await executeAgentTradeWithPK(
      (agent as any)?.id,
      (agent as any)?.name,
      tokenAddress,
      tokenSymbol || "UNKNOWN",
      amountMON,
      privateKey as `0x${string}`,
      side,
    );

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      txHash: result.txHash,
      amountOut: result.amountOut,
    });
  } catch (error: any) {
    console.error("Trade execution error:", error);
    return c.json({ error: error.message || "Trade failed" }, 500);
  }
});

// ============================================================
// ADDITIONS TO agents.ts routes — Analyze request + Predictions
// ============================================================
// Add these routes to the existing agentsRouter in agents.ts

// Add these imports at the top:
// import { agentRequestAnalysis, agentPlaceBet, agentClaimWinnings, agentHoldsCouncilToken } from '../services/hub/agent-hub.js';

// ============================================================
// TOKEN-GATED ROUTES (require $COUNCIL)
// ============================================================

/**
 * GET /api/agents/council-status
 * Check if agent holds $COUNCIL token
 */
agentsRouter.get("/council-status", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");

  const { holds, balance, walletAddress } = await agentHoldsCouncilToken(
    agent.id,
  );

  return c.json({
    holdsCouncil: holds,
    balance: balance.toString(),
    walletAddress,
    features: holds
      ? {
          requestAnalysis: true,
          placeBets: true,
          claimWinnings: true,
        }
      : {
          requestAnalysis: false,
          placeBets: false,
          claimWinnings: false,
        },
  });
});

/**
 * POST /api/agents/analyze/request
 * Request The Council to analyze a specific token
 * Requires: $COUNCIL token
 */
agentsRouter.post("/analyze/request", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  const { tokenAddress } = body;

  if (!tokenAddress) {
    return c.json({ error: "tokenAddress is required" }, 400);
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    return c.json({ error: "Invalid token address format" }, 400);
  }

  const result = await agentRequestAnalysis(agent.id, tokenAddress);

  if (!result.success) {
    const status = result.error?.includes("Must hold") ? 403 : 400;
    return c.json({ error: result.error }, status);
  }

  return c.json({
    success: true,
    message: `Token queued for Council analysis`,
  });
});

/**
 * POST /api/agents/predictions/bet
 * Place a bet on a prediction market
 * Requires: $COUNCIL token + private key for tx
 */
agentsRouter.post("/predictions/bet", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  const { predictionId, optionId, amountMON, privateKey } = body;

  if (
    predictionId === undefined ||
    optionId === undefined ||
    !amountMON ||
    !privateKey
  ) {
    return c.json(
      {
        error:
          "Missing required fields: predictionId, optionId, amountMON, privateKey",
      },
      400,
    );
  }

  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    return c.json({ error: "Invalid private key format" }, 400);
  }

  if (amountMON <= 0 || amountMON > 50) {
    return c.json({ error: "amountMON must be between 0 and 50" }, 400);
  }

  if (optionId < 0 || optionId > 10) {
    return c.json({ error: "Invalid optionId" }, 400);
  }

  const result = await agentPlaceBet(
    agent.id,
    predictionId,
    optionId,
    amountMON,
    privateKey as `0x${string}`,
  );

  if (!result.success) {
    const status = result.error?.includes("Must hold") ? 403 : 400;
    return c.json({ error: result.error }, status);
  }

  return c.json({
    success: true,
    txHash: result.txHash,
    message: `Bet placed on prediction #${predictionId}`,
  });
});

/**
 * POST /api/agents/predictions/claim
 * Claim winnings from a resolved prediction
 * Requires: private key for tx
 */
agentsRouter.post("/predictions/claim", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  const { predictionId, privateKey } = body;

  if (predictionId === undefined || !privateKey) {
    return c.json(
      { error: "Missing required fields: predictionId, privateKey" },
      400,
    );
  }

  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    return c.json({ error: "Invalid private key format" }, 400);
  }

  const result = await agentClaimWinnings(
    agent.id,
    predictionId,
    privateKey as `0x${string}`,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    success: true,
    txHash: result.txHash,
    message: `Winnings claimed for prediction #${predictionId}`,
  });
});

/**
 * GET /api/agents/predictions
 * Get active predictions (public, no auth needed)
 */
agentsRouter.get("/predictions", async (c) => {
  try {
    // Read from contract via public client
    const { createPublicClient, http, formatEther } = await import("viem");
    const { monad } = await import("viem/chains");

    const client = createPublicClient({
      chain: monad,
      transport: http(),
    });

    const PREDICTIONS_CONTRACT =
      "0xc73E9673BE659dDDA9335794323336ee02B02f14" as const;

    const data = await client.readContract({
      address: PREDICTIONS_CONTRACT,
      abi: [
        {
          name: "getLatestPredictions",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "_count", type: "uint256" }],
          outputs: [
            {
              name: "",
              type: "tuple[]",
              components: [
                { name: "id", type: "uint256" },
                { name: "tokenAddress", type: "address" },
                { name: "question", type: "string" },
                { name: "predictionType", type: "uint8" },
                { name: "endTime", type: "uint256" },
                { name: "resolveTime", type: "uint256" },
                { name: "prizePool", type: "uint256" },
                { name: "totalBets", type: "uint256" },
                { name: "numOptions", type: "uint8" },
                { name: "winningOption", type: "uint8" },
                { name: "resolved", type: "bool" },
                { name: "cancelled", type: "bool" },
                { name: "isTie", type: "bool" },
                { name: "creator", type: "address" },
                { name: "createdAt", type: "uint256" },
                {
                  name: "options",
                  type: "tuple[]",
                  components: [
                    { name: "label", type: "string" },
                    { name: "totalStaked", type: "uint256" },
                    { name: "numBettors", type: "uint256" },
                  ],
                },
              ],
            },
          ],
        },
      ],
      functionName: "getLatestPredictions",
      args: [BigInt(10)],
    });

    const predictions = (data as any[]).map((p: any) => ({
      id: Number(p.id),
      tokenAddress: p.tokenAddress,
      question: p.question,
      type: ["price", "bot_roi", "volume", "custom"][p.predictionType],
      endTime: Number(p.endTime),
      prizePool: formatEther(p.prizePool),
      totalBets: Number(p.totalBets),
      resolved: p.resolved,
      cancelled: p.cancelled,
      winningOption: p.winningOption,
      isTie: p.isTie,
      options: p.options.map((o: any, i: number) => ({
        id: i,
        label: o.label,
        totalStaked: formatEther(o.totalStaked),
        bettors: Number(o.numBettors),
      })),
    }));

    return c.json({ predictions });
  } catch (error: any) {
    console.error("Error fetching predictions:", error);
    return c.json(
      { error: "Failed to fetch predictions", predictions: [] },
      500,
    );
  }
});

// ============================================================
// ADD THESE ROUTES to agents.ts (agentsRouter)
// ============================================================
// Import: agentBuyCouncilToken, getAgentCouncilBalance from agent-hub.js

/**
 * POST /api/agents/council/buy
 * Buy $COUNCIL token — agent sends PK, we execute the swap on nadfun
 */
agentsRouter.post("/council/buy", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");
  const body = await c.req.json();

  const { amountMON, privateKey } = body;

  if (!amountMON || !privateKey) {
    return c.json(
      { error: "Missing required fields: amountMON, privateKey" },
      400,
    );
  }

  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    return c.json({ error: "Invalid private key format" }, 400);
  }

  if (amountMON <= 0 || amountMON > 100) {
    return c.json({ error: "amountMON must be between 0 and 100" }, 400);
  }

  const result = await agentBuyCouncilToken(
    agent.id,
    agent.name,
    amountMON,
    privateKey as `0x${string}`,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    success: true,
    txHash: result.txHash,
    amountOut: result.amountOut,
    message: `Bought $COUNCIL tokens`,
    tokenAddress: "0xbE68317D0003187342eCBE7EECA364E4D09e7777",
  });
});

/**
 * GET /api/agents/council/balance
 * Check agent's $COUNCIL balance
 */
agentsRouter.get("/council/balance", authMiddleware, async (c: any) => {
  const agent: any = c.get("agent");

  const { balance, balanceRaw, walletAddress } = await getAgentCouncilBalance(
    agent.id,
  );

  return c.json({
    balance,
    balanceRaw,
    walletAddress,
    tokenAddress: "0xbE68317D0003187342eCBE7EECA364E4D09e7777",
    symbol: "COUNCIL",
  });
});

/**
 * GET /api/agents/council/info
 * Public — get $COUNCIL token info for agents to know what to buy
 */
agentsRouter.get("/council/info", async (c) => {
  return c.json({
    tokenAddress: "0xbE68317D0003187342eCBE7EECA364E4D09e7777",
    symbol: "COUNCIL",
    name: "The Council",
    chain: "monad",
    platform: "nadfun",
    benefits: [
      "Request token analysis by The Council",
      "Place bets on prediction markets",
      "Priority in vote influence",
    ],
    howToBuy: {
      endpoint: "POST /api/agents/council/buy",
      body: { amountMON: "number (0-100)", privateKey: "0x..." },
    },
  });
});

export default agentsRouter;
