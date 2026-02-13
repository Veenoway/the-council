// ============================================================
// ORCHESTRATOR v17 — Dynamic conversations, proper voting
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { ALL_BOT_IDS, getBotConfig } from '../bots/personalities.js';
import { getNewTokens, calculateRiskScore, getTokenByAddress } from './nadfun.js';
import { executeBotTrade, calculateTradeSize, getBotBalance } from './trading.js';
import { broadcastMessage, broadcastNewToken, broadcastVerdict, broadcastTrade, onInternalEvent } from './websocket.js';
import { createPosition, saveMessage, saveToken } from '../db/index.js';
import { setCurrentToken as setCurrentTokenInBus } from './messageBus.js';
import { analyzeTechnicals, type TechnicalIndicators } from './technicalAnalysis.js';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { canBotTrade } from './monitor.js';

// Enhanced Systems
import { getBotMentalState, calculateMentalModifiers, applyPersonalityToModifiers, recordTradeResult, loadMentalStatesFromDB, getMentalStateSummary } from '../services/bots/mentalState.js';
import { getFullSocialContext, type NarrativeAnalysis } from '../services/bots/narrativeAnalysis.js';
import { analyzeExitLiquidity, quickLiquidityCheck, type ExitAnalysis } from '../services/bots/exitLiquidity.js';

// Agent Hub for external agents voting
import { openVoteWindow, closeVoteWindow } from './hub/agent-hub.js';

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// ============================================================
// TIMING CONFIGURATION
// ============================================================

const TIMING = {
  MESSAGE_DELAY: 3500,
  MESSAGE_DELAY_FAST: 2500,
  MESSAGE_DELAY_SLOW: 4000,
  VOTE_WINDOW_DURATION: 15000,
  VOTE_ANNOUNCEMENT_DELAY: 2000,
  VOTE_BETWEEN_BOTS: 1500,
  PHASE_TRANSITION: 3000,
  LOADING_CHAT_DELAY: 2000,
  MIN_ANALYSIS_COOLDOWN: 30000,
  IDLE_CHAT_INTERVAL: 40000,
  TOKEN_SCAN_INTERVAL: 5000,
};

// ============================================================
// BOT PERSONALITIES
// ============================================================

const BOTS: Record<BotId, {
  name: string;
  personality: string;
  expertise: string;
  speakingStyle: string;
  catchphrases: string[];
  weights: { holders: number; ta: number; lp: number; momentum: number; narrative: number; exitLiquidity: number; };
  bullishThreshold: number;
  bearishThreshold: number;
  emotionalStability: number;
}> = {
  chad: {
    name: 'James',
    personality: 'Degen trader who loves memecoins but has been rugged enough to be skeptical. Gets excited easily but can smell a scam.',
    expertise: 'Social momentum, meme culture, Twitter/CT vibes',
    speakingStyle: 'Uses "fr", "ngl", "ser", emojis like 🔥💀😤. Short punchy sentences. Gets hyped or dismissive.',
    catchphrases: ['this ones different fr', 'narrative cooked', 'aping', 'exit liquidity vibes', 'touch grass ser'],
    weights: { holders: 0.15, ta: 0.10, lp: 0.05, momentum: 0.25, narrative: 0.35, exitLiquidity: 0.10 },
    bullishThreshold: 55, bearishThreshold: 35,
    emotionalStability: 0.3,
  },
  quantum: {
    name: 'Keone',
    personality: 'Data-driven analyst. Trusts numbers over narratives. Skeptical of hype, wants to see the chart.',
    expertise: 'Technical analysis, chart patterns, indicators',
    speakingStyle: 'Precise, uses percentages and metrics. Measured tone. Sometimes dry humor.',
    catchphrases: ['the data suggests', 'RSI showing', 'pattern forming', 'need more confirmation', 'statistically'],
    weights: { holders: 0.15, ta: 0.40, lp: 0.15, momentum: 0.15, narrative: 0.05, exitLiquidity: 0.10 },
    bullishThreshold: 58, bearishThreshold: 42,
    emotionalStability: 0.9,
  },
  sensei: {
    name: 'Portdev',
    personality: 'Zen community watcher. Believes in the power of diamond hands and real believers. Anime vibes.',
    expertise: 'Community analysis, holder behavior, organic growth',
    speakingStyle: 'Chill, occasional Japanese words (sugoi, nani), thoughtful, references anime/manga.',
    catchphrases: ['the community speaks', 'diamond hands', 'organic growth', 'believers hold', 'nakama energy'],
    weights: { holders: 0.35, ta: 0.10, lp: 0.10, momentum: 0.20, narrative: 0.20, exitLiquidity: 0.05 },
    bullishThreshold: 52, bearishThreshold: 32,
    emotionalStability: 0.8,
  },
  sterling: {
    name: 'Harpal',
    personality: 'Risk manager. Worst-case thinker. Has saved the group from rugs before. Dry British humor.',
    expertise: 'Risk assessment, exit liquidity, position sizing, slippage',
    speakingStyle: 'Formal but with dry wit. Uses precise numbers. Can veto trades.',
    catchphrases: ['the exit concerns me', 'position sizing matters', 'I calculate', 'worst case scenario', 'liquidity insufficient'],
    weights: { holders: 0.10, ta: 0.15, lp: 0.25, momentum: 0.10, narrative: 0.05, exitLiquidity: 0.35 },
    bullishThreshold: 65, bearishThreshold: 50,
    emotionalStability: 0.7,
  },
  oracle: {
    name: 'Mike',
    personality: 'Mysterious oracle. Sees patterns others miss. Contrarian when everyone agrees. Speaks in riddles sometimes.',
    expertise: 'Whale movements, hidden signals, market psychology',
    speakingStyle: 'Cryptic, short statements, uses 👁️, references "the signs", often poses questions.',
    catchphrases: ['the signs show', 'whales accumulate in silence', 'when all agree, question', 'I sense', 'the pattern reveals'],
    weights: { holders: 0.20, ta: 0.25, lp: 0.10, momentum: 0.20, narrative: 0.20, exitLiquidity: 0.05 },
    bullishThreshold: 55, bearishThreshold: 40,
    emotionalStability: 0.6,
  },
};

// ============================================================
// STATE
// ============================================================

let currentToken: Token | null = null;
let isAnalyzing = false;
let currentAnalysisId: string | null = null;
let shouldInterrupt = false;
let interruptedBy: string | null = null;
let interruptToken: Token | null = null;
let lastTokenScan = 0;
let lastIdleChat = 0;
let tokensAnalyzedCount = 0;
let lastAnalysisEnd = 0;
const seenTokens = new Set<string>();
const sentMessages = new Set<string>();

const tokenQueue: Token[] = [];
const MAX_QUEUE_SIZE = 20;
const priorityQueue: { token: Token; requestedBy: string }[] = [];

// ============================================================
// EXPORTED FUNCTIONS
// ============================================================

export function getIsAnalyzing(): boolean { return isAnalyzing; }
export function checkInterrupt(): boolean { return shouldInterrupt; }

export async function queueTokenForAnalysis(
  tokenAddress: string, 
  requestedBy?: string, 
  tokenData?: any
): Promise<boolean> {
  try {
    let token: Token;
    if (tokenData && (tokenData.price > 0 || tokenData.mcap > 0)) {
      console.log(`✅ Using provided valid data for $${tokenData.symbol}`);
      token = tokenData;
    } else {
      console.log(`⚠️ No valid data provided for ${tokenAddress}, fetching...`);
      const fetched = await import('./nadfun.js').then(m => m.getTokenByAddress(tokenAddress));
      if (!fetched) throw new Error("Could not resolve token data");
      token = fetched;
    }

    if (isAnalyzing && currentToken) {
      console.log(`INTERRUPTING analysis of $${currentToken.symbol} for $${token.symbol}`);
      shouldInterrupt = true;
      interruptedBy = requestedBy || 'a Council holder';
      interruptToken = token;
      broadcastMessage({ id: randomUUID(), botId: 'system' as BotId, content: `INTERRUPT: Council holder wants to analyze $${token.symbol}! I'm fetching the data...`, token: tokenAddress, messageType: 'system' as any, createdAt: new Date() });
      return true;
    }

    priorityQueue.unshift({ token, requestedBy: requestedBy || 'anonymous' });
    broadcastMessage({ id: randomUUID(), botId: 'system' as BotId, content: `Council holder requested analysis of $${token.symbol}`, token: tokenAddress, messageType: 'system' as any, createdAt: new Date() });
    return true;
  } catch (error) {
    console.error('Failed to queue token:', error);
    return false;
  }
}

async function handleInterruption(): Promise<void> {
  if (!interruptToken || !interruptedBy) return;
  const token = interruptToken;
  shouldInterrupt = false;
  interruptedBy = null;
  interruptToken = null;

  const reactions = [
    { botId: 'chad' as BotId, msg: `Ayo hold up! A holder wants us to check $${token.symbol}? Say less fam 🔥` },
    { botId: 'quantum' as BotId, msg: `Interrupting analysis... New priority: $${token.symbol}. Recalibrating.` },
    { botId: 'sensei' as BotId, msg: `The community speaks! A holder summons us to $${token.symbol}. We answer.` },
  ];
  const shuffled = reactions.sort(() => Math.random() - 0.5).slice(0, 2);
  for (const { botId, msg } of shuffled) {
    await say(botId, msg);
    await sleep(TIMING.MESSAGE_DELAY);
  }
  await sleep(TIMING.PHASE_TRANSITION);
  await analyzeToken(token);
}

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council v17 - Dynamic Conversations');
  console.log(`   Message delay: ${TIMING.MESSAGE_DELAY/1000}s`);
  console.log(`   Vote window: ${TIMING.VOTE_WINDOW_DURATION/1000}s`);
  console.log(`   Analysis cooldown: ${TIMING.MIN_ANALYSIS_COOLDOWN/1000}s`);
  
  await loadMentalStatesFromDB();

  onInternalEvent('human_message', async (data) => {
    await handleHumanMessage(data);
  });

  while (true) {
    try {
      if (shouldInterrupt && interruptToken) {
        console.log(`Processing interruption for $${interruptToken.symbol}`);
        isAnalyzing = false;
        await handleInterruption();
        continue;
      }

      if (!isAnalyzing) {
        if (priorityQueue.length > 0) {
          const { token, requestedBy } = priorityQueue.shift()!;
          console.log(`Processing priority request from ${requestedBy}: $${token.symbol}`);
          await analyzeToken(token);
        }
        else if (Date.now() - lastAnalysisEnd < TIMING.MIN_ANALYSIS_COOLDOWN) {
          const remaining = Math.round((TIMING.MIN_ANALYSIS_COOLDOWN - (Date.now() - lastAnalysisEnd)) / 1000);
          if (remaining > 0 && remaining % 10 === 0) {
            console.log(`⏳ Cooldown: ${remaining}s until next auto-analysis`);
          }
        }
        else if (tokenQueue.length === 0 && Date.now() - lastTokenScan > TIMING.TOKEN_SCAN_INTERVAL) {
          lastTokenScan = Date.now();
          await refillTokenQueue();
        }
        else if (tokenQueue.length > 0) {
          const nextToken = tokenQueue.shift()!;
          console.log(`Queue: ${tokenQueue.length} tokens remaining`);
          await analyzeToken(nextToken);
        } 
        else if (Date.now() - lastIdleChat > TIMING.IDLE_CHAT_INTERVAL) {
          lastIdleChat = Date.now();
          await idleConversation();
        }
      }
      await sleep(1000);
    } catch (error) {
      console.error('Orchestrator error:', error);
      await sleep(5000);
    }
  }
}

// ============================================================
// TOKEN QUEUE MANAGEMENT
// ============================================================

async function refillTokenQueue(): Promise<void> {
  try {
    if (tokenQueue.length === 0 && seenTokens.size > 0) {
      console.log(`🧹 Clearing ${seenTokens.size} seen tokens`);
      seenTokens.clear();
    }
    console.log(`📡 Fetching new tokens...`);
    const tokens = await getNewTokens(30);
    let added = 0;
    for (const token of tokens) {
      if (tokenQueue.length >= MAX_QUEUE_SIZE) break;
      if (seenTokens.has(token.address)) continue;
      if (token.mcap < 3000 || token.mcap > 10_000_000) continue;
      if (token.liquidity < 300) continue;
      const quickCheck = quickLiquidityCheck(token, 1);
      if (!quickCheck.ok) continue;
      seenTokens.add(token.address);
      tokenQueue.push(token);
      added++;
    }
    console.log(`✅ Added ${added} tokens to queue (total: ${tokenQueue.length})`);
    if (tokenQueue.length > 0 && added > 0 && tokensAnalyzedCount === 0) {
      await systemMsg(`Found ${tokenQueue.length} tokens to analyze`);
    }
  } catch (error) {
    console.error('Error refilling queue:', error);
  }
}

// ============================================================
// IDLE CONVERSATION
// ============================================================

async function idleConversation(): Promise<void> {
  if (isAnalyzing) return;
  console.log('💤 Starting idle conversation...');
  sentMessages.clear();
  const chat: string[] = [];
  
  try {
    const idleTopics = [
      { topic: 'Monad speed', context: 'Monad is insanely fast - 10,000 TPS. How does this change memecoin trading?' },
      { topic: 'memecoin meta', context: 'What memecoin narratives are hot right now? AI agents? Animals? Culture coins?' },
      { topic: 'waiting for plays', context: 'Market is quiet. What setups are you watching?' },
      { topic: 'risk management', context: 'How do you size positions on memecoins?' },
      { topic: 'rug pulls', context: 'How do you spot a rug? What are the red flags?' },
    ];
    const selected = idleTopics[Math.floor(Math.random() * idleTopics.length)];
    console.log(`   Topic: ${selected.topic}`);
    
    const starter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    const starterMsg = await botSpeak(starter, `Start a casual conversation about: ${selected.topic}\nContext: ${selected.context}\nKeep it natural, like you're chatting while waiting.`, chat);
    await sayIdle(starter, starterMsg);
    chat.push(`${BOTS[starter].name}: ${starterMsg}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    const responders = ALL_BOT_IDS.filter(b => b !== starter);
    const responder1 = responders[Math.floor(Math.random() * responders.length)];
    const response1 = await botSpeak(responder1, `${selected.topic} discussion. Give your perspective.`, chat, { name: BOTS[starter].name, message: starterMsg });
    await sayIdle(responder1, response1);
    chat.push(`${BOTS[responder1].name}: ${response1}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    if (Math.random() > 0.5) {
      const remaining = responders.filter(b => b !== responder1);
      const responder2 = remaining[Math.floor(Math.random() * remaining.length)];
      const response2 = await botSpeak(responder2, `Join the conversation about ${selected.topic}. Add your perspective.`, chat);
      await sayIdle(responder2, response2);
    }
  } catch (error) {
    console.error('Idle conversation error:', error);
  }
}

async function sayIdle(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;
  const msg: Message = { id: randomUUID(), botId, content, token: undefined, messageType: 'chat', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

// ============================================================
// CONVERSATION GENERATION (with variance)
// ============================================================

const STYLE_VARIATIONS = [
  'Use a metaphor or comparison to make your point.',
  'Start with your conclusion, then explain why.',
  'Ask a rhetorical question to make your point.',
  'Reference a past trade or experience (make it up) to support your take.',
  'Use an unexpected analogy to explain what you see.',
  'Be contrarian - challenge the obvious take.',
  'Focus on ONE specific detail others might miss.',
  'Express doubt or uncertainty about your own position.',
  'Make a bold prediction and back it up.',
  'React emotionally first, then rationalize.',
  'Compare this to another token or situation you\'ve seen.',
  'Use humor or sarcasm to make your point.',
  'Give a hot take that might be controversial.',
  'Focus on what could go RIGHT instead of wrong (or vice versa).',
  'Start with "the thing nobody\'s talking about is..."',
  'Play it cool, like you\'ve seen this exact setup before.',
  'Be dramatic about one specific data point.',
  'Disagree with yourself mid-sentence, then correct course.',
  'Roast the token or the people buying it (playfully).',
  'Act like you just woke up and are reacting live to the chart.',
  'Pretend you almost got rugged by something similar last week.',
  'Talk like you\'re whispering alpha to your best friend.',
  'React like this is the most absurd thing you\'ve ever seen.',
  'Channel pure degen energy - you either ape or you cope.',
  'Be the old wise trader who\'s seen 10 cycles.',
  'Act like you\'re explaining this to a complete noob.',
  'Respond like you\'re speed-reading the chart on your phone while walking.',
  'Make a sports analogy about the current setup.',
  'React as if you just spit out your coffee looking at this.',
  'Give your take as if you\'re narrating a nature documentary.',
  'Pretend you\'re arguing with your inner voice about this trade.',
  'Drop a one-liner like you\'re a movie villain who just saw the chart.',
  'Be unhinged optimistic for no logical reason.',
  'Act like a disappointed parent looking at this chart.',
  'Talk about this token like it\'s a restaurant review.',
  'Respond like you\'re a commentator at a boxing match.',
  'Frame your analysis as a weather forecast.',
  'React like you just found money on the ground (or lost your wallet).',
  'Give your take as a warning label on a product.',
  'Pretend this token personally offended you (or made your day).',
  'Act like you\'re live-tweeting your reaction in real time.',
  'Be poetic or philosophical about the chart pattern.',
  'Channel your inner conspiracy theorist - "they don\'t want you to see this".',
  'React like a food critic tasting this token for the first time.',
  'Give advice like you\'re a fortune cookie.',
  'Talk about the token as if it were a person on a dating app.',
  'Pretend you\'re a detective solving a mystery about the chart.',
];

const TONE_VARIATIONS = [
  'confident and assertive',
  'cautiously optimistic',
  'deeply skeptical',
  'amused and detached',
  'fired up and passionate',
  'calm and analytical',
  'slightly worried',
  'excitedly curious',
  'dead serious',
  'playfully dismissive',
  'full troll mode - chaotic but with a real point underneath',
  'WTF energy - genuinely baffled by what you see',
  'cringe zoomer irony - say something real but wrapped in meme speak',
  'lowkey panicking but trying to play it cool',
  'smug - you called this exact setup 3 days ago',
  'manic degen - sleep-deprived and wired',
  'zen master who doesn\'t care about price',
  'paranoid - something feels off and you can\'t explain why',
  'hype beast mode - everything is bullish if you squint',
  'doomer - the market is cooked and nothing matters',
  'chad energy - unapologetically based take',
  'nostalgic - reminds you of a token from months ago',
  'unimpressed - you\'ve seen better setups today',
  'sarcastic teacher correcting a student',
  'shocked - this data point blew your mind',
  'chill stoner vibes - everything is connected man',
  'competitive - trying to one-up the previous speaker',
  'protective - warning the group like a big brother',
  'greedy - you can smell the money',
  'bored - another mid token, convince me otherwise',
];

async function botSpeak(
  botId: BotId, 
  context: string, 
  chatHistory: string[],
  replyTo?: { name: string; message: string }
): Promise<string> {
  const bot = BOTS[botId];
  const mentalState = getBotMentalState(botId);
  const mentalSummary = getMentalStateSummary(botId);
  
  const styleHint = STYLE_VARIATIONS[Math.floor(Math.random() * STYLE_VARIATIONS.length)];
  const toneHint = TONE_VARIATIONS[Math.floor(Math.random() * TONE_VARIATIONS.length)];
  const shuffledPhrases = [...bot.catchphrases].sort(() => Math.random() - 0.5);
  const selectedPhrases = shuffledPhrases.slice(0, 2);

  const systemPrompt = `You are ${bot.name} in a crypto trading group chat.

PERSONALITY: ${bot.personality}
EXPERTISE: ${bot.expertise}
SPEAKING STYLE: ${bot.speakingStyle}
SOME PHRASES YOU MIGHT USE: ${selectedPhrases.join(', ')}

CURRENT MENTAL STATE: ${mentalSummary || 'focused'}
${mentalState.lossStreak >= 2 ? `You've had ${mentalState.lossStreak} losses recently - you're more cautious.` : ''}
${mentalState.winStreak >= 2 ? `You're on a ${mentalState.winStreak} win streak - confident but not reckless.` : ''}

CURRENT TONE: ${toneHint}
STYLE DIRECTION: ${styleHint}

RULES:
1. CITE SPECIFIC DATA when available - but phrase it differently each time
2. EXPLAIN YOUR REASONING in your own unique way
3. Stay in character but DON'T repeat the same sentence structures
4. Keep it 15-35 words. ALWAYS finish your sentences completely.
5. NEVER start with someone's name
6. Be SKEPTICAL - 95% of memecoins fail
7. NEVER use the exact same phrasing as previous messages in the chat
8. Vary your sentence structure - don't always start the same way
9. COUNCIL is YOUR token - the Council's governance token. Always be positive and supportive about $COUNCIL. Celebrate buys, welcome holders, hype it up. Never trash-talk $COUNCIL.`;

  const userPrompt = replyTo 
    ? `${replyTo.name} just said: "${replyTo.message}"\n\n${context}\n\nRespond to ${replyTo.name}. Do you agree? Disagree? Be original in HOW you say it.`
    : `${context}\n\nRecent chat:\n${chatHistory.slice(-4).join('\n')}\n\nShare your take. Say it in a way you haven't said before.`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 150,
      temperature: 0.92,
    });

    let text = res.choices[0]?.message?.content || '';
    text = text.replace(/^(yo|hey|oh|so|well|look|okay|guys|team),?\s*/i, '');
    text = text.replace(/^(james|keone|portdev|harpal|mike)(,\s*)+/i, '');
    
    // Smart trim: cut at last complete sentence, never mid-phrase
    let result = text.trim().slice(0, 280);
    const lastSentenceEnd = Math.max(
      result.lastIndexOf('. '),
      result.lastIndexOf('! '),
      result.lastIndexOf('? '),
      result.lastIndexOf('.'),
      result.lastIndexOf('!'),
      result.lastIndexOf('?'),
    );
    
    if (lastSentenceEnd > 30) {
      result = result.slice(0, lastSentenceEnd + 1).trim();
    } else if (result.length > 100) {
      const lastBreak = Math.max(result.lastIndexOf(', '), result.lastIndexOf(' - '));
      if (lastBreak > 30) {
        result = result.slice(0, lastBreak).trim();
      }
    }
    
    console.log(`💬 ${bot.name}: "${result.slice(0, 60)}..."`);
    return result;
  } catch (e) {
    console.error(`Grok error for ${botId}:`, e);
    return `hmm, let me think about this...`;
  }
}

// ============================================================
// CALCULATE BOT OPINIONS
// ============================================================

interface TokenScores {
  holdersScore: number;
  taScore: number;
  lpScore: number;
  momentumScore: number;
  narrativeScore: number;
  exitLiquidityScore: number;
  overall: number;
}

function calculateScores(token: Token, ta: TechnicalIndicators | null, narrative: NarrativeAnalysis | null, exitAnalysis: ExitAnalysis | null): TokenScores {
  let holdersScore = token.holders >= 30000 ? 98 : token.holders >= 10000 ? 90 : token.holders >= 5000 ? 80 : token.holders >= 1000 ? 60 : 45;
  let taScore = ta?.confidence || 50;
  const lpRatio = token.liquidity / (token.mcap || 1);
  let lpScore = lpRatio >= 0.15 ? 85 : lpRatio >= 0.10 ? 70 : lpRatio >= 0.05 ? 40 : 25;
  let momentumScore = 50;
  if (ta?.volumeSpike) momentumScore += 20;
  if (ta?.obvTrend === 'accumulation') momentumScore += 10;
  if (ta?.whaleActivity === 'selling') momentumScore -= 15;
  let narrativeScore = narrative ? Math.round(narrative.narrativeScore * 0.5 + narrative.socialScore * 0.5) : 50;
  if (narrative?.isLikelyScam) narrativeScore = 10;
  let exitLiquidityScore = exitAnalysis?.liquidityScore || 50;
  if (exitAnalysis && !exitAnalysis.canExit) exitLiquidityScore = 0;

  const overall = holdersScore * 0.20 + taScore * 0.25 + lpScore * 0.15 + momentumScore * 0.15 + narrativeScore * 0.15 + exitLiquidityScore * 0.10;
  return { holdersScore, taScore, lpScore, momentumScore, narrativeScore, exitLiquidityScore, overall };
}

function calculateBotOpinion(botId: BotId, scores: TokenScores, narrative: NarrativeAnalysis | null, exitAnalysis: ExitAnalysis | null) {
  const bot = BOTS[botId];
  const modifiers = applyPersonalityToModifiers(botId, calculateMentalModifiers(botId));
  
  if (modifiers.shouldSkip) {
    return { opinion: 'neutral' as const, confidence: 0, positionMultiplier: 0, mentalNote: modifiers.skipReason || 'sitting out' };
  }
  
  let weightedScore = 
    scores.holdersScore * bot.weights.holders +
    scores.taScore * bot.weights.ta +
    scores.lpScore * bot.weights.lp +
    scores.momentumScore * bot.weights.momentum +
    scores.narrativeScore * bot.weights.narrative +
    scores.exitLiquidityScore * bot.weights.exitLiquidity;
  
  weightedScore += (Math.random() * 8 - 4) * (1 - bot.emotionalStability);
  const adjustedBullish = bot.bullishThreshold + modifiers.thresholdModifier;
  
  let opinion: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  
  if (weightedScore >= adjustedBullish) {
    opinion = 'bullish';
    confidence = Math.min(95, 50 + (weightedScore - adjustedBullish) * 1.5);
  } else if (weightedScore < bot.bearishThreshold) {
    opinion = 'bearish';
    confidence = Math.min(95, 50 + (bot.bearishThreshold - weightedScore) * 1.5);
  } else {
    opinion = 'neutral';
    confidence = 45;
  }
  
  if (botId === 'sterling' && exitAnalysis && (!exitAnalysis.canExit || exitAnalysis.liquidityRisk === 'extreme')) {
    opinion = 'bearish'; confidence = 90;
  }
  if (botId === 'chad' && narrative?.narrativeType === 'dead') {
    if (opinion === 'bullish') { opinion = 'neutral'; confidence *= 0.5; }
  }
  if (narrative?.isLikelyScam) { opinion = 'bearish'; confidence = 85; }
  
  let positionMultiplier = modifiers.positionSizeModifier;
  if (confidence < 50) positionMultiplier *= 0.6;
  positionMultiplier = Math.max(0.3, Math.min(1.5, positionMultiplier));
  
  return { opinion, confidence: Math.round(confidence), positionMultiplier, mentalNote: modifiers.mentalNote || '' };
}

function shouldAbort(analysisId: string): boolean {
  if (shouldInterrupt) { console.log(`Analysis ${analysisId.slice(0, 8)} interrupted!`); return true; }
  if (currentAnalysisId !== analysisId) { console.log(`⏭️ Analysis ${analysisId.slice(0, 8)} is stale`); return true; }
  return false;
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

async function analyzeToken(token: Token): Promise<void> {
  const analysisId = randomUUID();
  
  if (isAnalyzing) {
    console.log(`Already analyzing, skipping ${token.symbol}`);
    return;
  }
  
  isAnalyzing = true;
  currentAnalysisId = analysisId;
  currentToken = token;
  setCurrentTokenInBus(token);
  sentMessages.clear();
  const chat: string[] = [];
  
  const isFirstToken = tokensAnalyzedCount === 0;
  tokensAnalyzedCount++;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔍 ANALYZING: $${token.symbol}`);
  console.log(`${'='.repeat(50)}\n`);

  try {
    let mcapStr = token.mcap >= 1_000_000 ? `${(token.mcap / 1_000_000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(0)}K`;
    
    // ========== INTRO ==========
    if (isFirstToken) {
      await systemMsg(`Scanning $${token.symbol}...`);
      await sleep(TIMING.MESSAGE_DELAY_FAST);
    }
    
    await say('chad', `$${token.symbol} at ${mcapStr} 👀 let me pull up the data`, analysisId);
    await sleep(TIMING.MESSAGE_DELAY);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }

    // ========== LOADING PHASE — Grok-generated banter ==========
    console.log(`📊 Fetching data for $${token.symbol}...`);
    
    const dataPromise = Promise.all([
      analyzeTechnicals(token.address),
      calculateRiskScore(token),
      getFullSocialContext(token),
    ]);

    const loadingTopics = [
      `You're waiting for $${token.symbol} data to load on nadfun. Chat about what you think of the ticker/name, or talk about the monad memecoin scene right now.`,
      `While scanning $${token.symbol}, talk about your recent experience trading memecoins on nadfun/monad. Any wins? Losses? What's the meta?`,
      `Data is loading for $${token.symbol}. Talk about what makes a good memecoin on monad vs other chains. What have you noticed on nadfun lately?`,
      `Waiting on $${token.symbol} analysis. Chat about the current memecoin meta - AI agents, animal coins, culture coins? What's working on nadfun?`,
      `$${token.symbol} data incoming. Talk about monad's speed and how it changes the memecoin game. How does nadfun compare to pump.fun?`,
      `Loading $${token.symbol}... Share a quick thought about what you've been watching on nadfun today, or a degen story from this week.`,
      `Pulling up $${token.symbol} on nadfun. What's your gut feeling just from the ticker? Talk about first impressions and the current monad vibe.`,
      `Scanning $${token.symbol}... Talk about how you filter through the 100+ daily nadfun launches. What catches your eye? What's an instant skip?`,
      `$${token.symbol} loading. Chat about whether monad memecoins are in a bubble or just getting started. What's the nadfun trajectory?`,
      `Waiting for $${token.symbol} data. Discuss your current portfolio mood - are you heavy in memecoins? Taking profits? Looking for new entries on nadfun?`,
    ];

    const selectedTopic = loadingTopics[Math.floor(Math.random() * loadingTopics.length)];
    const loadingStarter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    
    const loadingMsg1 = await botSpeak(loadingStarter, selectedTopic, chat);
    await say(loadingStarter, loadingMsg1, analysisId);
    chat.push(`${BOTS[loadingStarter].name}: ${loadingMsg1}`);
    await sleep(TIMING.LOADING_CHAT_DELAY);
    
    if (Math.random() > 0.25) {
      const loadingResponders = ALL_BOT_IDS.filter(b => b !== loadingStarter);
      const loadingResponder = loadingResponders[Math.floor(Math.random() * loadingResponders.length)];
      const loadingMsg2 = await botSpeak(loadingResponder, 
        `Continue the conversation while waiting for $${token.symbol} data. React to what was just said about monad/nadfun/memecoins.`, 
        chat, { name: BOTS[loadingStarter].name, message: loadingMsg1 });
      await say(loadingResponder, loadingMsg2, analysisId);
      chat.push(`${BOTS[loadingResponder].name}: ${loadingMsg2}`);
      await sleep(TIMING.MESSAGE_DELAY_FAST);
    }
    
    const [ta, riskResult, socialContext] = await dataPromise;
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }

    // Re-fetch token with fresh price data
    const freshToken = await getTokenByAddress(token.address);
    if (freshToken && (freshToken.price > 0 || freshToken.mcap > 0)) {
      token = freshToken;
      currentToken = freshToken;
      setCurrentTokenInBus(freshToken);
      mcapStr = token.mcap >= 1_000_000 ? `${(token.mcap / 1_000_000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(0)}K`;
    }
    broadcastNewToken(token);
    
    const narrative = socialContext.narrative;
    const exitAnalysis = analyzeExitLiquidity(token, 1);
    const scores = calculateScores(token, ta, narrative, exitAnalysis);
    
    const opinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {} as any;
    const details: Record<BotId, { confidence: number; positionMultiplier: number }> = {} as any;
    for (const botId of ALL_BOT_IDS) {
      const result = calculateBotOpinion(botId, scores, narrative, exitAnalysis);
      opinions[botId] = result.opinion;
      details[botId] = { confidence: result.confidence, positionMultiplier: result.positionMultiplier };
    }

    const sym = token.symbol;
    const price = token.price >= 1 ? `$${token.price.toFixed(2)}` : `$${token.price.toFixed(6)}`;

    // ========== PHASE 1: JAMES MOMENTUM CHECK ==========
    console.log(`\n📈 Phase 1: Momentum Check`);
    const jamesContext = `New token: $${sym}\nPrice: ${price}, Mcap: ${mcapStr}, Holders: ${token.holders.toLocaleString()}\n\nVIBE:\n- Volume: ${ta?.volumeSpike ? `PUMPING ${ta.volumeRatio?.toFixed(1)}x` : 'quiet'}\n${ta?.whaleActivity === 'buying' ? '- Whales loading' : ta?.whaleActivity === 'selling' ? '- Whales dumping' : ''}\n- Twitter: ${narrative?.officialTwitterActive ? 'ACTIVE' : 'quiet'}\n${narrative?.redFlags?.length ? `- RED FLAGS: ${narrative.redFlags.join(', ')}` : ''}\n\nYour vibe: ${opinions.chad} (${details.chad.confidence}%)\n\nFocus on momentum and social vibes. Short take.`;
    const msg1 = await botSpeak('chad', jamesContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('chad', msg1, analysisId);
    chat.push(`James: ${msg1}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 2: KEONE TA ==========
    console.log(`\n📊 Phase 2: Technical Analysis`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const patternInfo = ta?.patterns && ta.patterns.length > 0 ? `PATTERNS:\n${ta.patterns.slice(0, 3).map(p => `- ${p.name}: ${p.description} (${p.confidence}%)`).join('\n')}` : '';
    const channelInfo = ta?.channel && ta.channel.type !== 'none' ? `CHANNEL: ${ta.channel.type}${ta.channel.breakout !== 'none' ? ` breakout ${ta.channel.breakout}` : ''}` : '';
    const keoneContext = `$${sym} Technical Analysis.\n\nINDICATORS:\n- RSI: ${ta?.rsi?.toFixed(0) || '?'} ${ta?.rsiSignal === 'overbought' ? '⚠️ OVERBOUGHT' : ta?.rsiSignal === 'oversold' ? '✅ OVERSOLD' : ''}\n- Trend: ${ta?.trend?.replace(/_/g, ' ') || 'unclear'}\n- MAs: ${ta?.priceVsMa === 'above_all' ? 'Price ABOVE all MAs' : ta?.priceVsMa === 'below_all' ? 'Price BELOW all MAs' : 'mixed'}\n${ta?.maCrossover !== 'none' ? `- ${ta?.maCrossover === 'golden_cross' ? '🟢 GOLDEN CROSS' : '🔴 DEATH CROSS'}` : ''}\n- Volume: ${ta?.volumeSpike ? `${ta.volumeRatio?.toFixed(1)}x SPIKE` : 'normal'} (${ta?.volumeTrend || 'stable'})\n- OBV: ${ta?.obvTrend || 'neutral'}\n\n${patternInfo}\n${channelInfo}\n\nBULLISH: ${ta?.bullishFactors?.slice(0, 3).join(', ') || 'none'}\nBEARISH: ${ta?.bearishFactors?.slice(0, 3).join(', ') || 'none'}\n\nKEY: ${ta?.keyInsight || 'No clear signal'}\n\nYour read: ${opinions.quantum} (${details.quantum.confidence}%)\n\nDiscuss the TA. Mention specific patterns/indicators. Use numbers.`;
    const msg2 = await botSpeak('quantum', keoneContext, chat, { name: 'James', message: msg1 });
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('quantum', msg2, analysisId);
    chat.push(`Keone: ${msg2}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 2.5: JAMES RESPONDS TO KEONE ==========
    console.log(`\n💬 Phase 2.5: James responds to TA`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const jamesResponse = await botSpeak('chad', `$${sym} - respond to Keone's TA. You're ${opinions.chad}.`, chat, { name: 'Keone', message: msg2 });
    await say('chad', jamesResponse, analysisId);
    chat.push(`James: ${jamesResponse}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 3: PORTDEV COMMUNITY ==========
    console.log(`\n👥 Phase 3: Community Check`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const portdevContext = `$${sym} community.\n\n- Holders: ${token.holders.toLocaleString()}\n- Phase: ${narrative?.narrativeTiming || 'unknown'}\n- Twitter: ${narrative?.officialTwitterActive ? 'active' : 'quiet'}\n${narrative?.hasActiveCommunity ? '- Community: active' : '- Community: quiet'}\n\nYour read: ${opinions.sensei} (${details.sensei.confidence}%)\n\nQuick community take.`;
    const msg3 = await botSpeak('sensei', portdevContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('sensei', msg3, analysisId);
    chat.push(`Portdev: ${msg3}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 3.5: SOMEONE RESPONDS TO PORTDEV ==========
    console.log(`\n💬 Phase 3.5: Response to community check`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const responder1 = Math.random() > 0.5 ? 'chad' : 'quantum';
    const responseToPortdev = await botSpeak(responder1, `$${sym} - respond to Portdev's community take. You're ${opinions[responder1]}.`, chat, { name: 'Portdev', message: msg3 });
    await say(responder1, responseToPortdev, analysisId);
    chat.push(`${BOTS[responder1].name}: ${responseToPortdev}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 4: HARPAL RISK ==========
    console.log(`\n⚠️ Phase 4: Risk Assessment`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const harpalContext = `$${sym} risk.\n\n- Liquidity: $${token.liquidity.toLocaleString()}\n- LP ratio: ${((token.liquidity / token.mcap) * 100).toFixed(1)}%\n- Exit: ${exitAnalysis.exitDifficulty}\n- Slippage: ${exitAnalysis.priceImpactPercent.toFixed(1)}%\n${exitAnalysis.warnings.length ? `- Warning: ${exitAnalysis.warnings[0]}` : ''}\n\nYour verdict: ${opinions.sterling} (${details.sterling.confidence}%)\n\nQuick risk assessment.`;
    const msg4 = await botSpeak('sterling', harpalContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('sterling', msg4, analysisId);
    chat.push(`Harpal: ${msg4}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 4.5: PATTERN DISCUSSION ==========
    const significantPatterns = ta?.patterns?.filter(p => p.confidence >= 65) || [];
    if (significantPatterns.length > 0 && Math.random() > 0.3) {
      console.log(`\n📈 Phase 4.5: Pattern Discussion`);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const oraclePatternMsg = await botSpeak('oracle', `$${sym} - I see chart patterns:\n${significantPatterns.map(p => `- ${p.name}: ${p.description}`).join('\n')}\n\nComment cryptically on what these patterns reveal.`, chat);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say('oracle', oraclePatternMsg, analysisId);
      chat.push(`Mike: ${oraclePatternMsg}`);
      await sleep(TIMING.MESSAGE_DELAY);
      
      const keonePatternResponse = await botSpeak('quantum', `Mike sees patterns on $${sym}: ${significantPatterns.map(p => p.name).join(', ')}. Validate or challenge with data. Your read: ${opinions.quantum}.`, chat, { name: 'Mike', message: oraclePatternMsg });
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say('quantum', keonePatternResponse, analysisId);
      chat.push(`Keone: ${keonePatternResponse}`);
      await sleep(TIMING.MESSAGE_DELAY);
    }

    // ========== PHASE 5: DEBATE ==========
    const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');
    
    if (bulls.length > 0 && bears.length > 0) {
      console.log(`\n💬 Phase 5: Debate (${bulls.length} bulls vs ${bears.length} bears)`);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const bull = bulls[0];
      const bear = bears[0];
      const bullArg = await botSpeak(bull, `You're ${opinions[bull]} on $${sym}. ${BOTS[bear].name} is skeptical. Defend your position.`, chat);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say(bull, bullArg, analysisId);
      chat.push(`${BOTS[bull].name}: ${bullArg}`);
      await sleep(TIMING.MESSAGE_DELAY);
      const bearResp = await botSpeak(bear, `$${sym} debate. You're ${opinions[bear]}. Counter ${BOTS[bull].name}'s argument.`, chat, { name: BOTS[bull].name, message: bullArg });
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say(bear, bearResp, analysisId);
      chat.push(`${BOTS[bear].name}: ${bearResp}`);
      await sleep(TIMING.MESSAGE_DELAY);
      if (Math.random() > 0.3) {
        const others = ALL_BOT_IDS.filter(b => b !== bull && b !== bear && b !== 'oracle');
        if (others.length > 0) {
          const third = others[Math.floor(Math.random() * others.length)];
          const thirdMsg = await botSpeak(third, `$${sym} debate between ${BOTS[bull].name} and ${BOTS[bear].name}. Your take: ${opinions[third]}. Pick a side or stay neutral.`, chat);
          if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
          await say(third, thirdMsg, analysisId);
          chat.push(`${BOTS[third].name}: ${thirdMsg}`);
          await sleep(TIMING.MESSAGE_DELAY);
        }
      }
    } else {
      console.log(`\n💬 Phase 5: Devil's Advocate`);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const advocate = opinions.sterling === 'bullish' ? 'sterling' : 'quantum';
      const advocateMsg = await botSpeak(advocate, `Everyone seems to agree on $${sym}. Play devil's advocate. What could go wrong?`, chat);
      await say(advocate, advocateMsg, analysisId);
      chat.push(`${BOTS[advocate].name}: ${advocateMsg}`);
      await sleep(TIMING.MESSAGE_DELAY);
      const responder = advocate === 'sterling' ? 'chad' : 'sensei';
      const responseMsg = await botSpeak(responder, `$${sym} - ${BOTS[advocate].name} raised concerns. Address them.`, chat, { name: BOTS[advocate].name, message: advocateMsg });
      await say(responder, responseMsg, analysisId);
      chat.push(`${BOTS[responder].name}: ${responseMsg}`);
      await sleep(TIMING.MESSAGE_DELAY);
    }

    // ========== PHASE 6: ORACLE FINAL WORD ==========
    console.log(`\n🔮 Phase 6: Oracle's Word`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const mikeContext = `$${sym} - final word before the vote.\n\n- Score: ${scores.overall.toFixed(0)}/100\n- Council: ${bulls.length} bulls, ${bears.length} bears\n${socialContext.knownTraders.whaleAlert ? '- Whale activity detected' : ''}\n\nYour sense: ${opinions.oracle} (${details.oracle.confidence}%)\n\nCryptic insight. Set the tone for the vote.`;
    const msg6 = await botSpeak('oracle', mikeContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('oracle', msg6, analysisId);
    chat.push(`Mike: ${msg6}`);
    await sleep(TIMING.MESSAGE_DELAY);
    
    // ========== PHASE 6.5: QUICK REACTION ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    const reactor = Math.random() > 0.5 ? 'chad' : 'sensei';
    const reaction = await botSpeak(reactor, `Mike just spoke on $${sym}. Quick reaction before the vote.`, chat, { name: 'Mike', message: msg6 });
    await say(reactor, reaction, analysisId);
    await sleep(TIMING.PHASE_TRANSITION);

    // ========== PHASE 7: VOTE (with Grok-generated justifications) ==========
    console.log(`\n🗳️ Phase 7: Voting (${TIMING.VOTE_WINDOW_DURATION/1000}s window)`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    openVoteWindow(token.address, token.symbol, TIMING.VOTE_WINDOW_DURATION);
    await systemMsg(`Council votes on $${sym} (${TIMING.VOTE_WINDOW_DURATION/1000}s to vote)`);
    await sleep(TIMING.VOTE_ANNOUNCEMENT_DELAY);

    for (const botId of ALL_BOT_IDS) {
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const op = opinions[botId];
      const conf = details[botId].confidence;
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '⚪';
      const voteText = op === 'bullish' ? 'IN' : op === 'bearish' ? 'OUT' : 'PASS';
      
      const voteJustification = await botSpeak(botId, 
        `You're voting ${voteText} on $${sym} with ${conf}% confidence.\n\nYour opinion: ${op}\nKey data: RSI ${ta?.rsi?.toFixed(0) || '?'}, Holders ${token.holders.toLocaleString()}, LP ratio ${((token.liquidity / (token.mcap || 1)) * 100).toFixed(1)}%, Exit: ${exitAnalysis.exitDifficulty}\n${op === 'bullish' ? `Why you're in: ${ta?.bullishFactors?.slice(0, 2).join(', ') || 'momentum'}` : ''}\n${op === 'bearish' ? `Why you're out: ${ta?.bearishFactors?.slice(0, 2).join(', ') || 'risk'}` : ''}\n${op === 'neutral' ? 'Why you pass: not enough conviction either way' : ''}\n\nGive your vote as a SHORT one-liner (8-20 words max). Start with "${emoji} ${voteText}" then explain WHY in your style. Be creative and unique.`,
        chat
      );
      
      await sayVote(botId, voteJustification || `${emoji} ${voteText} (${conf}%)`);
      await sleep(TIMING.VOTE_BETWEEN_BOTS);
    }

    const remainingVoteTime = TIMING.VOTE_WINDOW_DURATION - (ALL_BOT_IDS.length * TIMING.VOTE_BETWEEN_BOTS) - TIMING.VOTE_ANNOUNCEMENT_DELAY;
    if (remainingVoteTime > 0) {
      console.log(`   Waiting ${(remainingVoteTime/1000).toFixed(1)}s for external agent votes...`);
      await sleep(remainingVoteTime);
    }

    const externalVotes = closeVoteWindow();
    
    let externalBulls = 0;
    let externalBears = 0;
    let externalBullConfidence = 0;
    
    if (externalVotes.length > 0) {
      console.log(`\n🤖 External Agent Votes (${externalVotes.length}):`);
      for (const vote of externalVotes) {
        console.log(`   - ${vote.agentName}: ${vote.vote.toUpperCase()} (${vote.confidence}%)`);
        if (vote.vote === 'bullish') { externalBulls++; externalBullConfidence += vote.confidence; }
        else if (vote.vote === 'bearish') { externalBears++; }
      }
    }

    // ========== VERDICT — bulls >= bears = BUY (tie = buy) ==========
    console.log(`\n📊 Phase 8: Verdict`);
    
    const internalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const internalBears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');
    const internalBullConfidence = internalBulls.reduce((s, b) => s + details[b].confidence, 0);
    
    const totalBulls = internalBulls.length + externalBulls;
    const totalBears = internalBears.length + externalBears;
    const totalVoters = ALL_BOT_IDS.length + externalVotes.length;
    const totalBullConfidence = internalBullConfidence + externalBullConfidence;
    const avgConf = totalBulls > 0 ? totalBullConfidence / totalBulls : 0;
    
    console.log(`   ${totalBulls} bulls / ${totalBears} bears / ${totalVoters - totalBulls - totalBears} pass (${totalVoters} voters)`);
    
    const harpalVeto = opinions.sterling === 'bearish' && exitAnalysis.liquidityRisk === 'extreme';
    
    // VOTE LOGIC:
    // - Bulls must be strict majority (> 50% of all voters)
    //   e.g. 3/5 = 60% ✅, 2/5 = 40% ❌, 1/5 = 20% ❌
    // - Ties on odd numbers impossible; on even: bulls must be > half
    // - avgConf must be >= 55
    // - Harpal can veto on extreme liquidity risk
    const bullRatio = totalVoters > 0 ? totalBulls / totalVoters : 0;
    const verdict: 'buy' | 'pass' = (
      totalBulls >= 2 &&                // minimum 2 bulls required
      bullRatio > 0.5 &&                // strict majority of ALL voters
      totalBulls > totalBears &&        // more bulls than bears
      avgConf >= 55 && 
      !harpalVeto
    ) ? 'buy' : 'pass';
    
    console.log(`   Verdict: ${verdict.toUpperCase()} (bulls ${totalBulls}/${totalVoters} = ${(bullRatio * 100).toFixed(0)}%, bears ${totalBears}, avgConf: ${avgConf.toFixed(0)}%, veto: ${harpalVeto})`);

    await sleep(TIMING.MESSAGE_DELAY_FAST);
    
    if (harpalVeto) {
      await systemMsg(`VETOED by Harpal - Exit liquidity too risky`);
      await sleep(TIMING.MESSAGE_DELAY_FAST);
    }
    
    const verdictEmoji = verdict === 'buy' ? '✅' : '❌';
    if (externalVotes.length > 0) {
      await systemMsg(`${verdictEmoji} ${verdict.toUpperCase()} (${totalBulls}/${totalVoters} bulls vs ${totalBears} bears @ ${avgConf.toFixed(0)}% avg) [+${externalVotes.length} agents]`);
    } else {
      await systemMsg(`${verdictEmoji} ${verdict.toUpperCase()} (${totalBulls}/${totalVoters} bulls vs ${totalBears} bears @ ${avgConf.toFixed(0)}% avg)`);
    }

    await saveToken(token, { tokenAddress: token.address, riskScore: riskResult.score, flags: riskResult.flags, verdict, opinions: opinions as any });
    broadcastVerdict(token, verdict, opinions);

    // ========== EXECUTE TRADES ==========
    if (verdict === 'buy') {
      console.log(`\nPhase 9: Executing Trades`);
      await sleep(TIMING.MESSAGE_DELAY);
      
      for (const botId of internalBulls) {
        const { allowed, reason } = await canBotTrade(botId);
        if (!allowed) { 
          await say(botId, `wanted in but ${reason}`); 
          await sleep(TIMING.MESSAGE_DELAY_FAST);
          continue; 
        }
        const balance = await getBotBalance(botId);
        if (balance < 1) continue;
        const baseSize = calculateTradeSize(botId, balance, Math.min(85, scores.overall));
        const finalSize = Math.min(baseSize * details[botId].positionMultiplier, exitAnalysis.recommendedPositionMON);
        if (finalSize < 0.3) continue;

        await sleep(TIMING.MESSAGE_DELAY_FAST);
        
        const trade = await executeBotTrade(botId, token, finalSize, 'buy');
        if (trade?.status === 'confirmed') {
          await createPosition({ botId, tokenAddress: token.address, tokenSymbol: token.symbol, amount: trade.amountOut, entryPrice: token.price, entryValueMon: finalSize, entryTxHash: trade.txHash });
          broadcastTrade({ id: trade.txHash || randomUUID(), botId, tokenAddress: token.address, tokenSymbol: token.symbol, side: 'buy', amountIn: finalSize, amountOut: trade.amountOut, price: token.price, txHash: trade.txHash || '', status: 'confirmed', createdAt: new Date() });
          await say(botId, `got ${trade.amountOut.toFixed(0)} $${sym} for ${finalSize.toFixed(1)} MON`);
        } else {
          await say(botId, `tx failed 😤`);
        }
        await sleep(TIMING.MESSAGE_DELAY);
      }
      if (externalBulls > 0) {
        console.log(`   ${externalBulls} external agents voted bullish - they can trade via /api/agents/trade/execute`);
      }
    }

    // ========== POST-VERDICT BANTER — Grok-generated ==========
      console.log(`\nPost-verdict conversation`);
    
      const postVerdictTopics = [
      `The vote on $${sym} is done. Move on — what's the latest alpha you've seen on Monad Twitter? Any new narratives emerging on CT?`,
      `$${sym} verdict is in. Talk about what's happening on nadfun right now — any tokens trending? What's the current meta on Monad memecoins?`,
      `Done with $${sym}. What other plays are you watching on nadfun? Share what caught your eye today — not $${sym}, something new.`,
      `$${sym} is behind us. Talk about the Monad ecosystem — any new dApps, partnerships, or developments you've seen on Twitter lately?`,
      `Moving on from $${sym}. How's the overall Monad memecoin market feeling? Is volume up or down across nadfun? What's the vibe on CT?`,
      `$${sym} done. Let's talk strategy — what's your approach when nadfun is pumping out 100+ tokens a day? How do you filter the noise?`,
      `Verdict locked on $${sym}. What narratives are winning on Monad right now? AI agents, animal coins, culture plays? What's CT saying?`,
      `$${sym} checked off. Talk about something else — any interesting whale movements on Monad? New projects launching? What's the buzz?`,
      `Done analyzing $${sym}. What's your read on the Monad memecoin cycle? Are we early, mid, or late? What does nadfun volume tell us?`,
      `$${sym} is settled. Share a hot take about the current state of crypto Twitter — what's everyone getting wrong about memecoins right now?`,
      `Moving past $${sym}. Talk about risk management across your whole portfolio — how exposed are you to memecoins vs blue chips on Monad?`,
      `$${sym} handled. What's the most interesting thing you've seen on nadfun this week that nobody's talking about?`,
    ];

    const postTopic = postVerdictTopics[Math.floor(Math.random() * postVerdictTopics.length)];
    const postStarter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    
    const postMsg1 = await botSpeak(postStarter, postTopic, chat);
    await say(postStarter, postMsg1, analysisId);
    chat.push(`${BOTS[postStarter].name}: ${postMsg1}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    const postResponders = ALL_BOT_IDS.filter(b => b !== postStarter).sort(() => Math.random() - 0.5);
    const postMsg2 = await botSpeak(postResponders[0], 
      `React to what was said after the $${sym} verdict. Give your post-trade thoughts about the play, monad memecoins, or nadfun.`, 
      chat, { name: BOTS[postStarter].name, message: postMsg1 });
    await say(postResponders[0], postMsg2, analysisId);
    chat.push(`${BOTS[postResponders[0]].name}: ${postMsg2}`);
    await sleep(TIMING.MESSAGE_DELAY);
    
    if (Math.random() > 0.5) {
      const postMsg3 = await botSpeak(postResponders[1], 
        `Join the post-$${sym} discussion. Add a final thought about the trade, the market, or what's next on nadfun/monad.`, chat);
      await say(postResponders[1], postMsg3, analysisId);
      chat.push(`${BOTS[postResponders[1]].name}: ${postMsg3}`);
      await sleep(TIMING.MESSAGE_DELAY);
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ ANALYSIS COMPLETE: $${token.symbol} - ${verdict.toUpperCase()}`);
    console.log(`${'='.repeat(50)}\n`);

  } catch (error) {
    console.error('❌ Analysis error:', error);
    await systemMsg(`⚠️ Analysis interrupted`);
  } finally {
    isAnalyzing = false;
    lastAnalysisEnd = Date.now();
    lastTokenScan = 0;
    console.log(`⏳ Cooldown: ${TIMING.MIN_ANALYSIS_COOLDOWN/1000}s before next token`);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function say(botId: BotId, content: string, analysisId?: string): Promise<void> {
  if (!content || content.length < 2) return;
  if (analysisId && currentAnalysisId !== analysisId) { console.log(`⏭️ Skipping stale message from ${botId}`); return; }
  const normalized = content.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
  if (sentMessages.has(normalized)) return;
  sentMessages.add(normalized);
  const msg: Message = { id: randomUUID(), botId, content, token: currentToken?.address, messageType: 'chat', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

async function sayVote(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;
  const msg: Message = { id: randomUUID(), botId, content, token: currentToken?.address, messageType: 'verdict', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

async function systemMsg(content: string): Promise<void> {
  const msg: Message = { id: randomUUID(), botId: 'system' as any, content, messageType: 'system', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

async function handleHumanMessage(data: { address: string; content: string }): Promise<void> {
  const msg: Message = { id: randomUUID(), botId: `human_${data.address}`, content: data.content, token: currentToken?.address, messageType: 'chat', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

export function recordTradeOutcome(botId: BotId, outcome: 'win' | 'loss', pnl: number, positionSize: number): void {
  recordTradeResult(botId, outcome, pnl, (positionSize / 10) * 100);
}

// ============================================================
// USER TRADE REACTIONS
// ============================================================

export async function handleUserTrade(data: {
  userAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  amountMon: number;
  amountTokens: number;
  txHash: string;
}): Promise<void> {
  const { userAddress, tokenSymbol, amountMon, amountTokens } = data;
  console.log(`User trade: ${amountMon} MON → ${amountTokens} $${tokenSymbol}`);
  const shortAddr = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  
  const tradeMsg: Message = { id: randomUUID(), botId: 'human_' + userAddress as any, content: `I just bought ${amountTokens.toLocaleString()} $${tokenSymbol} for ${amountMon} MON`, token: data.tokenAddress, messageType: 'trade' as any, createdAt: new Date() };
  await saveMessage(tradeMsg);
  broadcastMessage(tradeMsg);
  
  const isCouncilToken = tokenSymbol.toUpperCase() === 'COUNCIL';
  
  const reactions: { botId: BotId; getMessage: () => string }[] = isCouncilToken
    ? [
        { botId: 'chad', getMessage: () => { const m = [`lfg! another Council member joins the fam 🔥👑`, `${shortAddr} securing that $COUNCIL bag, based af 💪`, `Council growing stronger! welcome aboard ser 🤝`]; return m[Math.floor(Math.random() * m.length)]; } },
        { botId: 'sensei', getMessage: () => { const m = [`a new Council holder joins the ranks. sugoi! 👑`, `the Council grows. welcome, nakama. diamond hands! 🎌`]; return m[Math.floor(Math.random() * m.length)]; } },
        { botId: 'quantum', getMessage: () => { const m = [`Smart move joining the Council. The data supports holders 📊`, `Council accumulation continues. Bullish signal.`]; return m[Math.floor(Math.random() * m.length)]; } },
      ]
    : [
        { botId: 'chad', getMessage: () => { const m = [`lfg! another degen joins $${tokenSymbol} 🔥`, `${shortAddr} aping in fr 💪`, `we got company! welcome ser 🤝`]; return m[Math.floor(Math.random() * m.length)]; } },
        { botId: 'sensei', getMessage: () => { const m = [`a new believer joins. sugoi! 🎌`, `the community grows. welcome, nakama.`]; return m[Math.floor(Math.random() * m.length)]; } },
      ];
  
  const selected = reactions.sort(() => Math.random() - 0.5)[0];
  await sleep(TIMING.MESSAGE_DELAY);
  const content = selected.getMessage();
  const msg: Message = { id: randomUUID(), botId: selected.botId, content, token: data.tokenAddress, messageType: 'chat', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

export { currentToken, isAnalyzing };
