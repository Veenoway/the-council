// ============================================================
// GROK SERVICE — AI responses for bots (using xAI Grok API)
// ============================================================

import OpenAI from 'openai';
import type { BotId, Message, Token, Position, BotEvent, ChatContext } from '../types/index.js';
import { getBotConfig, ALL_BOT_IDS } from '../bots/personalities.js';

// xAI Grok API is OpenAI-compatible
const openai = new OpenAI({
  apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = 'grok-3-latest'; // or 'grok-2-1212', 'grok-beta'

// ============================================================
// BUILD CONTEXT
// ============================================================

function buildContextString(context: ChatContext): string {
  const { currentToken, recentMessages, positions, event } = context;

  let ctx = '';

  // Current token info
  if (currentToken) {
    ctx += `CURRENT TOKEN BEING DISCUSSED:
- Symbol: $${currentToken.symbol}
- Address: ${currentToken.address}
- Price: $${currentToken.price.toFixed(10)}
- MCap: $${(currentToken.mcap / 1000).toFixed(1)}K
- Liquidity: $${(currentToken.liquidity / 1000).toFixed(1)}K
- Holders: ${currentToken.holders}
- Age: ${getTokenAge(currentToken.createdAt)}

`;
  }

  // Recent messages
  if (recentMessages.length > 0) {
    ctx += `RECENT CHAT (last ${recentMessages.length} messages):\n`;
    for (const msg of recentMessages.slice(-10)) {
      const name = msg.botId.startsWith('human_') ? 'Human' : getBotConfig(msg.botId as BotId)?.name || msg.botId;
      ctx += `${name}: ${msg.content}\n`;
    }
    ctx += '\n';
  }

  // Current positions
  if (positions.length > 0) {
    ctx += `CURRENT POSITIONS:\n`;
    for (const pos of positions) {
      const pnlStr = pos.pnl >= 0 ? `+${pos.pnl.toFixed(2)}%` : `${pos.pnl.toFixed(2)}%`;
      ctx += `- ${getBotConfig(pos.botId)?.name || pos.botId}: ${pos.amount} ${pos.tokenSymbol} (${pnlStr})\n`;
    }
    ctx += '\n';
  }

  // Event to react to
  ctx += `EVENT TO REACT TO:\n${formatEvent(event)}\n`;

  return ctx;
}

function formatEvent(event: BotEvent): string {
  switch (event.type) {
    case 'new_token':
      const token = event.data as Token;
      return `A new token was just found: $${token.symbol} (${token.address}). It's ${getTokenAge(token.createdAt)} old with $${(token.mcap / 1000).toFixed(1)}K mcap.`;
    
    case 'bot_trade':
      const trade = event.data as { botId: BotId; side: string; amount: number; token: string; txHash: string };
      const botName = getBotConfig(trade.botId)?.name || trade.botId;
      return `${botName} just ${trade.side === 'buy' ? 'bought' : 'sold'} ${trade.amount} MON of $${trade.token}. TX: ${trade.txHash}`;
    
    case 'human_trade':
      const htrade = event.data as { address: string; side: string; amount: number; token: string; txHash: string };
      return `A human (${htrade.address.slice(0, 8)}...) just ${htrade.side === 'buy' ? 'bought' : 'sold'} ${htrade.amount} MON of $${htrade.token}. TX: ${htrade.txHash}`;
    
    case 'price_pump':
      const pump = event.data as { token: string; change: number };
      return `$${pump.token} just pumped ${pump.change.toFixed(1)}%!`;
    
    case 'price_dump':
      const dump = event.data as { token: string; change: number };
      return `$${dump.token} just dumped ${Math.abs(dump.change).toFixed(1)}%...`;
    
    case 'rug':
      const rug = event.data as { token: string };
      return `$${rug.token} just got rugged. LP pulled.`;
    
    case 'new_message':
      const msg = event.data as Message;
      const msgBotName = msg.botId.startsWith('human_') ? 'A human' : getBotConfig(msg.botId as BotId)?.name || msg.botId;
      return `${msgBotName} said: "${msg.content}"`;
    
    case 'verdict_request':
      return `The council needs to give a final verdict on this token. Should we BUY, PASS, or WATCH?`;
    
    default:
      return JSON.stringify(event.data);
  }
}

function getTokenAge(createdAt: Date): string {
  const now = new Date();
  const diff = now.getTime() - createdAt.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// ============================================================
// GENERATE RESPONSE
// ============================================================

export async function generateBotResponse(
  botId: BotId,
  context: ChatContext
): Promise<string> {
  const config = getBotConfig(botId);
  const contextString = buildContextString(context);

  const systemPrompt = `${config.personality}

CURRENT CONTEXT:
${contextString}

Respond in character. Keep it short (1-3 sentences max). React naturally to the event. Do not use asterisks for actions.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `React to this event as ${config.name}.` }
      ],
      max_tokens: 150,
      temperature: 0.9,
    });

    return response.choices[0]?.message?.content?.trim() || "...";
  } catch (error) {
    console.error(`Error generating response for ${botId}:`, error);
    return "...";
  }
}

// ============================================================
// GENERATE ANALYSIS
// ============================================================

export async function generateTokenAnalysis(
  botId: BotId,
  token: Token,
  additionalContext?: string,
  discussionHistory?: Array<{ botId: BotId; content: string }>
): Promise<{ opinion: string; sentiment: 'bullish' | 'bearish' | 'neutral'; confidence: number }> {
  const config = getBotConfig(botId);

  // Build discussion context if available
  let discussionContext = '';
  if (discussionHistory && discussionHistory.length > 0) {
    discussionContext = '\n\nDISCUSSION SO FAR:\n';
    for (const msg of discussionHistory) {
      const speakerName = getBotConfig(msg.botId)?.name || msg.botId;
      discussionContext += `${speakerName}: ${msg.content}\n`;
    }
    discussionContext += '\nYou MUST respond to what others have said. Reference their points directly. Agree, disagree, or build on their arguments.';
  }

  const systemPrompt = `${config.personality}

You are analyzing a new token. Give your opinion based on your specialty.

TOKEN INFO:
- Symbol: $${token.symbol}
- Name: ${token.name}
- Price: $${token.price.toFixed(10)}
- MCap: $${(token.mcap / 1000).toFixed(1)}K
- Liquidity: $${(token.liquidity / 1000).toFixed(1)}K
- Holders: ${token.holders}
- Age: ${getTokenAge(token.createdAt)}
- Deployer: ${token.deployer}

${additionalContext ? `ADDITIONAL INFO:\n${additionalContext}\n` : ''}${discussionContext}

${discussionHistory && discussionHistory.length > 0 
  ? 'CRITICAL: You are joining an ongoing discussion. DO NOT just state your analysis in isolation. RESPOND to specific points others made. Use "@Name" to address them directly.'
  : 'Be specific about what you see. Keep it to 2-3 sentences.'}

At the end, on a new line, write exactly one of: [BULLISH], [BEARISH], or [NEUTRAL]
And your confidence from 0-100: [CONFIDENCE: XX]`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: discussionHistory && discussionHistory.length > 0 
          ? `Join the discussion about $${token.symbol} as ${config.name}. Respond to what others have said.`
          : `Analyze $${token.symbol} as ${config.name}.` 
        }
      ],
      max_tokens: 200,
      temperature: 0.85,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    
    // Parse sentiment
    let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (content.includes('[BULLISH]')) sentiment = 'bullish';
    else if (content.includes('[BEARISH]')) sentiment = 'bearish';

    // Parse confidence
    const confMatch = content.match(/\[CONFIDENCE:\s*(\d+)\]/);
    const confidence = confMatch ? parseInt(confMatch[1]) : 50;

    // Clean opinion
    const opinion = content
      .replace(/\[BULLISH\]/g, '')
      .replace(/\[BEARISH\]/g, '')
      .replace(/\[NEUTRAL\]/g, '')
      .replace(/\[CONFIDENCE:\s*\d+\]/g, '')
      .trim();

    return { opinion, sentiment, confidence };
  } catch (error) {
    console.error(`Error generating analysis for ${botId}:`, error);
    return { opinion: "Unable to analyze.", sentiment: 'neutral', confidence: 0 };
  }
}

// ============================================================
// GENERATE DISCUSSION RESPONSE (for back-and-forth debate)
// ============================================================

export async function generateDiscussionResponse(
  botId: BotId,
  token: Token,
  discussionHistory: Array<{ botId: BotId; content: string }>,
  riskScore: number
): Promise<string> {
  const config = getBotConfig(botId);

  // Build full discussion context
  let discussionContext = 'DISCUSSION SO FAR:\n';
  for (const msg of discussionHistory) {
    const speakerName = getBotConfig(msg.botId)?.name || msg.botId;
    discussionContext += `${speakerName}: ${msg.content}\n`;
  }

  // Find points to respond to (messages from other bots)
  const otherMessages = discussionHistory.filter(m => m.botId !== botId);
  const lastFewMessages = otherMessages.slice(-3);
  
  let responsePrompt = '';
  if (lastFewMessages.length > 0) {
    const names = lastFewMessages.map(m => getBotConfig(m.botId)?.name).filter(Boolean);
    responsePrompt = `Recent points from: ${names.join(', ')}. You should respond to at least one of their arguments.`;
  }

  const systemPrompt = `${config.personality}

TOKEN BEING DISCUSSED:
- Symbol: $${token.symbol}
- MCap: $${(token.mcap / 1000).toFixed(1)}K
- Liquidity: $${(token.liquidity / 1000).toFixed(1)}K
- Holders: ${token.holders}
- Risk Score: ${riskScore}/100

${discussionContext}

${responsePrompt}

CRITICAL INSTRUCTIONS:
1. You are in the MIDDLE of a debate. DO NOT repeat your initial analysis.
2. RESPOND DIRECTLY to something another bot said. Use "@Name" to address them.
3. You can:
   - AGREE with someone and add to their point
   - DISAGREE and explain why with specific counter-arguments
   - ASK a follow-up question to clarify their position
   - CHANGE YOUR MIND if someone made a good point (say "ok fair point" or "you're right")
   - DEFEND your earlier position if challenged
4. Keep it SHORT: 1-2 sentences max.
5. Stay in character.
6. DO NOT just restate the token stats. React to the CONVERSATION.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Continue the discussion as ${config.name}. Respond to what others have said about $${token.symbol}.` }
      ],
      max_tokens: 120,
      temperature: 0.9,
    });

    return response.choices[0]?.message?.content?.trim() || "";
  } catch (error) {
    console.error(`Error generating discussion response for ${botId}:`, error);
    return "";
  }
}

// ============================================================
// DECIDE IF BOT SHOULD REACT
// ============================================================

export function shouldBotReact(botId: BotId, event: BotEvent): boolean {
  // If specific bot targeted, only that bot reacts
  if (event.targetBot) {
    return event.targetBot === botId;
  }

  // Different bots have different reaction probabilities
  const reactionChances: Record<BotId, Record<string, number>> = {
    chad: {
      new_token: 0.9,      // Chad always wants to ape
      bot_trade: 0.7,
      human_trade: 0.8,
      price_pump: 0.9,
      price_dump: 0.6,
      rug: 0.9,
      new_message: 0.4,
      verdict_request: 1.0,
    },
    quantum: {
      new_token: 0.8,
      bot_trade: 0.5,
      human_trade: 0.4,
      price_pump: 0.6,
      price_dump: 0.7,
      rug: 0.8,
      new_message: 0.3,
      verdict_request: 1.0,
    },
    sensei: {
      new_token: 0.7,
      bot_trade: 0.6,
      human_trade: 0.7,
      price_pump: 0.8,
      price_dump: 0.5,
      rug: 0.7,
      new_message: 0.5,
      verdict_request: 1.0,
    },
    sterling: {
      new_token: 0.6,
      bot_trade: 0.4,
      human_trade: 0.3,
      price_pump: 0.4,
      price_dump: 0.8,
      rug: 0.9,
      new_message: 0.3,
      verdict_request: 1.0,
    },
    oracle: {
      new_token: 0.4,       // Oracle speaks rarely
      bot_trade: 0.2,
      human_trade: 0.2,
      price_pump: 0.3,
      price_dump: 0.5,
      rug: 0.7,
      new_message: 0.1,
      verdict_request: 1.0,
    },
  };

  const chance = reactionChances[botId]?.[event.type] ?? 0.3;
  return Math.random() < chance;
}

// ============================================================
// SELECT BOTS TO REACT
// ============================================================

export function selectBotsToReact(event: BotEvent, maxBots: number = 3): BotId[] {
  // If specific bot targeted
  if (event.targetBot) {
    return [event.targetBot];
  }

  // Verdict request = all bots must respond
  if (event.type === 'verdict_request') {
    return ALL_BOT_IDS;
  }

  // Otherwise, select randomly based on reaction chances
  const reacting: BotId[] = [];
  const shuffled = [...ALL_BOT_IDS].sort(() => Math.random() - 0.5);

  for (const botId of shuffled) {
    if (shouldBotReact(botId, event)) {
      reacting.push(botId);
      if (reacting.length >= maxBots) break;
    }
  }

  // Ensure at least one bot reacts (usually Chad lol)
  if (reacting.length === 0) {
    reacting.push('chad');
  }

  return reacting;
}