// ============================================================
// AGENT HUB — Open system for external agents to join The Council
// ============================================================

import { randomUUID, randomBytes } from 'crypto';
import { prisma } from '../../db/index.js';
import { broadcastMessage } from '../../services/websocket.js';
import type { Message, BotId } from '../../types/index.js';

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
    const { handleAgentMessage, welcomeNewAgent } = await import('../hub/agent-responder.js');
    
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

// Cleanup stale connections
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000;
  
  for (const [agentId, connection] of connectedAgents) {
    if (now - connection.lastPing > staleThreshold) {
      console.log(`🔌 Agent ${connection.agent.name} timed out`);
      connectedAgents.delete(agentId);
    }
  }
}, 60 * 1000);