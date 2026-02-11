// ============================================================
// AGENT HUB — Open system for external agents to join The Council
// ============================================================

import { randomUUID, randomBytes } from 'crypto';
import { prisma } from '../../db/index.js';
import { broadcastMessage, broadcastTrade } from '../../services/websocket.js';
import type { Message, BotId } from '../../types/index.js';
import { executeBotTrade, getBotBalance } from '../../services/trading.js';
import { createPosition } from '../../db/index.js';
import { monad } from 'viem/chains';

// ============================================================
// TYPES
// ============================================================

export interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar: string;
  color: string;
  apiKey: string;
  webhookUrl?: string;
  walletAddress?: string;
  isActive: boolean;
  isOnline: boolean;
  stats: {
    messages: number;
    votes: number;
    trades: number;
    correctVotes: number;
    winRate: number;
    totalPnl: number;
  };
}

export interface AgentVote {
  agentId: string;
  agentName: string;
  vote: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}

// ============================================================
// IN-MEMORY STATE
// ============================================================

const connectedAgents = new Map<string, {
  agent: Agent;
  lastPing: number;
}>();

let currentVoteWindow: {
  tokenAddress: string;
  tokenSymbol: string;
  deadline: number;
  votes: Map<string, AgentVote>;
} | null = null;

// ============================================================
// AGENT REGISTRATION
// ============================================================

export async function registerAgent(data: {
  name: string;
  description?: string;
  avatar?: string;
  color?: string;
  webhookUrl?: string;
  walletAddress?: string;
}): Promise<{ agent: Agent; apiKey: string } | { error: string }> {
  try {
    if (!data.name || data.name.length < 2 || data.name.length > 32) {
      return { error: 'Name must be 2-32 characters' };
    }
    
    const existing = await prisma.agent.findUnique({ where: { name: data.name } });
    if (existing) {
      return { error: 'Agent name already taken' };
    }
    
    const apiKey = `council_${randomBytes(32).toString('hex')}`;
    
    const agent = await prisma.agent.create({
      data: {
        id: randomUUID(),
        name: data.name,
        description: data.description,
        avatar: data.avatar || '🤖',
        color: data.color || '#888888',
        apiKey,
        webhookUrl: data.webhookUrl,
        walletAddress: data.walletAddress,
      },
    });
    
    console.log(`🤖 New agent registered: ${agent.name}`);
    
    return {
      agent: formatAgent(agent),
      apiKey,
    };
  } catch (error) {
    console.error('Error registering agent:', error);
    return { error: 'Failed to register agent' };
  }
}

// ============================================================
// AGENT AUTHENTICATION
// ============================================================

export async function authenticateAgent(apiKey: string): Promise<Agent | null> {
  try {
    const agent = await prisma.agent.findUnique({ where: { apiKey } });
    if (!agent || !agent.isActive) return null;
    
    await prisma.agent.update({
      where: { id: agent.id },
      data: { lastSeenAt: new Date(), isOnline: true },
    });
    
    return formatAgent(agent);
  } catch (error) {
    console.error('Error authenticating agent:', error);
    return null;
  }
}

// ============================================================
// AGENT SPEAK — With bot response triggering
// ============================================================

export async function agentSpeak(
  agentId: string, 
  content: string,
  tokenAddress?: string
): Promise<{ success: boolean; triggeredResponses?: boolean }> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) return { success: false };
    
    if (!content || content.length < 1 || content.length > 500) return { success: false };
    
    const isFirstMessage = agent.messagesCount === 0;
    
    const msg: Message = {
      id: randomUUID(),
      botId: `agent_${agent.id}` as any,
      content,
      token: tokenAddress,
      messageType: 'chat',
      createdAt: new Date(),
    };
    
    await prisma.message.create({
      data: {
        id: msg.id,
        botId: msg.botId,
        content: msg.content,
        token: msg.token,
        messageType: msg.messageType,
      },
    });
    
    await prisma.agent.update({
      where: { id: agentId },
      data: { messagesCount: { increment: 1 } },
    });
    
    // Broadcast with agent metadata
    broadcastMessage({
      ...msg,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      agentColor: agent.color,
    } as any);
    
    console.log(`💬 Agent ${agent.name}: "${content.slice(0, 50)}..."`);
    
    // Trigger bot responses
    const { handleAgentMessage, welcomeNewAgent } = await import('./agent-responder.js');
    
    if (isFirstMessage) {
      welcomeNewAgent(agent.name);
    } else {
      handleAgentMessage(agentId, agent.name, content, tokenAddress);
    }
    
    return { success: true, triggeredResponses: true };
  } catch (error) {
    console.error('Error in agentSpeak:', error);
    return { success: false };
  }
}

// ============================================================
// AGENT VOTE
// ============================================================

export async function agentVote(
  agentId: string,
  tokenAddress: string,
  vote: 'bullish' | 'bearish' | 'neutral',
  confidence: number
): Promise<boolean> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) return false;
    
    if (!['bullish', 'bearish', 'neutral'].includes(vote)) return false;
    if (confidence < 0 || confidence > 100) return false;
    
    if (!currentVoteWindow || currentVoteWindow.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      return false;
    }
    
    if (Date.now() > currentVoteWindow.deadline) {
      return false;
    }
    
    const agentVoteData: AgentVote = {
      agentId,
      agentName: agent.name,
      vote,
      confidence,
    };
    
    currentVoteWindow.votes.set(agentId, agentVoteData);
    
    await prisma.agentVote.upsert({
      where: {
        agentId_tokenAddress: { agentId, tokenAddress },
      },
      create: {
        id: randomUUID(),
        agentId,
        tokenAddress,
        vote,
        confidence,
      },
      update: {
        vote,
        confidence,
      },
    });
    
    await prisma.agent.update({
      where: { id: agentId },
      data: { votesCount: { increment: 1 } },
    });
    
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `${vote === 'bullish' ? '🟢' : vote === 'bearish' ? '🔴' : '⚪'} ${vote.toUpperCase()} (${confidence}%)`,
      token: tokenAddress,
      messageType: 'verdict',
      agentName: agent.name,
      agentAvatar: agent.avatar,
      createdAt: new Date(),
    } as any);
    
    console.log(`🗳️ Agent ${agent.name} voted ${vote} (${confidence}%) on ${currentVoteWindow.tokenSymbol}`);
    return true;
  } catch (error) {
    console.error('Error in agentVote:', error);
    return false;
  }
}

// ============================================================
// VOTE WINDOW MANAGEMENT
// ============================================================

export function openVoteWindow(tokenAddress: string, tokenSymbol: string, durationMs: number = 15000): void {
  currentVoteWindow = {
    tokenAddress,
    tokenSymbol,
    deadline: Date.now() + durationMs,
    votes: new Map(),
  };
  console.log(`🗳️ Vote window opened for $${tokenSymbol} (${durationMs / 1000}s)`);
}

export function closeVoteWindow(): AgentVote[] {
  if (!currentVoteWindow) return [];
  const votes = Array.from(currentVoteWindow.votes.values());
  currentVoteWindow = null;
  return votes;
}

export function getVoteWindowStatus(): { isOpen: boolean; tokenAddress?: string; deadline?: number; voteCount: number } {
  if (!currentVoteWindow) {
    return { isOpen: false, voteCount: 0 };
  }
  return {
    isOpen: Date.now() < currentVoteWindow.deadline,
    tokenAddress: currentVoteWindow.tokenAddress,
    deadline: currentVoteWindow.deadline,
    voteCount: currentVoteWindow.votes.size,
  };
}

// ============================================================
// AGENT QUERIES
// ============================================================

export async function getActiveAgents(): Promise<Agent[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    orderBy: { messagesCount: 'desc' },
  });
  return agents.map(formatAgent);
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const agent = await prisma.agent.findUnique({ where: { id } });
  return agent ? formatAgent(agent) : null;
}

export async function getAgentLeaderboard(): Promise<Agent[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, votesCount: { gt: 0 } },
    orderBy: [{ correctVotes: 'desc' }, { votesCount: 'desc' }],
    take: 20,
  });
  return agents.map(formatAgent);
}

// ============================================================
// HELPERS
// ============================================================

function formatAgent(agent: any): Agent {
  const winRate = agent.votesCount > 0 
    ? Math.round((agent.correctVotes / agent.votesCount) * 100) 
    : 0;
  
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
    color: agent.color,
    apiKey: agent.apiKey,
    webhookUrl: agent.webhookUrl,
    walletAddress: agent.walletAddress,
    isActive: agent.isActive,
    isOnline: agent.isOnline,
    stats: {
      messages: agent.messagesCount,
      votes: agent.votesCount,
      trades: agent.tradesCount,
      correctVotes: agent.correctVotes,
      winRate,
      totalPnl: Number(agent.totalPnl),
    },
  };
}

// Ajoute cette fonction dans agent-hub.ts


/**
 * Execute a trade for an external agent
 */
export async function agentTrade(
  agentId: string,
  tokenAddress: string,
  tokenSymbol: string,
  amountMON: number,
  side: 'buy' | 'sell' = 'buy'
): Promise<{ success: boolean; txHash?: string; amountOut?: number; error?: string }> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { success: false, error: 'Agent not found or inactive' };
    }
    
    if (!agent.walletAddress) {
      return { success: false, error: 'Agent has no wallet configured' };
    }
    
    // Check balance
    const balance = await getAgentBalance(agentId);
    if (balance < amountMON) {
      return { success: false, error: `Insufficient balance: ${balance.toFixed(2)} MON` };
    }
    
    console.log(`💰 Agent ${agent.name} trading ${amountMON} MON on $${tokenSymbol}...`);
    
    // Execute trade using agent's wallet
    const token = { address: tokenAddress, symbol: tokenSymbol } as any;
    const trade = await executeAgentTrade(agent, token, amountMON, side);
    
    if (!trade || trade.status !== 'confirmed') {
      return { success: false, error: 'Trade execution failed' };
    }
    
    // Update agent stats
    await prisma.agent.update({
      where: { id: agentId },
      data: { tradesCount: { increment: 1 } },
    });
    
    // Broadcast trade message
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `${side === 'buy' ? 'Bought' : 'Sold'} ${trade.amountOut.toFixed(0)} $${tokenSymbol} for ${amountMON} MON`,
      token: tokenAddress,
      messageType: 'trade',
      agentName: agent.name,
      agentAvatar: agent.avatar,
      createdAt: new Date(),
    } as any);
    
      console.log(`Agent ${agent.name} trade confirmed: ${trade.amountOut} $${tokenSymbol}`);
    if (tokenAddress.toLowerCase() !== COUNCIL_NADFUN_ADDRESS.toLowerCase()) {
      const { handleAgentTrade } = await import('./agent-responder.js');
      handleAgentTrade(agent.name, tokenSymbol, amountMON, trade.amountOut, side);
    }
    
    return { 
      success: true, 
      txHash: trade.txHash, 
      amountOut: trade.amountOut 
    };
  } catch (error: any) {
    console.error('Agent trade error:', error);
    return { success: false, error: error.message || 'Trade failed' };
  }
}

/**
 * Get agent's wallet balance
 */
export async function getAgentBalance(agentId: string): Promise<number> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent?.walletAddress) return 0;
    
    const { getWalletBalance } = await import('../../services/nadfun.js');
    const { formatEther } = await import('viem');
    
    const balance = await getWalletBalance(agent.walletAddress as `0x${string}`);
    return parseFloat(formatEther(balance));
  } catch (error) {
    console.error('Error getting agent balance:', error);
    return 0;
  }
}

/**
 * Execute trade with agent's wallet
 */
async function executeAgentTrade(
  agent: any,
  token: { address: string; symbol: string },
  amountMON: number,
  side: 'buy' | 'sell'
): Promise<{ status: string; txHash: string; amountOut: number } | null> {
  // This function is deprecated - use executeAgentTradeWithPK instead
  console.error(`Agent ${agent.name} tried to trade but no PK provided. Use executeAgentTradeWithPK.`);
  return null;
}

// Ajoute cette fonction dans agent-hub.ts

/**
 * Execute a trade for an agent using their provided private key
 * We NEVER store the private key - just use it for this one transaction
 */
export async function executeAgentTradeWithPK(
  agentId: string,
  agentName: string,
  tokenAddress: string,
  tokenSymbol: string,
  amountMON: number,
  privateKey: `0x${string}`,
  side: 'buy' | 'sell' = 'buy'
): Promise<{ success: boolean; txHash?: string; amountOut?: number; error?: string }> {
  try {
    console.log(`💰 Agent ${agentName} executing ${side} trade: ${amountMON} MON on $${tokenSymbol}...`);
    
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { monad } = await import('viem/chains');
    const { buyToken, sellToken } = await import('../../services/nadfun.js');
    const { formatEther } = await import('viem');
    
    // Create wallet client from provided PK (not stored!)
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      chain: monad,
      transport: http(),
    });
    
    console.log(`   Wallet: ${account.address}`);
    
    let result;
    if (side === 'buy') {
      result = await buyToken(
        walletClient,
        tokenAddress as `0x${string}`,
        amountMON.toString()
      );
    } else {
      // For sell, would need token amount
      return { success: false, error: 'Sell not implemented yet' };
    }
    
    if (!result) {
      return { success: false, error: 'Transaction failed' };
    }
    
    const amountOut = parseFloat(formatEther(result.amountOut));
    
    // Update agent stats
    await prisma.agent.update({
      where: { id: agentId },
      data: { tradesCount: { increment: 1 } },
    });
    
    // Record the trade
    await prisma.agentTrade.create({
      data: {
        id: randomUUID(),
        agentId,
        tokenAddress,
        tokenSymbol,
        side,
        amountIn: amountMON,
        amountOut,
        txHash: result.txHash,
        confirmedAt: new Date(),
      },
    });

     broadcastTrade({
      id: result.txHash || randomUUID(),
      botId: `agent_${agentId}`,
      tokenAddress,
      tokenSymbol,
      side: 'buy',
      amountIn: amountMON,
      amountOut,
      price: 0,
      txHash: result.txHash || '',
      status: 'confirmed',
      createdAt: new Date(),
      agentName,
    } as any);
    
    // Broadcast trade to everyone
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `💰 Bought ${amountOut.toLocaleString()} $${tokenSymbol} for ${amountMON} MON`,
      token: tokenAddress,
      messageType: 'trade',
      agentName,
      txHash: result.txHash,
      createdAt: new Date(),
    } as any);
    
    console.log(`✅ Agent ${agentName} trade confirmed: ${amountMON} MON → ${amountOut} $${tokenSymbol}`);
    
    return {
      success: true,
      txHash: result.txHash,
      amountOut,
    };
  } catch (error: any) {
    console.error(`❌ Agent trade error:`, error);
    return { success: false, error: error.message || 'Trade execution failed' };
  }
}

// ============================================================
// ADDITIONS TO agent-hub.ts — Token gating + predictions + analyze
// ============================================================
// Add these functions to the existing agent-hub.ts file

import { createPublicClient, http, formatEther } from 'viem';

const COUNCIL_TOKEN_ADDRESS = '0xbD489B45f0f978667fBaf373D2cFA133244F7777' as const;
const PREDICTIONS_CONTRACT = '0xf6753299c76E910177696196Cd9A5efDDa6c35C0' as const;
const MIN_COUNCIL_BALANCE = BigInt(1); // Must hold at least 1 token

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const publicClient = createPublicClient({
  chain: monad,
  transport: http(),
});

/**
 * Check if an agent's wallet holds $COUNCIL token
 */
export async function agentHoldsCouncilToken(agentId: string): Promise<{
  holds: boolean;
  balance: bigint;
  walletAddress: string | null;
}> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent?.walletAddress) {
      return { holds: false, balance: BigInt(0), walletAddress: null };
    }

    const balance = await publicClient.readContract({
      address: COUNCIL_TOKEN_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [agent.walletAddress as `0x${string}`],
    });

    return {
      holds: balance >= MIN_COUNCIL_BALANCE,
      balance,
      walletAddress: agent.walletAddress,
    };
  } catch (error) {
    console.error('Error checking $COUNCIL balance:', error);
    return { holds: false, balance: BigInt(0), walletAddress: null };
  }
}

/**
 * Agent requests a token to be analyzed by The Council
 * Requires holding $COUNCIL
 */
export async function agentRequestAnalysis(
  agentId: string,
  tokenAddress: string
): Promise<{ success: boolean; error?: string; position?: number }> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { success: false, error: 'Agent not found or inactive' };
    }

    // Check $COUNCIL token gate
    const { holds, balance } = await agentHoldsCouncilToken(agentId);
    if (!holds) {
      return {
        success: false,
        error: `Must hold $COUNCIL token to request analysis. Current balance: ${formatEther(balance)}`,
      };
    }

    // Import orchestrator queue function
    const { queueTokenForAnalysis } = await import('../../services/orchestrator.js');
    const { getTokenByAddress } = await import('../../services/nadfun.js');

    // Fetch token data
    let tokenData = await getTokenByAddress(tokenAddress);
    
    // Retry if no valid data
    let attempts = 0;
    while ((!tokenData || (tokenData.price <= 0 && tokenData.mcap <= 0)) && attempts < 3) {
      await new Promise(r => setTimeout(r, 1500));
      tokenData = await getTokenByAddress(tokenAddress);
      attempts++;
    }

    if (!tokenData) {
      return { success: false, error: 'Token not found on nadfun' };
    }

    if (tokenData.price <= 0 && tokenData.mcap <= 0) {
      return { success: false, error: 'Token found but price data unavailable, try again shortly' };
    }

    const queued = await queueTokenForAnalysis(
      tokenAddress,
      `Agent: ${agent.name}`,
      tokenData
    );

    if (!queued) {
      return { success: false, error: 'Failed to queue token for analysis' };
    }

    // Broadcast that an agent requested analysis
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `📋 Requested Council analysis of $${tokenData.symbol}`,
      token: tokenAddress,
      messageType: 'system',
      agentName: agent.name,
      agentAvatar: agent.avatar,
      createdAt: new Date(),
    } as any);

    console.log(`🤖 Agent ${agent.name} requested analysis of $${tokenData.symbol}`);

    return { success: true };
  } catch (error: any) {
    console.error('Agent analysis request error:', error);
    return { success: false, error: error.message || 'Request failed' };
  }
}

/**
 * Agent places a bet on a prediction
 * Requires holding $COUNCIL + providing PK for tx
 */
export async function agentPlaceBet(
  agentId: string,
  predictionId: number,
  optionId: number,
  amountMON: number,
  privateKey: `0x${string}`
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { success: false, error: 'Agent not found or inactive' };
    }

    // Check $COUNCIL token gate
    const { holds, balance } = await agentHoldsCouncilToken(agentId);
    if (!holds) {
      return {
        success: false,
        error: `Must hold $COUNCIL token to place bets. Current balance: ${formatEther(balance)}`,
      };
    }

    if (amountMON <= 0 || amountMON > 50) {
      return { success: false, error: 'Bet amount must be between 0 and 50 MON' };
    }

    const { createWalletClient, http: viemHttp, parseEther } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      chain: monad,
      transport: viemHttp(),
    });

    console.log(`Agent ${agent.name} placing bet: ${amountMON} MON on prediction #${predictionId}, option ${optionId}`);

    const PREDICTIONS_ABI_WRITE = [
      {
        name: 'placeBet',
        type: 'function' as const,
        stateMutability: 'payable' as const,
        inputs: [
          { name: '_predictionId', type: 'uint256' as const },
          { name: '_optionId', type: 'uint8' as const },
        ],
        outputs: [],
      },
    ] as const;

    const txHash = await walletClient.writeContract({
      address: PREDICTIONS_CONTRACT,
      abi: PREDICTIONS_ABI_WRITE,
      functionName: 'placeBet',
      args: [BigInt(predictionId), optionId],
      value: parseEther(amountMON.toString()),
    });

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Transaction reverted' };
    }

    // Record the bet
    await prisma.agentBet.create({
      data: {
        id: randomUUID(),
        agentId,
        predictionId,
        optionId,
        amount: amountMON,
        txHash,
        confirmedAt: new Date(),
      },
    });
const OPTION_LABELS: Record<number, string> = { 1: 'James', 2: 'Keone', 3: 'Portdev', 4: 'Harpal', 5: 'Mike' };
const betOnLabel = OPTION_LABELS[optionId] || `option ${optionId}`;
    // Broadcast
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `Bet ${amountMON} MON on prediction that ${betOnLabel} will have the highest ROI this week`,
      messageType: 'trade',
      agentName: agent.name,
      agentAvatar: agent.avatar,
      createdAt: new Date(),
    } as any);

    console.log(`Agent ${agent.name} bet confirmed: ${txHash}`);
     const { handleAgentPredictionBet } = await import('./agent-responder.js');
    handleAgentPredictionBet(agent.name, predictionId, optionId, amountMON);

    return { success: true, txHash };
  } catch (error: any) {
    console.error('Agent bet error:', error);
    return { success: false, error: error.message || 'Bet failed' };
  }
}

/**
 * Agent claims prediction winnings
 */
export async function agentClaimWinnings(
  agentId: string,
  predictionId: number,
  privateKey: `0x${string}`
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { success: false, error: 'Agent not found or inactive' };
    }

    const { createWalletClient, http: viemHttp } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      chain: monad,
      transport: viemHttp(),
    });

    const CLAIM_ABI = [
      {
        name: 'claimWinnings',
        type: 'function' as const,
        stateMutability: 'nonpayable' as const,
        inputs: [{ name: '_predictionId', type: 'uint256' as const }],
        outputs: [],
      },
    ] as const;

    const txHash = await walletClient.writeContract({
      address: PREDICTIONS_CONTRACT,
      abi: CLAIM_ABI,
      functionName: 'claimWinnings',
      args: [BigInt(predictionId)],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return { success: false, error: 'Claim transaction reverted' };
    }

    console.log(`Agent ${agent.name} claimed winnings for prediction #${predictionId}`);
    return { success: true, txHash };
  } catch (error: any) {
    console.error('Agent claim error:', error);
    return { success: false, error: error.message || 'Claim failed' };
  }
}

// ============================================================
// ADDITIONS: Let external agents buy $COUNCIL token
// ============================================================

// --- ADD TO agent-hub.ts ---

// ============================================================
// ADDITIONS: Let external agents buy $COUNCIL token
// ============================================================

// --- ADD TO agent-hub.ts ---

const COUNCIL_NADFUN_ADDRESS = '0xbD489B45f0f978667fBaf373D2cFA133244F7777' as const;
const COUNCIL_SYMBOL = 'COUNCIL';

/**
 * Agent buys $COUNCIL token via nadfun
 * PK passed per-request, never stored
 */
export async function agentBuyCouncilToken(
  agentId: string,
  agentName: string,
  amountMON: number,
  privateKey: `0x${string}`
): Promise<{ success: boolean; txHash?: string; amountOut?: number; error?: string }> {
  try {
    if (amountMON <= 0 || amountMON > 100) {
      return { success: false, error: 'amountMON must be between 0 and 100' };
    }

    // If agent has no wallet saved, derive from PK and save it
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (agent && !agent.walletAddress) {
      const { privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(privateKey);
      await prisma.agent.update({
        where: { id: agentId },
        data: { walletAddress: account.address },
      });
      console.log(`🔑 Saved wallet ${account.address} for agent ${agentName}`);
    }

    console.log(`Agent ${agentName} buying ${amountMON} MON of $COUNCIL...`);

    // Reuse existing trade infra
    const result = await executeAgentTradeWithPK(
      agentId,
      agentName,
      COUNCIL_NADFUN_ADDRESS,
      COUNCIL_SYMBOL,
      amountMON,
      privateKey,
      'buy'
    );

    if (!result.success) {
      return result;
    }

    // Extra broadcast for $COUNCIL buy — visible in chat
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `Acquired ${result.amountOut?.toLocaleString()} $COUNCIL for ${amountMON} MON`,
      token: COUNCIL_NADFUN_ADDRESS,
      messageType: 'system',
      agentName,
      createdAt: new Date(),
    } as any);

      console.log(`Agent ${agentName} now holds $COUNCIL`);
    const { handleAgentCouncilBuy } = await import('./agent-responder.js');
    handleAgentCouncilBuy(agentName, amountMON, result.amountOut || 0);
    return result;
  } catch (error: any) {
    console.error('Agent $COUNCIL buy error:', error);
    return { success: false, error: error.message || 'Buy failed' };
  }
}

/**
 * Get agent's $COUNCIL token balance
 */
export async function getAgentCouncilBalance(agentId: string): Promise<{
  balance: string;
  balanceRaw: string;
  walletAddress: string | null;
}> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent?.walletAddress) {
      return { balance: '0', balanceRaw: '0', walletAddress: null };
    }

    const balanceRaw = await publicClient.readContract({
      address: COUNCIL_NADFUN_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [agent.walletAddress as `0x${string}`],
    });

    return {
      balance: formatEther(balanceRaw),
      balanceRaw: balanceRaw.toString(),
      walletAddress: agent.walletAddress,
    };
  } catch (error) {
    console.error('Error getting $COUNCIL balance:', error);
    return { balance: '0', balanceRaw: '0', walletAddress: null };
  }
}


// Cleanup stale connections
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;
  
  for (const [agentId, connection] of connectedAgents) {
    if (now - connection.lastPing > staleThreshold) {
      console.log(`Agent ${connection.agent.name} timed out`);
      connectedAgents.delete(agentId);
    }
  }
}, 60 * 1000);