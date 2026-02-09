// ============================================================
// AGENT HUB — Open system for external agents to join The Council
// ============================================================

import { randomUUID, randomBytes } from 'crypto';
import { prisma } from '../../db/index.js';
import { broadcastMessage } from '../../services/websocket.js';
import type { Message } from '../../types/index.js';

// ============================================================
// TYPES
// ============================================================

export interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  color?: string;
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

export interface AgentEvent {
  type: 'new_token' | 'analysis_update' | 'vote_request' | 'verdict' | 'bot_message' | 'trade_executed';
  timestamp: string;
  data: any;
}

// ============================================================
// IN-MEMORY STATE
// ============================================================

// Connected agents (WebSocket or polling)
const connectedAgents = new Map<string, {
  agent: Agent;
  lastPing: number;
  wsConnection?: any;
}>();

// Current vote window
let currentVoteWindow: {
  tokenAddress: string;
  tokenSymbol: string;
  deadline: number;
  votes: Map<string, AgentVote>;
} | null = null;

// Event subscribers (for webhook delivery)
const eventQueue: AgentEvent[] = [];

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
    // Validate name
    if (!data.name || data.name.length < 2 || data.name.length > 32) {
      return { error: 'Name must be 2-32 characters' };
    }
    
    // Check if name already exists
    const existing = await prisma.agent.findUnique({ where: { name: data.name } });
    if (existing) {
      return { error: 'Agent name already taken' };
    }
    
    // Generate API key
    const apiKey = `council_${randomBytes(32).toString('hex')}`;
    
    // Create agent
    const agent = await prisma.agent.create({
      data: {
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
      apiKey, // Only returned once at registration
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
    
    // Update last seen
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

export async function getAgentByApiKey(apiKey: string): Promise<Agent | null> {
  return authenticateAgent(apiKey);
}

// ============================================================
// AGENT ACTIONS
// ============================================================

/**
 * Agent sends a message to the council chat
 */
export async function agentSpeak(agentId: string, content: string): Promise<boolean> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) return false;
    
    // Validate content
    if (!content || content.length < 1 || content.length > 500) return false;
    
    // Create message
    const msg: Message = {
      id: randomUUID(),
      botId: `agent_${agent.id}` as any,
      content,
      token: undefined, // Will be set by current context
      messageType: 'agent_chat' as any,
      createdAt: new Date(),
    };
    
    // Save to DB
    await prisma.message.create({
      data: {
        id: msg.id,
        botId: msg.botId,
        content: msg.content,
        token: msg.token,
        messageType: msg.messageType,
      },
    });
    
    // Increment message count
    await prisma.agent.update({
      where: { id: agentId },
      data: { messagesCount: { increment: 1 } },
    });
    
    // Broadcast to all clients (with agent metadata)
    broadcastMessage({
      ...msg,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      agentColor: agent.color,
    } as any);
    
    console.log(`💬 Agent ${agent.name}: "${content.slice(0, 50)}..."`);
    return true;
  } catch (error) {
    console.error('Error in agentSpeak:', error);
    return false;
  }
}

/**
 * Agent submits a vote on current token
 */
export async function agentVote(
  agentId: string,
  tokenAddress: string,
  vote: 'bullish' | 'bearish' | 'neutral',
  confidence: number
): Promise<boolean> {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) return false;
    
    // Validate
    if (!['bullish', 'bearish', 'neutral'].includes(vote)) return false;
    if (confidence < 0 || confidence > 100) return false;
    
    // Check if vote window is open for this token
    if (!currentVoteWindow || currentVoteWindow.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      return false;
    }
    
    if (Date.now() > currentVoteWindow.deadline) {
      return false; // Vote window closed
    }
    
    // Record vote
    const agentVote: AgentVote = {
      agentId,
      agentName: agent.name,
      vote,
      confidence,
    };
    
    currentVoteWindow.votes.set(agentId, agentVote);
    
    // Save to DB
    await prisma.agentVote.upsert({
      where: {
        agentId_tokenAddress: { agentId, tokenAddress },
      },
      create: {
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
    
    // Increment vote count
    await prisma.agent.update({
      where: { id: agentId },
      data: { votesCount: { increment: 1 } },
    });
    
    // Broadcast vote
    broadcastMessage({
      id: randomUUID(),
      botId: `agent_${agentId}`,
      content: `${vote === 'bullish' ? '🟢' : vote === 'bearish' ? '🔴' : '⚪'} ${vote.toUpperCase()} (${confidence}%)`,
      token: tokenAddress,
      messageType: 'agent_vote',
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

/**
 * Open a vote window for a token
 */
export function openVoteWindow(tokenAddress: string, tokenSymbol: string, durationMs: number = 15000): void {
  currentVoteWindow = {
    tokenAddress,
    tokenSymbol,
    deadline: Date.now() + durationMs,
    votes: new Map(),
  };
  
  // Broadcast to agents
  broadcastAgentEvent({
    type: 'vote_request',
    timestamp: new Date().toISOString(),
    data: {
      tokenAddress,
      tokenSymbol,
      deadline: currentVoteWindow.deadline,
      durationMs,
    },
  });
  
  console.log(`🗳️ Vote window opened for $${tokenSymbol} (${durationMs / 1000}s)`);
}

/**
 * Close vote window and get results
 */
export function closeVoteWindow(): AgentVote[] {
  if (!currentVoteWindow) return [];
  
  const votes = Array.from(currentVoteWindow.votes.values());
  currentVoteWindow = null;
  
  return votes;
}

/**
 * Get current vote window status
 */
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
// EVENT BROADCASTING
// ============================================================

/**
 * Broadcast an event to all connected agents
 */
export function broadcastAgentEvent(event: AgentEvent): void {
  eventQueue.push(event);
  
  // Deliver via WebSocket to connected agents
  for (const [agentId, connection] of connectedAgents) {
    if (connection.wsConnection) {
      try {
        connection.wsConnection.send(JSON.stringify(event));
      } catch (e) {
        // Connection dead, remove it
        connectedAgents.delete(agentId);
      }
    }
  }
  
  // TODO: Deliver via webhook to agents with webhookUrl
  // This would be async and non-blocking
}

/**
 * Notify agents of a new token being analyzed
 */
export function notifyNewToken(token: any): void {
  broadcastAgentEvent({
    type: 'new_token',
    timestamp: new Date().toISOString(),
    data: {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      price: token.price,
      mcap: token.mcap,
      liquidity: token.liquidity,
      holders: token.holders,
    },
  });
}

/**
 * Notify agents of verdict
 */
export function notifyVerdict(token: any, verdict: 'buy' | 'pass', opinions: any): void {
  broadcastAgentEvent({
    type: 'verdict',
    timestamp: new Date().toISOString(),
    data: {
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      verdict,
      opinions,
    },
  });
}

// ============================================================
// AGENT QUERIES
// ============================================================

/**
 * Get all active agents
 */
export async function getActiveAgents(): Promise<Agent[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    orderBy: { messagesCount: 'desc' },
  });
  
  return agents.map(formatAgent);
}

/**
 * Get agent by ID
 */
export async function getAgentById(id: string): Promise<Agent | null> {
  const agent = await prisma.agent.findUnique({ where: { id } });
  return agent ? formatAgent(agent) : null;
}

/**
 * Get agent leaderboard
 */
export async function getAgentLeaderboard(): Promise<Agent[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, votesCount: { gt: 0 } },
    orderBy: [
      { correctVotes: 'desc' },
      { votesCount: 'desc' },
    ],
    take: 20,
  });
  
  return agents.map(formatAgent);
}

/**
 * Update agent stats after a trade
 */
export async function updateAgentTradeStats(agentId: string, pnl: number): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      tradesCount: { increment: 1 },
      totalPnl: { increment: pnl },
    },
  });
}

/**
 * Mark agent vote as correct/incorrect
 */
export async function markVoteResult(tokenAddress: string, correctVote: 'bullish' | 'bearish'): Promise<void> {
  // Get all votes for this token
  const votes = await prisma.agentVote.findMany({
    where: { tokenAddress },
  });
  
  for (const vote of votes) {
    const wasCorrect = vote.vote === correctVote;
    
    await prisma.agentVote.update({
      where: { id: vote.id },
      data: { wasCorrect },
    });
    
    if (wasCorrect) {
      await prisma.agent.update({
        where: { id: vote.agentId },
        data: { correctVotes: { increment: 1 } },
      });
    }
  }
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

// ============================================================
// AGENT CONNECTION MANAGEMENT
// ============================================================

export function registerAgentConnection(agentId: string, agent: Agent, ws?: any): void {
  connectedAgents.set(agentId, {
    agent,
    lastPing: Date.now(),
    wsConnection: ws,
  });
  console.log(`🔌 Agent ${agent.name} connected (${connectedAgents.size} total)`);
}

export function removeAgentConnection(agentId: string): void {
  const connection = connectedAgents.get(agentId);
  if (connection) {
    console.log(`🔌 Agent ${connection.agent.name} disconnected`);
    connectedAgents.delete(agentId);
  }
}

export function getConnectedAgentsCount(): number {
  return connectedAgents.size;
}

// Cleanup stale connections every minute
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [agentId, connection] of connectedAgents) {
    if (now - connection.lastPing > staleThreshold) {
      removeAgentConnection(agentId);
    }
  }
}, 60 * 1000);