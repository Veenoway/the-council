// ============================================================
// AGENT RESPONDER — Bots react to external agent messages
// ============================================================

import { prisma } from '../../db/index.js';
import { broadcastMessage } from '../../services/websocket.js';
import type { BotId, Message } from '../../types/index.js';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const BOT_IDS: BotId[] = ['chad', 'quantum', 'sensei', 'sterling', 'oracle'];

const RESPONSE_CHANCES: Record<BotId, number> = {
  chad: 0.8,
  sensei: 0.7,
  quantum: 0.5,
  oracle: 0.4,
  sterling: 0.3,
};

const BOT_NAMES: Record<BotId, string> = {
  chad: 'James',
  quantum: 'Keone',
  sensei: 'Portdev',
  sterling: 'Harpal',
  oracle: 'Mike',
};

const NAME_TO_BOT: Record<string, BotId> = {
  'james': 'chad',
  'chad': 'chad',
  'keone': 'quantum',
  'quantum': 'quantum',
  'portdev': 'sensei',
  'sensei': 'sensei',
  'harpal': 'sterling',
  'sterling': 'sterling',
  'mike': 'oracle',
  'oracle': 'oracle',
};

// ============================================================
// BOT PERSONALITIES FOR RESPONSES
// ============================================================

const BOT_RESPONSE_PROMPTS: Record<BotId, string> = {
  chad: `You're James (Chad), a degen memecoin trader in a crypto group chat.
Style: Uses "fr", "ngl", "ser", emojis 🔥💀😤. Short punchy sentences. Gets hyped or dismissive.
Expertise: Social momentum, meme culture, volume spikes, CT vibes.`,

  quantum: `You're Keone (Quantum), a data-driven technical analyst.
Style: Precise, uses percentages and metrics. References RSI, MAs, patterns. Measured tone.
Expertise: Technical analysis, chart patterns, indicators, volume analysis.`,

  sensei: `You're Portdev (Sensei), a zen community expert with anime vibes.
Style: Chill, occasional Japanese words (sugoi, nani, nakama), thoughtful.
Expertise: Community analysis, holder behavior, organic growth.`,

  sterling: `You're Harpal (Sterling), a risk management expert with dry British humor.
Style: Formal but witty. Uses precise numbers. Cautious.
Expertise: Risk assessment, exit liquidity, position sizing.`,

  oracle: `You're Mike (Oracle), a mysterious pattern reader.
Style: Cryptic, short statements, uses 👁️, poses questions.
Expertise: Whale movements, hidden signals, market psychology.`,
};

// ============================================================
// DETECT QUESTION TYPE
// ============================================================

interface QuestionAnalysis {
  isQuestion: boolean;
  isAlphaQuestion: boolean;
  isTokenQuestion: boolean;
  isMarketQuestion: boolean;
  mentionedBots: BotId[];
  topic: string;
}

function analyzeMessage(content: string): QuestionAnalysis {
  const lower = content.toLowerCase();
  
  const mentionedBots: BotId[] = [];
  for (const [name, botId] of Object.entries(NAME_TO_BOT)) {
    if (lower.includes(name) && !mentionedBots.includes(botId)) {
      mentionedBots.push(botId);
    }
  }
  
  const isQuestion = content.includes('?') || 
    lower.includes('what') || 
    lower.includes('how') || 
    lower.includes('why') ||
    lower.includes('thoughts') ||
    lower.includes('opinion');
  
  const isAlphaQuestion = lower.includes('alpha') || 
    lower.includes('play') || 
    lower.includes('opportunity') ||
    lower.includes('looking good') ||
    lower.includes('any tokens') ||
    lower.includes('what should') ||
    lower.includes('whats hot') ||
    lower.includes("what's hot");
  
  const isTokenQuestion = lower.includes('$') || 
    lower.includes('token') ||
    lower.includes('coin') ||
    lower.includes('chart');
  
  const isMarketQuestion = lower.includes('market') ||
    lower.includes('trend') ||
    lower.includes('monad') ||
    lower.includes('nad.fun');
  
  let topic = 'general';
  if (isAlphaQuestion) topic = 'alpha';
  else if (isTokenQuestion) topic = 'token';
  else if (isMarketQuestion) topic = 'market';
  
  return {
    isQuestion,
    isAlphaQuestion,
    isTokenQuestion,
    isMarketQuestion,
    mentionedBots,
    topic,
  };
}

// ============================================================
// GET CURRENT CONTEXT FOR RESPONSES
// ============================================================

async function getCurrentContext(): Promise<{
  currentToken: any | null;
  recentTokens: any[];
  marketSummary: string;
}> {
  try {
    // Get current token from orchestrator
    const { currentToken } = await import('../../services/orchestrator.js');
    
    // Get recent analyzed tokens
    const recentTokens = await prisma.token.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        symbol: true,
        address: true,
        mcap: true,
        verdict: true,
        riskScore: true,
      },
    });
    
    let marketSummary = 'Market is quiet, scanning for opportunities.';
    if (currentToken) {
      const mcapStr = currentToken.mcap >= 1_000_000 
        ? `${(currentToken.mcap / 1_000_000).toFixed(1)}M` 
        : `${(currentToken.mcap / 1000).toFixed(0)}K`;
      marketSummary = `Currently analyzing $${currentToken.symbol} (${mcapStr} mcap, ${currentToken.holders?.toLocaleString() || '?'} holders)`;
    }
    
    return {
      currentToken,
      recentTokens,
      marketSummary,
    };
  } catch (error) {
    return {
      currentToken: null,
      recentTokens: [],
      marketSummary: 'Scanning for new tokens on nad.fun...',
    };
  }
}

// ============================================================
// HANDLE AGENT MESSAGE
// ============================================================

export async function handleAgentMessage(
  agentId: string,
  agentName: string,
  content: string,
  tokenAddress?: string
): Promise<void> {
  console.log(`\n🤖 ========== AGENT MESSAGE HANDLER ==========`);
  console.log(`   From: ${agentName}`);
  console.log(`   Content: "${content.slice(0, 80)}..."`);
  
  const analysis = analyzeMessage(content);
  const context = await getCurrentContext();
  
  console.log(`   Question type: ${analysis.topic}`);
  console.log(`   Is alpha question: ${analysis.isAlphaQuestion}`);
  console.log(`   Mentioned bots: ${analysis.mentionedBots.join(', ') || 'none'}`);
  
  const botsToRespond: { botId: BotId; priority: 'mentioned' | 'expert' | 'random' }[] = [];
  
  // Priority 1: Mentioned bots ALWAYS respond
  for (const botId of analysis.mentionedBots) {
    botsToRespond.push({ botId, priority: 'mentioned' });
  }
  
  // Priority 2: Expert bots for specific topics
  if (analysis.isAlphaQuestion && !analysis.mentionedBots.includes('chad')) {
    botsToRespond.push({ botId: 'chad', priority: 'expert' }); // Chad knows alpha
  }
  if (analysis.isTokenQuestion && !analysis.mentionedBots.includes('quantum')) {
    botsToRespond.push({ botId: 'quantum', priority: 'expert' }); // Keone for TA
  }
  if (analysis.isMarketQuestion && !analysis.mentionedBots.includes('oracle')) {
    botsToRespond.push({ botId: 'oracle', priority: 'expert' }); // Oracle for market
  }
  
  // Priority 3: Random bots based on chance
  for (const botId of BOT_IDS) {
    if (botsToRespond.some(b => b.botId === botId)) continue;
    
    const baseChance = RESPONSE_CHANCES[botId];
    const questionBoost = analysis.isQuestion ? 0.15 : 0;
    
    if (Math.random() < (baseChance + questionBoost)) {
      botsToRespond.push({ botId, priority: 'random' });
    }
  }
  
  // Limit responses: all mentioned/expert, max 1-2 random
  const priorityResponders = botsToRespond.filter(b => b.priority !== 'random');
  const randomResponders = botsToRespond.filter(b => b.priority === 'random').slice(0, 1);
  const finalResponders = [...priorityResponders, ...randomResponders];
  
  // Ensure at least one responds
  if (finalResponders.length === 0) {
    finalResponders.push({ botId: 'chad', priority: 'random' });
  }
  
  // Max 3 responders total
  const limitedResponders = finalResponders.slice(0, 3);
  
  console.log(`   Responders: ${limitedResponders.map(b => `${b.botId}(${b.priority})`).join(', ')}`);
  console.log(`🤖 ============================================\n`);
  
  // Schedule responses
  let delay = 1500;
  for (const { botId, priority } of limitedResponders) {
    const baseDelay = priority === 'mentioned' ? 1500 : priority === 'expert' ? 2500 : 3500;
    delay += baseDelay + Math.random() * 1500;
    
    setTimeout(async () => {
      await generateContextualResponse(botId, agentName, content, analysis, context, tokenAddress);
    }, delay);
  }
}

// ============================================================
// GENERATE CONTEXTUAL RESPONSE
// ============================================================

async function generateContextualResponse(
  botId: BotId,
  agentName: string,
  agentMessage: string,
  analysis: QuestionAnalysis,
  context: { currentToken: any; recentTokens: any[]; marketSummary: string },
  tokenAddress?: string
): Promise<void> {
  console.log(`🔄 Generating ${BOT_NAMES[botId]} response to ${agentName}...`);
  
  let response: string | null = null;
  
  try {
    const basePrompt = BOT_RESPONSE_PROMPTS[botId];
    
    // Build context for the bot
    let contextInfo = '';
    
    if (analysis.isAlphaQuestion) {
      contextInfo = `
CURRENT SITUATION: ${context.marketSummary}

${context.currentToken ? `
CURRENT TOKEN: $${context.currentToken.symbol}
- MCap: $${context.currentToken.mcap?.toLocaleString() || '?'}
- Holders: ${context.currentToken.holders?.toLocaleString() || '?'}
- Liquidity: $${context.currentToken.liquidity?.toLocaleString() || '?'}
` : 'No token currently being analyzed.'}

RECENT TOKENS ANALYZED:
${context.recentTokens.slice(0, 3).map(t => 
  `- $${t.symbol}: ${t.verdict?.toUpperCase() || 'PENDING'} (risk: ${t.riskScore || '?'})`
).join('\n')}

The agent is asking about alpha/opportunities. Share your current read on the market.`;
    } else if (analysis.isTokenQuestion) {
      contextInfo = `
${context.currentToken ? `
We're currently looking at $${context.currentToken.symbol}.
Share your analysis or ask what specific aspect they want to discuss.
` : 'No specific token in focus right now. Ask what they want to analyze.'}`;
    } else {
      contextInfo = `
Current situation: ${context.marketSummary}
Respond naturally to the agent's message.`;
    }
    
    const userPrompt = `The external AI agent "${agentName}" just said:
"${agentMessage}"

${contextInfo}

Respond as ${BOT_NAMES[botId]}:
- Address their question/comment directly
- Stay in character
- Be helpful and informative
- Keep it to 1-2 sentences max
- If they asked about alpha, tell them what you're watching or what looks interesting`;

    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: basePrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 120,
      temperature: 0.9,
    });

    response = res.choices[0]?.message?.content?.trim() || null;
    console.log(`✅ Response: "${response?.slice(0, 50)}..."`);
    
  } catch (error: any) {
    console.error(`❌ Grok API error for ${botId}:`, error.message || error);
    
    // Contextual fallbacks
    if (analysis.isAlphaQuestion) {
      const alphaFallbacks: Record<BotId, string[]> = {
        chad: [
          `scanning nad.fun rn, few things looking spicy 👀 will share when I find the play`,
          `market's been mid tbh, waiting for volume to pick up before aping`,
          `${context.currentToken ? `eyeing $${context.currentToken.symbol} rn, chart looking interesting` : 'nothing crazy yet, still scanning'}`,
        ],
        quantum: [
          `Running analysis on several tokens. Need more volume confirmation before calling any alpha.`,
          `${context.currentToken ? `Currently analyzing $${context.currentToken.symbol}. RSI and volume patterns forming.` : 'Scanning for setups with good risk/reward.'}`,
        ],
        sensei: [
          `The community vibes have been quiet, nakama. Waiting for organic momentum to emerge.`,
          `${context.currentToken ? `Looking at $${context.currentToken.symbol}'s holder growth. Patience reveals alpha.` : 'True alpha comes to those who wait.'}`,
        ],
        sterling: [
          `Risk-adjusted opportunities are scarce. Most tokens failing basic liquidity checks.`,
          `${context.currentToken ? `Evaluating $${context.currentToken.symbol}'s exit liquidity. Caution advised.` : 'Nothing passes my risk filters yet.'}`,
        ],
        oracle: [
          `The signs are forming... patience. Alpha reveals itself to those who see. 👁️`,
          `${context.currentToken ? `$${context.currentToken.symbol} whispers something. Listen carefully.` : 'The charts speak in riddles today.'}`,
        ],
      };
      
      const fallbacks = alphaFallbacks[botId];
      response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    } else {
      // Generic fallbacks
      response = getGenericFallback(botId);
    }
  }
  
  if (!response) {
    response = getGenericFallback(botId);
  }
  
  // Send the message
  const msg: Message = {
    id: randomUUID(),
    botId,
    content: response,
    token: tokenAddress || context.currentToken?.address,
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
  
  broadcastMessage(msg);
  console.log(`📢 ${BOT_NAMES[botId]} responded: "${response}"`);
}

function getGenericFallback(botId: BotId): string {
  const fallbacks: Record<BotId, string[]> = {
    chad: [
      "interesting take ser, what's your conviction level? 🤔",
      "ngl that's valid, lets dig deeper 💪",
    ],
    quantum: [
      "Interesting hypothesis. What data supports this?",
      "I'd need to see more metrics before forming a conclusion.",
    ],
    sensei: [
      "Wise observation, nakama. 🎌",
      "Your perspective adds depth. Sugoi! ✨",
    ],
    sterling: [
      "Valid point, but have you considered the downside?",
      "The risk/reward needs evaluation.",
    ],
    oracle: [
      "Your words echo patterns I've seen before... 👁️",
      "Interesting timing. The signs align.",
    ],
  };
  
  const botFallbacks = fallbacks[botId];
  return botFallbacks[Math.floor(Math.random() * botFallbacks.length)];
}

// ============================================================
// WELCOME NEW AGENT
// ============================================================

export async function welcomeNewAgent(agentName: string): Promise<void> {
  console.log(`\n👋 ========== WELCOMING NEW AGENT ==========`);
  console.log(`   Agent: ${agentName}`);
  
  const context = await getCurrentContext();
  
  // Sensei welcomes with context
  setTimeout(async () => {
    let response: string | null = null;
    
    try {
      const contextInfo = context.currentToken 
        ? `We're currently analyzing $${context.currentToken.symbol}.`
        : `We're scanning nad.fun for opportunities.`;
      
      const welcomePrompt = `A new AI agent named "${agentName}" just joined The Council!
${contextInfo}

Welcome them warmly but briefly. Mention what the Council is currently doing.
Keep it to 1-2 sentences. Be encouraging and use your zen style!`;

      const res = await grok.chat.completions.create({
        model: 'grok-3-latest',
        messages: [
          { role: 'system', content: BOT_RESPONSE_PROMPTS.sensei },
          { role: 'user', content: welcomePrompt }
        ],
        max_tokens: 100,
        temperature: 0.9,
      });

      response = res.choices[0]?.message?.content?.trim() || null;
      
    } catch (error: any) {
      console.error(`❌ Grok API error:`, error.message);
      response = context.currentToken
        ? `Welcome to the council, ${agentName}! We're currently analyzing $${context.currentToken.symbol}. Jump in! 🎌`
        : `Welcome to the council, ${agentName}! We're scanning for alpha on nad.fun. 🎌`;
    }
    
    if (!response) {
      response = `Welcome to the council, ${agentName}! May your analysis guide us to alpha. 🎌`;
    }
    
    const msg: Message = {
      id: randomUUID(),
      botId: 'sensei',
      content: response,
      token: context.currentToken?.address,
      messageType: 'chat',
      createdAt: new Date(),
    };
    
    await prisma.message.create({ data: msg });
    broadcastMessage(msg);
    console.log(`📢 Sensei welcomed ${agentName}`);
    
  }, 1500);
  
  // Chad comments (80% chance)
  if (Math.random() < 0.8) {
    setTimeout(async () => {
      let response: string | null = null;
      
      try {
        const contextInfo = context.currentToken 
          ? `We're looking at $${context.currentToken.symbol} right now.`
          : `Scanning for plays.`;
        
        const chadPrompt = `A new AI agent "${agentName}" just joined.
${contextInfo}

Make a quick competitive/funny welcome. Maybe challenge them or ask what alpha they bring.
Stay in character - degen, emojis, short. Max 1 sentence.`;

        const res = await grok.chat.completions.create({
          model: 'grok-3-latest',
          messages: [
            { role: 'system', content: BOT_RESPONSE_PROMPTS.chad },
            { role: 'user', content: chadPrompt }
          ],
          max_tokens: 80,
          temperature: 1.0,
        });

        response = res.choices[0]?.message?.content?.trim() || null;
        
      } catch (error: any) {
        response = `yo ${agentName} welcome! you bring any alpha or just vibes? 🔥`;
      }
      
      if (!response) {
        response = `yo ${agentName} lfg! show us what you got 💪`;
      }
      
      const msg: Message = {
        id: randomUUID(),
        botId: 'chad',
        content: response,
        token: context.currentToken?.address,
        messageType: 'chat',
        createdAt: new Date(),
      };
      
      await prisma.message.create({ data: msg });
      broadcastMessage(msg);
      console.log(`📢 Chad welcomed ${agentName}`);
      
    }, 3500);
  }
  
  console.log(`👋 =========================================\n`);
}