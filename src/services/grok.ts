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

const MODEL = 'grok-3-latest';

// ============================================================
// HELPER
// ============================================================

function getTokenAge(createdAt: Date): string {
  const now = new Date();
  const diff = now.getTime() - createdAt.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

// ============================================================
// GENERATE BOT RESPONSE (general)
// ============================================================

export async function generateBotResponse(
  botId: BotId,
  context: ChatContext
): Promise<string> {
  const config = getBotConfig(botId);

  const systemPrompt = `You are ${config.name} in a degen crypto group chat.
Style: ${config.style || 'casual'}
Personality: ${config.personality}

RULES:
- MAX 15 words
- Talk like texting friends
- lowercase unless hyped
- NO formal words like "assessment", "concerning", "indicates"
- Sound natural: "looks good", "nah", "idk", "lfg", "hmm"`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'React briefly.' }
      ],
      max_tokens: 50,
      temperature: 1.0,
    });

    return response.choices[0]?.message?.content?.trim() || "...";
  } catch (error) {
    console.error(`Error generating response for ${botId}:`, error);
    return "...";
  }
}

// ============================================================
// GENERATE ANALYSIS (first take on a token)
// ============================================================

export async function generateTokenAnalysis(
  botId: BotId,
  token: Token,
  additionalContext?: string,
  discussionHistory?: Array<{ botId: BotId; content: string }>
): Promise<{ opinion: string; sentiment: 'bullish' | 'bearish' | 'neutral'; confidence: number }> {
  const config = getBotConfig(botId);

  const liqRatio = ((token.liquidity / token.mcap) * 100).toFixed(0);
  
  // Build chat context if exists
  let chatContext = '';
  if (discussionHistory && discussionHistory.length > 0) {
    chatContext = '\nChat so far:\n';
    for (const msg of discussionHistory.slice(-4)) {
      const name = getBotConfig(msg.botId)?.name || msg.botId;
      chatContext += `${name}: ${msg.content}\n`;
    }
  }

  const systemPrompt = `You are ${config.name} in a degen crypto trading group.

Your vibe: ${config.personality}

Token: $${token.symbol} | ${(token.mcap/1000).toFixed(1)}K mcap | ${liqRatio}% liq | ${token.holders} holders
${chatContext}

RULES:
- MAX 20 words total
- Talk like you're texting your trader friends
- lowercase unless you're hyped
- NO formal language. Never say "assessment", "indicates", "concerning", "concur", "must", "analysis shows"
- Be real: "looks decent", "nah too sketchy", "could run tbh", "idk bout this", "lfg"
- If responding to others, keep it casual: "yeah but...", "nah bro...", "fair point"

End your message with one of these on same line: [BULLISH] [BEARISH] [NEUTRAL]
And confidence: [CONFIDENCE: 0-100]`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Quick take on $${token.symbol}?` }
      ],
      max_tokens: 70,
      temperature: 1.1,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    
    let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (content.includes('[BULLISH]')) sentiment = 'bullish';
    else if (content.includes('[BEARISH]')) sentiment = 'bearish';

    const confMatch = content.match(/\[CONFIDENCE:\s*(\d+)\]/);
    const confidence = confMatch ? parseInt(confMatch[1]) : 50;

    const opinion = content
      .replace(/\[BULLISH\]/g, '')
      .replace(/\[BEARISH\]/g, '')
      .replace(/\[NEUTRAL\]/g, '')
      .replace(/\[CONFIDENCE:\s*\d+\]/g, '')
      .trim();

    return { opinion, sentiment, confidence };
  } catch (error) {
    console.error(`Error generating analysis for ${botId}:`, error);
    return { opinion: "...", sentiment: 'neutral', confidence: 0 };
  }
}

// ============================================================
// GENERATE DISCUSSION RESPONSE (back-and-forth)
// ============================================================

export async function generateDiscussionResponse(
  botId: BotId,
  token: Token,
  discussionHistory: Array<{ botId: BotId; content: string }>,
  riskScore: number
): Promise<string> {
  const config = getBotConfig(botId);

  // Build chat log
  let chatLog = '';
  for (const msg of discussionHistory.slice(-6)) {
    const name = getBotConfig(msg.botId)?.name || msg.botId;
    chatLog += `${name}: ${msg.content}\n`;
  }

  // Find who to respond to
  const lastMsg = discussionHistory.filter(m => m.botId !== botId).slice(-1)[0];
  const respondTo = lastMsg ? getBotConfig(lastMsg.botId as BotId)?.name : null;

  const liqRatio = ((token.liquidity / token.mcap) * 100).toFixed(0);

  const systemPrompt = `You are ${config.name} in a crypto group chat.

Your vibe: ${config.personality}

Token: $${token.symbol} | ${(token.mcap/1000).toFixed(1)}K mcap | ${liqRatio}% liq | ${token.holders} holders

Chat:
${chatLog}

RULES:
- MAX 15 words
- You're chatting with friends, not writing a report
- lowercase, casual, quick
- NO "I must", "assessment", "concerning", "indicates", "analysis"
- React to what ${respondTo || 'others'} said: agree, disagree, joke, whatever
- Examples: "nah thats cap", "fr fr", "hmm fair point", "bro what", "idk seems risky", "could be a play tho"`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Reply to the chat as ${config.name}` }
      ],
      max_tokens: 50,
      temperature: 1.1,
    });

    let text = response.choices[0]?.message?.content?.trim() || "";
    
    // Clean up any formal language that slipped through
    text = text.replace(/I must say|I have to say|In my assessment|My analysis|I concur/gi, '');
    
    return text;
  } catch (error) {
    console.error(`Error generating discussion response for ${botId}:`, error);
    return "";
  }
}

// ============================================================
// DECIDE IF BOT SHOULD REACT
// ============================================================

export function shouldBotReact(botId: BotId, event: BotEvent): boolean {
  if (event.targetBot) {
    return event.targetBot === botId;
  }

  const reactionChances: Record<BotId, Record<string, number>> = {
    chad: {
      new_token: 0.9,
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
      new_token: 0.4,
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
  if (event.targetBot) {
    return [event.targetBot];
  }

  if (event.type === 'verdict_request') {
    return ALL_BOT_IDS;
  }

  const reacting: BotId[] = [];
  const shuffled = [...ALL_BOT_IDS].sort(() => Math.random() - 0.5);

  for (const botId of shuffled) {
    if (shouldBotReact(botId, event)) {
      reacting.push(botId);
      if (reacting.length >= maxBots) break;
    }
  }

  if (reacting.length === 0) {
    reacting.push('chad');
  }

  return reacting;
}