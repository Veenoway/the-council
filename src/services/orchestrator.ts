// ============================================================
// ORCHESTRATOR — Data-driven Council decisions
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { ALL_BOT_IDS, getBotConfig } from '../bots/personalities.js';
import { getNewTokens, calculateRiskScore } from './nadfun.js';
import { executeBotTrade, calculateTradeSize, getBotBalance } from './trading.js';
import { broadcastMessage, broadcastNewToken, broadcastVerdict, onInternalEvent } from './websocket.js';
import { createPosition, saveMessage, saveToken } from '../db/index.js';
import { setCurrentToken as setCurrentTokenInBus } from './messageBus.js';
import { analyzeTechnicals, type TechnicalIndicators } from './technicalAnalysis.js';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { canBotTrade } from './monitor.js';

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// ============================================================
// STATE
// ============================================================

let currentToken: Token | null = null;
let isAnalyzing = false;
let lastTokenScan = 0;
const TOKEN_SCAN_INTERVAL = 60_000; 
const seenTokens = new Set<string>();

// ============================================================
// MAIN LOOP  
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council is now in session');

  onInternalEvent('human_message', async (data) => {
    await handleHumanMessage(data);
  });

  while (true) {
    try {
      if (!isAnalyzing && Date.now() - lastTokenScan > TOKEN_SCAN_INTERVAL) {
        lastTokenScan = Date.now();
        await scanForNewTokens();
      }
      await sleep(5000);
    } catch (error) {
      console.error('Orchestrator error:', error);
      await sleep(10000);
    }
  }
}

async function scanForNewTokens(): Promise<void> {
  try {
    const tokens = await getNewTokens();
    
    for (const token of tokens) {
      if (seenTokens.has(token.address)) continue;
      seenTokens.add(token.address);

      // Filters - accept bigger tokens now
      if (token.mcap < 5000) continue;
      if (token.mcap > 5_000_000) continue;
      if (token.liquidity < 500) continue;

      console.log(`✅ Analyzing $${token.symbol} (mcap: $${(token.mcap/1000).toFixed(1)}K, holders: ${token.holders})`);
      await analyzeToken(token);
      break;
    }
  } catch (error) {
    console.error('Scan error:', error);
  }
}

// ============================================================
// DATA-DRIVEN BOT DECISIONS
// Each bot has different criteria for being bullish
// ============================================================

function getBotDecision(
  botId: BotId, 
  token: Token, 
  ta: TechnicalIndicators | null, 
  riskScore: number
): 'bullish' | 'bearish' | 'neutral' {
  
  const holders = token.holders;
  const mcap = token.mcap;
  const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
  const priceChange = token.priceChange24h || 0;
  const liqRatio = token.liquidity / (mcap || 1);
  
  // Technical indicators
  const rsi = ta?.rsi || 50;
  const trend = ta?.trend || 'sideways';
  const signal = ta?.signal || 'neutral';
  const volumeSpike = ta?.volumeSpike || false;
  const buySellRatio = ta?.buySellRatio || 1;
  
  console.log(`🤖 ${botId} analyzing: holders=${holders}, mcap=${(mcap/1000).toFixed(0)}K, age=${ageHours.toFixed(0)}h, rsi=${rsi.toFixed(0)}, risk=${riskScore}`);

  switch (botId) {
    case 'chad': {
      // James: Degen - loves momentum, doesn't care about risk
      // Bullish if: trending up, volume spike, or just YOLO
      let score = 0;
      if (trend.includes('up')) score += 2;
      if (volumeSpike) score += 2;
      if (priceChange > 0) score += 1;
      if (holders > 1000) score += 1;
      if (mcap > 50000) score += 1;  // Likes bigger plays
      if (rsi > 50 && rsi < 80) score += 1;  // Not oversold
      // James always has some FOMO
      score += Math.random() > 0.3 ? 1 : 0;
      
      if (score >= 4) return 'bullish';
      if (score <= 1) return 'bearish';
      return 'neutral';
    }
    
    case 'quantum': {
      // Keone: Data guy - trusts technicals
      // Bullish if: good RSI, uptrend, buy signal
      let score = 0;
       if (holders > 10000) score += 3;
      else if (holders > 5000) score += 2;
      else if (holders > 1000) score += 1;
      if (ageHours > 24) score += 1;  // Not too new
      if (ageHours > 168) score += 1;  // Week old = more trust
      if (buySellRatio > 1) score += 1;  // Community buying
      if (mcap > 100000) score += 1;  // Established
      if (liqRatio > 0.1) score += 1;  // Good liquidity
      return 'neutral';
    }
    
    case 'sensei': {
      // Portdev: Vibes reader - community focused
      // Bullish if: many holders, good community signs
      let score = 0;
      if (holders > 10000) score += 3;
      else if (holders > 5000) score += 2;
      else if (holders > 1000) score += 1;
      if (ageHours > 24) score += 1;  // Not too new
      if (ageHours > 168) score += 1;  // Week old = more trust
      if (buySellRatio > 1) score += 1;  // Community buying
      if (mcap > 100000) score += 1;  // Established
      if (liqRatio > 0.1) score += 1;  // Good liquidity
      
      if (score >= 4) return 'bullish';
      if (score <= 1 || holders < 100) return 'bearish';
      return 'neutral';
    }
    
    case 'sterling': {
      // Harpal: Risk manager - very careful
      // Bullish only if: low risk, established token
      let score = 0;
        if (holders > 10000) score += 3;
      else if (holders > 5000) score += 2;
      else if (holders > 1000) score += 1;
      if (ageHours > 24) score += 1;  // Not too new
      if (ageHours > 168) score += 1;  // Week old = more trust
      if (buySellRatio > 1) score += 1;  // Community buying
      if (mcap > 100000) score += 1;  // Established
      if (liqRatio > 0.1) score += 1;  // Good liquidity
      
      // Sterling is naturally skeptical
      if (riskScore > 60) return 'bearish';
      if (score >= 5) return 'bullish';
      if (score <= 2) return 'bearish';
      return 'neutral';
    }
    
    case 'oracle': {
      // Mike: Pattern seer - looks for hidden gems
      // Bullish if: sees accumulation patterns, contrarian plays
      let score = 0;
      if (holders > 10000) score += 3;
      else if (holders > 5000) score += 2;
      else if (holders > 1000) score += 1;
      if (ageHours > 24) score += 1;  // Not too new
      if (ageHours > 168) score += 1;  // Week old = more trust
      if (buySellRatio > 1) score += 1;  // Community buying
      if (mcap > 100000) score += 1;  // Established
      if (liqRatio > 0.1) score += 1;  // Good liquidity
      // Mike sometimes sees things others don't
      if (Math.random() > 0.6) score += 1;
      
      if (score >= 4) return 'bullish';
      if (score <= 1) return 'bearish';
      return 'neutral';
    }
    
    default:
      return 'neutral';
  }
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

async function analyzeToken(token: Token): Promise<void> {
  if (isAnalyzing) return;
  isAnalyzing = true;
  currentToken = token;
  setCurrentTokenInBus(token);

  const conversation: Array<{ bot: BotId; msg: string }> = [];
  const opinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {} as any;
  const spokeTimes: Record<BotId, number> = {} as any;
  ALL_BOT_IDS.forEach(b => spokeTimes[b] = 0);

  try {
    broadcastNewToken(token);

    // Fetch data
    const ta = await analyzeTechnicals(token.address);
    const { score: riskScore, flags } = await calculateRiskScore(token);
    
    const ctx = buildContext(token, ta, riskScore, flags);

    // =========================================================
    // CALCULATE DECISIONS FIRST (data-driven)
    // =========================================================
    
    for (const botId of ALL_BOT_IDS) {
      opinions[botId] = getBotDecision(botId, token, ta, riskScore);
      console.log(`📊 ${botId} decision: ${opinions[botId]}`);
    }

    // =========================================================
    // INTRO
    // =========================================================
    
    await say('chad', `yo $${token.symbol} just popped up, ${(token.mcap/1000).toFixed(1)}k mc, ${token.holders} holders`);
    conversation.push({ bot: 'chad', msg: `spotted $${token.symbol}` });
    spokeTimes['chad']++;
    await sleep(1500);

    // Keone presents chart
    const chartSummary = ta ? summarizeChart(ta) : 'not enough candles yet';
    await say('quantum', chartSummary);
    conversation.push({ bot: 'quantum', msg: chartSummary });
    spokeTimes['quantum']++;
    await sleep(1500);

    // =========================================================
    // ROUND 1: First reactions (based on pre-calculated decisions)
    // =========================================================
    
    const firstRoundOrder = shuffle(['chad', 'sensei', 'sterling', 'oracle'] as BotId[]);
    
    for (const botId of firstRoundOrder) {
      const msg = await getFirstReaction(botId, ctx, conversation, opinions[botId]);
      await say(botId, msg);
      conversation.push({ bot: botId, msg });
      spokeTimes[botId]++;
      await sleep(1300);
    }

    // =========================================================
    // ROUND 2: Brief discussion
    // =========================================================
    
    const discussionPlan = planDiscussion(opinions, spokeTimes);
    
    for (const turn of discussionPlan.slice(0, 3)) {  // Max 3 exchanges
      const { speaker, respondTo, type } = turn;
      
      const recentSpeaker = conversation.slice(-2).map(c => c.bot);
      if (recentSpeaker.includes(speaker)) continue;
      
      const msg = await getDiscussionMessage(speaker, respondTo, type, ctx, conversation, opinions);
      
      if (msg) {
        await say(speaker, msg);
        conversation.push({ bot: speaker, msg });
        spokeTimes[speaker]++;
      }
      
      await sleep(1000);
    }

    // =========================================================
    // VOTING - Clear decisions
    // =========================================================
    
    await sleep(600);
    await systemMsg(`🗳️ Council votes on $${token.symbol}`);
    await sleep(800);

    for (const botId of ALL_BOT_IDS) {
      const decision = opinions[botId];
      // Neutral counts as OUT for voting
      const isIn = decision === 'bullish';
      const voteMsg = isIn ? `🟢 I'm in` : `🔴 I'm out`;
      
      await say(botId, voteMsg);
      await sleep(400);
    }

    // =========================================================
    // VERDICT - Simple: BUY or PASS (no watch)
    // If more IN than OUT → BUY, otherwise PASS
    // Neutrals count as OUT, ties go to BUY
    // =========================================================
    
    const inCount = Object.values(opinions).filter(o => o === 'bullish').length;
    const outCount = 5 - inCount; // Everyone else is OUT
    
    // BUY if more IN than OUT (ties go to IN)
    const verdict: 'buy' | 'pass' = inCount >= outCount ? 'buy' : 'pass';
    
    await sleep(500);
    await systemMsg(`📊 ${verdict.toUpperCase()} (${inCount}🟢 / ${outCount}🔴)`);

    await saveToken(token, { tokenAddress: token.address, riskScore, flags, verdict, opinions: {} as any });
    broadcastVerdict(token, verdict, {});

    // =========================================================
    // TRADES - If verdict is BUY, all IN bots trade
    // =========================================================
    
    if (verdict === 'buy' && inCount > 0) {
      await sleep(800);
      
      const bullishBots = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
      console.log(`🎯 Bullish bots trading: ${bullishBots.join(', ')}`);
      
      for (const botId of bullishBots) {
        const { allowed, reason } = await canBotTrade(botId);
        if (!allowed) {
          await say(botId, `wanted to buy but ${reason}`);
          continue;
        }
        
        const balance = await getBotBalance(botId);
        if (balance < 2) {
          await say(botId, `no funds to trade 😢`);
          continue;
        }
        
        const size = calculateTradeSize(botId, balance, 70);
        if (size < 0.5) continue;

        await say(botId, `aping ${size.toFixed(1)} MON 🚀`);
        await sleep(500);

        const trade = await executeBotTrade(botId, token, size, 'buy');
        
        if (trade?.status === 'confirmed') {
         await createPosition({
                botId,
                tokenAddress: token.address,
                tokenSymbol: token.symbol,
                amount: trade.amountOut,       
                entryPrice: token.price,       
                entryValueMon: trade.amountIn, 
                entryTxHash: trade.txHash,
              });
          
          await say(botId, `✅ bought ${trade.amountOut.toFixed(0)} $${token.symbol}`);
        } else {
          await say(botId, `❌ trade failed`);
        }
        
        await sleep(700);
      }
    } else {
      await systemMsg(`Council voted PASS - no trades`);
    }

  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    isAnalyzing = false;
  }
}

// ============================================================
// CONTEXT BUILDER
// ============================================================

interface TokenContext {
  symbol: string;
  mcap: number;
  holders: number;
  riskScore: number;
  flags: string[];
  ta: TechnicalIndicators | null;
  rsi: string;
  trend: string;
  volume: string;
  buyRatio: string;
  volatility: string;
  pattern: string;
  ageHours: number;
}

function buildContext(token: Token, ta: TechnicalIndicators | null, riskScore: number, flags: string[]): TokenContext {
  const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
  
  return {
    symbol: token.symbol,
    mcap: token.mcap,
    holders: token.holders,
    riskScore,
    flags,
    ta,
    ageHours,
    rsi: ta ? `${ta.rsi.toFixed(0)}${ta.rsiSignal !== 'neutral' ? ' ' + ta.rsiSignal : ''}` : '?',
    trend: ta?.trend.replace(/_/g, ' ') || 'unclear',
    volume: ta ? `${ta.volumeRatio.toFixed(1)}x${ta.volumeSpike ? ' spike' : ''}` : '?',
    buyRatio: ta ? `${ta.buySellRatio.toFixed(1)}x` : '?',
    volatility: ta ? `${ta.volatility.toFixed(0)}%` : '?',
    pattern: ta?.patterns.find(p => p.confidence >= 60)?.name || 'none',
  };
}

// ============================================================
// CHART SUMMARY
// ============================================================

function summarizeChart(ta: TechnicalIndicators): string {
  const parts: string[] = [];
  
  if (ta.rsi < 35) parts.push(`rsi ${ta.rsi.toFixed(0)} oversold`);
  else if (ta.rsi > 65) parts.push(`rsi ${ta.rsi.toFixed(0)} hot`);
  else parts.push(`rsi ${ta.rsi.toFixed(0)} neutral`);
  
  if (ta.trend.includes('up')) parts.push('trending up');
  else if (ta.trend.includes('down')) parts.push('trending down');
  else parts.push('sideways');
  
  if (ta.volumeSpike) parts.push(`volume ${ta.volumeRatio.toFixed(1)}x`);
  if (ta.buySellRatio > 1.2) parts.push('more buyers');
  else if (ta.buySellRatio < 0.8) parts.push('more sellers');
  
  return parts.join(', ');
}

// ============================================================
// FIRST REACTION - Takes pre-calculated sentiment
// ============================================================

async function getFirstReaction(
  botId: BotId,
  ctx: TokenContext,
  conversation: Array<{ bot: BotId; msg: string }>,
  sentiment: 'bullish' | 'bearish' | 'neutral'
): Promise<string> {
  
  const personality = getPersonality(botId);
  const focus = getFocus(botId, ctx);
  const recentChat = conversation.slice(-2).map(c => `${c.bot}: ${c.msg}`).join('\n');

  const sentimentGuide = sentiment === 'bullish' 
    ? 'You LIKE this token. Be positive about it.'
    : sentiment === 'bearish'
    ? 'You DONT like this token. Be skeptical.'
    : 'You are UNSURE about this token.';

  const prompt = `You're ${personality.name}, a crypto trader.

Style: ${personality.style}

Token: $${ctx.symbol}
Data you see: ${focus}
${ctx.holders > 5000 ? `Note: ${ctx.holders} holders is strong community!` : ''}
${ctx.ageHours > 24 ? `Note: Token is ${ctx.ageHours.toFixed(0)}h old, established.` : ''}

${sentimentGuide}

Recent chat:
${recentChat}

Give your reaction in 6-12 words. Be natural, match your sentiment.

Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40,
      temperature: 1.1,
    });
    return clean(res.choices[0]?.message?.content || getFallback(botId, sentiment));
  } catch {
    return getFallback(botId, sentiment);
  }
}

// ============================================================
// DISCUSSION
// ============================================================

interface DiscussionTurn {
  speaker: BotId;
  respondTo: BotId;
  type: 'disagree' | 'agree' | 'question' | 'add';
}

function planDiscussion(
  opinions: Record<BotId, string>,
  spokeTimes: Record<BotId, number>
): DiscussionTurn[] {
  const turns: DiscussionTurn[] = [];
  
  const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
  const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');
  
  if (bulls.length > 0 && bears.length > 0) {
    turns.push({ speaker: bears[0], respondTo: bulls[0], type: 'disagree' });
    turns.push({ speaker: bulls[0], respondTo: bears[0], type: 'disagree' });
    if (bulls.length > 1) {
      turns.push({ speaker: bulls[1], respondTo: bears[0], type: 'add' });
    }
  } else {
    const bots = shuffle([...ALL_BOT_IDS]);
    turns.push({ speaker: bots[0], respondTo: bots[1], type: 'agree' });
    turns.push({ speaker: bots[2], respondTo: bots[0], type: 'add' });
  }
  
  return turns;
}

async function getDiscussionMessage(
  speaker: BotId,
  respondTo: BotId,
  type: 'disagree' | 'agree' | 'question' | 'add',
  ctx: TokenContext,
  conversation: Array<{ bot: BotId; msg: string }>,
  opinions: Record<BotId, string>
): Promise<string> {
  
  const personality = getPersonality(speaker);
  const targetName = getPersonality(respondTo).name;
  const targetMsg = conversation.filter(c => c.bot === respondTo).slice(-1)[0]?.msg || '';

  const prompt = `You're ${personality.name} responding to ${targetName}.

Your style: ${personality.style}
You're ${opinions[speaker]}, they're ${opinions[respondTo]}.

They said: "${targetMsg}"

${type === 'disagree' ? 'Push back on them.' : type === 'agree' ? 'Back them up.' : 'Add a new point.'}

Rules: 5-10 words, casual, lowercase

Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 25,
      temperature: 1.1,
    });
    return clean(res.choices[0]?.message?.content || '');
  } catch {
    return '';
  }
}

// ============================================================
// HELPERS
// ============================================================

interface BotPersonality {
  name: string;
  style: string;
}

function getPersonality(botId: BotId): BotPersonality {
  const personalities: Record<BotId, BotPersonality> = {
    chad: { name: 'James', style: 'degen energy, apes first, uses "fr", "ngl", "lfg"' },
    quantum: { name: 'Keone', style: 'data guy, mentions numbers, analytical but chill' },
    sensei: { name: 'Portdev', style: 'vibes reader, community focused, chill energy' },
    sterling: { name: 'Harpal', style: 'risk spotter, careful, "idk about this"' },
    oracle: { name: 'Mike', style: 'mysterious, short sentences, sees patterns, 👁️' },
  };
  return personalities[botId];
}

function getFocus(botId: BotId, ctx: TokenContext): string {
  switch (botId) {
    case 'chad': return `momentum: ${ctx.trend}, price action looking ${ctx.trend.includes('up') ? 'good' : 'mid'}`;
    case 'quantum': return `RSI ${ctx.rsi}, trend ${ctx.trend}, volume ${ctx.volume}`;
    case 'sensei': return `${ctx.holders} holders, buy ratio ${ctx.buyRatio}, community vibes`;
    case 'sterling': return `risk score ${ctx.riskScore}/100, volatility ${ctx.volatility}`;
    case 'oracle': return `pattern: ${ctx.pattern}, hidden signals in the ${ctx.trend}`;
    default: return `${ctx.rsi}, ${ctx.trend}`;
  }
}

function getFallback(botId: BotId, sentiment: 'bullish' | 'bearish' | 'neutral'): string {
  const fallbacks: Record<BotId, Record<string, string[]>> = {
    chad: {
      bullish: ['this could run fr', 'lfg might ape', 'chart looks clean ngl'],
      bearish: ['idk about this one', 'chart looks mid', 'not feeling it'],
      neutral: ['need to see more', 'waiting for confirmation', 'hmm'],
    },
    quantum: {
      bullish: ['data looks solid', 'numbers check out', 'technicals say buy'],
      bearish: ['data not great', 'numbers dont add up', 'technicals weak'],
      neutral: ['mixed signals', 'need more data', 'inconclusive'],
    },
    sensei: {
      bullish: ['community vibes strong', 'good energy here', 'holders look solid'],
      bearish: ['vibes off on this', 'community weak', 'not feeling the energy'],
      neutral: ['vibes unclear', 'need to feel it more', 'watching'],
    },
    sterling: {
      bullish: ['risk acceptable', 'looks safe enough', 'could work'],
      bearish: ['too risky', 'sketch', 'red flags'],
      neutral: ['need more dd', 'on the fence', 'careful here'],
    },
    oracle: {
      bullish: ['i see it 👁️', 'pattern forming', 'hidden gem'],
      bearish: ['bad signs 👁️', 'pattern broken', 'stay away'],
      neutral: ['watching 👁️', 'unclear vision', 'patience'],
    },
  };
  return fallbacks[botId][sentiment][Math.floor(Math.random() * 3)];
}

function clean(msg: string): string {
  return msg
    .replace(/^["']|["']$/g, '')
    .replace(/^\*.*?\*\s*/g, '')
    .replace(/^(just the message:|message:)/i, '')
    .trim()
    .slice(0, 100);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// MESSAGES
// ============================================================

async function say(botId: BotId, content: string): Promise<void> {
  const msg: Message = {
    id: randomUUID(),
    botId,
    content,
    token: currentToken?.address,
    messageType: 'chat',
    createdAt: new Date(),
  };
  await saveMessage(msg);
  broadcastMessage(msg);
}

async function systemMsg(content: string): Promise<void> {
  const msg: Message = {
    id: randomUUID(),
    botId: 'system' as any,
    content,
    messageType: 'system',
    createdAt: new Date(),
  };
  await saveMessage(msg);
  broadcastMessage(msg);
}

async function handleHumanMessage(data: { address: string; content: string }): Promise<void> {
  const msg: Message = {
    id: randomUUID(),
    botId: `human_${data.address}`,
    content: data.content,
    token: currentToken?.address,
    messageType: 'chat',
    createdAt: new Date(),
  };
  await saveMessage(msg);
  broadcastMessage(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export { currentToken, isAnalyzing };