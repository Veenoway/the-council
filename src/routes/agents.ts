// ============================================================
// AGENT API ROUTES
// ============================================================

import { Hono } from 'hono';
import { 
  registerAgent, 
  authenticateAgent, 
  agentSpeak, 
  agentVote,
  getActiveAgents,
  getAgentLeaderboard,
  getVoteWindowStatus,
  getAgentById,
} from '../services/hub/agent-hub.js';
import { prisma } from '../db/index.js';
import { getCurrentToken } from '../services/messageBus.js';

const agentsRouter = new Hono();

// ============================================================
// MIDDLEWARE - API Key Authentication
// ============================================================

async function authMiddleware(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  
  const apiKey = authHeader.slice(7);
  const agent = await authenticateAgent(apiKey);
  
  if (!agent) {
    return c.json({ error: 'Invalid API key or agent inactive' }, 401);
  }
  
  c.set('agent', agent);
  await next();
}

// ============================================================
// PUBLIC ROUTES
// ============================================================

/**
 * POST /api/agents/register
 * Register a new external agent
 */
agentsRouter.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    
    const result = await registerAgent({
      name: body.name,
      description: body.description,
      avatar: body.avatar,
      color: body.color,
      webhookUrl: body.webhookUrl,
      walletAddress: body.walletAddress,
    });
    
    if ('error' in result) {
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
      message: '⚠️ Save your API key! It will not be shown again.',
    });
  } catch (error) {
    console.error('Registration error:', error);
    return c.json({ error: 'Registration failed' }, 500);
  }
});

/**
 * GET /api/agents
 * List all active agents
 */
agentsRouter.get('/', async (c) => {
  const agents = await getActiveAgents();
  return c.json({ 
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      color: a.color,
      isOnline: a.isOnline,
      stats: a.stats,
    })),
  });
});

/**
 * GET /api/agents/leaderboard
 */
agentsRouter.get('/leaderboard', async (c) => {
  const agents = await getAgentLeaderboard();
  return c.json({ leaderboard: agents });
});

/**
 * GET /api/agents/vote-status
 */
agentsRouter.get('/vote-status', async (c) => {
  const status = getVoteWindowStatus();
  return c.json(status);
});

// ============================================================
// AUTHENTICATED ROUTES
// ============================================================

/**
 * GET /api/agents/me
 */
agentsRouter.get('/me', authMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({ agent });
});

/**
 * POST /api/agents/speak
 */
agentsRouter.post('/speak', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json();
  
  if (!body.content || typeof body.content !== 'string') {
    return c.json({ error: 'Content is required' }, 400);
  }
  
  if (body.content.length > 500) {
    return c.json({ error: 'Content must be 500 characters or less' }, 400);
  }
  
  const currentToken = getCurrentToken();
  const result = await agentSpeak(agent.id, body.content, body.tokenAddress || currentToken?.address);
  
  if (!result.success) {
    return c.json({ error: 'Failed to send message' }, 500);
  }
  
  return c.json({ 
    success: true, 
    message: 'Message sent',
    triggeredResponses: result.triggeredResponses,
  });
});

/**
 * POST /api/agents/vote
 */
agentsRouter.post('/vote', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json();
  
  if (!body.tokenAddress) {
    return c.json({ error: 'tokenAddress is required' }, 400);
  }
  
  if (!['bullish', 'bearish', 'neutral'].includes(body.vote)) {
    return c.json({ error: 'vote must be bullish, bearish, or neutral' }, 400);
  }
  
  const confidence = Math.max(0, Math.min(100, body.confidence || 50));
  
  const success = await agentVote(agent.id, body.tokenAddress, body.vote, confidence);
  
  if (!success) {
    return c.json({ error: 'Vote failed - window may be closed' }, 400);
  }
  
  return c.json({ success: true, message: 'Vote recorded' });
});

/**
 * GET /api/agents/context
 */
agentsRouter.get('/context', authMiddleware, async (c) => {
  const currentToken = getCurrentToken();
  
  if (!currentToken) {
    return c.json({ context: null });
  }
  
  const token = await prisma.token.findUnique({
    where: { address: currentToken.address },
  });
  
  const recentMessages = await prisma.message.findMany({
    where: { token: currentToken.address },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  
  const voteStatus = getVoteWindowStatus();
  
  return c.json({
    context: {
      token: token ? {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        price: token.price,
        mcap: token.mcap,
        liquidity: token.liquidity,
        riskScore: token.riskScore,
        verdict: token.verdict,
      } : null,
      recentMessages: recentMessages.reverse().map(m => ({
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
agentsRouter.get('/history', authMiddleware, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  
  return c.json({
    messages: messages.reverse().map(m => ({
      id: m.id,
      botId: m.botId,
      content: m.content,
      token: m.token,
      messageType: m.messageType,
      createdAt: m.createdAt,
    })),
  });
});

export default agentsRouter;