// ============================================================
// ORCHESTRATOR v16 — Slower pace, longer vote windows
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
// TIMING CONFIGURATION — Plus de temps pour les discussions
// ============================================================

const TIMING = {
  // Message delays (in ms)
  MESSAGE_DELAY: 3500,           // 3.5s between bot messages
  MESSAGE_DELAY_FAST: 2500,      // 2.5s for quick reactions
  MESSAGE_DELAY_SLOW: 4500,      // 4.5s for thoughtful responses
  
  // Vote timing
  VOTE_WINDOW_DURATION: 15000,   // 15s for external agents to vote
  VOTE_ANNOUNCEMENT_DELAY: 2000, // 2s after announcing vote
  VOTE_BETWEEN_BOTS: 1500,       // 1.5s between each bot vote
  
  // Analysis phases
  PHASE_TRANSITION: 3000,        // 3s between analysis phases
  LOADING_CHAT_DELAY: 3000,      // 3s for loading messages
  
  // Cooldowns
  MIN_ANALYSIS_COOLDOWN: 30000,  // 30s minimum between tokens
  IDLE_CHAT_INTERVAL: 60000,     // 60s before idle chat
  TOKEN_SCAN_INTERVAL: 5000,     // 5s between token scans
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

export function getIsAnalyzing(): boolean {
  return isAnalyzing;
}

export function checkInterrupt(): boolean {
  return shouldInterrupt;
}

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
      
      if (!fetched) {
         throw new Error("Could not resolve token data");
      }
      token = fetched;
    }

    if (isAnalyzing && currentToken) {
      console.log(`INTERRUPTING analysis of $${currentToken.symbol} for $${token.symbol}`);
      shouldInterrupt = true;
      interruptedBy = requestedBy || 'a Council holder';
      interruptToken = token;
      
      broadcastMessage({
        id: randomUUID(),
        botId: 'system' as BotId,
        content: `INTERRUPT: Council holder wants to analyze $${token.symbol}!`,
        token: tokenAddress,
        messageType: 'system' as any,
        createdAt: new Date(),
      });

      return true;
    }

    priorityQueue.unshift({ token, requestedBy: requestedBy || 'anonymous' });
    
    broadcastMessage({
      id: randomUUID(),
      botId: 'system' as BotId,
      content: `Council holder requested analysis of $${token.symbol}`,
      token: tokenAddress,
      messageType: 'system' as any,
      createdAt: new Date(),
    });

    return true;
  } catch (error) {
    console.error('Failed to queue token:', error);
    return false;
  }
}

async function handleInterruption(): Promise<void> {
  if (!interruptToken || !interruptedBy) return;

  const token = interruptToken;
  const requester = interruptedBy;

  shouldInterrupt = false;
  interruptedBy = null;
  interruptToken = null;

  const reactions = [
    { botId: 'chad' as BotId, msg: `Ayo hold up! A holder wants us to check $${token.symbol}? Say less fam 🔥` },
    { botId: 'quantum' as BotId, msg: `Interrupting analysis... New priority: $${token.symbol}. Recalibrating.` },
    { botId: 'sensei' as BotId, msg: `The community speaks! A holder summons us to $${token.symbol}. We answer.` },
  ];

  const shuffled = reactions.sort(() => Math.random() - 0.5);
  const reactingBots = shuffled.slice(0, 2);

  for (const { botId, msg } of reactingBots) {
    await say(botId, msg);
    await sleep(TIMING.MESSAGE_DELAY);
  }

  await sleep(TIMING.PHASE_TRANSITION);
  // FIXED: await to ensure full analysis (including vote + trade) completes
  await analyzeToken(token);
}

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council v16 - Slower Pace Edition');
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
          // FIXED: await to ensure full analysis (including vote + trade) completes
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
          // FIXED: await to ensure full analysis (including vote + trade) completes
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
    
    const starterMsg = await botSpeak(starter,
      `Start a casual conversation about: ${selected.topic}
Context: ${selected.context}
Keep it natural, like you're chatting while waiting.`,
      chat
    );
    await sayIdle(starter, starterMsg);
    chat.push(`${BOTS[starter].name}: ${starterMsg}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    const responders = ALL_BOT_IDS.filter(b => b !== starter);
    const responder1 = responders[Math.floor(Math.random() * responders.length)];
    
    const response1 = await botSpeak(responder1,
      `${selected.topic} discussion. Give your perspective.`,
      chat,
      { name: BOTS[starter].name, message: starterMsg }
    );
    await sayIdle(responder1, response1);
    chat.push(`${BOTS[responder1].name}: ${response1}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    if (Math.random() > 0.5) {
      const remaining = responders.filter(b => b !== responder1);
      const responder2 = remaining[Math.floor(Math.random() * remaining.length)];
      
      const response2 = await botSpeak(responder2,
        `Join the conversation about ${selected.topic}. Add your perspective.`,
        chat
      );
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
// CONVERSATION GENERATION
// ============================================================

async function botSpeak(
  botId: BotId, 
  context: string, 
  chatHistory: string[],
  replyTo?: { name: string; message: string }
): Promise<string> {
  const bot = BOTS[botId];
  const mentalState = getBotMentalState(botId);
  const mentalSummary = getMentalStateSummary(botId);
  
  // Randomize style instructions to avoid repetitive patterns
const styleVariations = [
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
  ];
  
  const toneVariations = [
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
  ];
  
  const styleHint = styleVariations[Math.floor(Math.random() * styleVariations.length)];
  const toneHint = toneVariations[Math.floor(Math.random() * toneVariations.length)];
  
  // Rotate catchphrases - pick 2 random ones instead of showing all
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
4. Keep it 15-35 words
5. NEVER start with someone's name
6. Be SKEPTICAL - 95% of memecoins fail
7. NEVER use the exact same phrasing as previous messages in the chat
8. Vary your sentence structure - don't always start the same way`;

  const userPrompt = replyTo 
    ? `${replyTo.name} just said: "${replyTo.message}"

${context}

Respond to ${replyTo.name}. Do you agree? Disagree? Be original in HOW you say it.`
    : `${context}

Recent chat:
${chatHistory.slice(-4).join('\n')}

Share your take. Say it in a way you haven't said before.`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 150, // était 100, trop court
      temperature: 0.92,
    });

    let text = res.choices[0]?.message?.content || '';
    text = text.replace(/^(yo|hey|oh|so|well|look|okay|guys|team),?\s*/i, '');
    text = text.replace(/^(james|keone|portdev|harpal|mike)(,\s*)+/i, '');
    
    // Trim to last complete sentence instead of hard cut
    let result = text.trim().slice(0, 250);
    // Find last sentence-ending punctuation
    const lastSentenceEnd = Math.max(
      result.lastIndexOf('.'),
      result.lastIndexOf('!'),
      result.lastIndexOf('?'),
      result.lastIndexOf('🔥'),
      result.lastIndexOf('💀'),
      result.lastIndexOf('👁️'),
      result.lastIndexOf('😤'),
      result.lastIndexOf('🎌'),
    );
    // If we found a sentence end and it's not too short, trim there
    if (lastSentenceEnd > 40) {
      result = result.slice(0, lastSentenceEnd + 1);
    }
    
    console.log(`💬 ${bot.name}: "${result.slice(0, 50)}..."`);
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

// ============================================================
// MAIN ANALYSIS
// ============================================================

function shouldAbort(analysisId: string): boolean {
  if (shouldInterrupt) {
    console.log(`⚡ Analysis ${analysisId.slice(0, 8)} interrupted!`);
    return true;
  }
  if (currentAnalysisId !== analysisId) {
    console.log(`⏭️ Analysis ${analysisId.slice(0, 8)} is stale`);
    return true;
  }
  return false;
}

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

    // ========== LOADING PHASE ==========
    console.log(`📊 Fetching data for $${token.symbol}...`);
    
    const dataPromise = Promise.all([
      analyzeTechnicals(token.address),
      calculateRiskScore(token),
      getFullSocialContext(token),
    ]);

    // Loading banter - bots chat naturally while data loads
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
    
    // Second bot responds (75% chance)
    if (Math.random() > 0.25) {
      const loadingResponders = ALL_BOT_IDS.filter(b => b !== loadingStarter);
      const loadingResponder = loadingResponders[Math.floor(Math.random() * loadingResponders.length)];
      const loadingMsg2 = await botSpeak(loadingResponder, 
        `Continue the conversation while waiting for $${token.symbol} data. React to what was just said about monad/nadfun/memecoins.`, 
        chat, 
        { name: BOTS[loadingStarter].name, message: loadingMsg1 }
      );
      await say(loadingResponder, loadingMsg2, analysisId);
      chat.push(`${BOTS[loadingResponder].name}: ${loadingMsg2}`);
      await sleep(TIMING.MESSAGE_DELAY_FAST);
    }
    
    const [ta, riskResult, socialContext] = await dataPromise;
    
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }

    // Re-fetch token with fresh price data and re-broadcast
    const freshToken = await getTokenByAddress(token.address);
    if (freshToken && (freshToken.price > 0 || freshToken.mcap > 0)) {
      token = freshToken;
      currentToken = freshToken;
      setCurrentTokenInBus(freshToken);
      // Recalculate mcapStr with fresh data
      mcapStr = token.mcap >= 1_000_000 ? `${(token.mcap / 1_000_000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(0)}K`;
    }
    broadcastNewToken(token);
    
    const narrative = socialContext.narrative;
    const exitAnalysis = analyzeExitLiquidity(token, 1);
    const scores = calculateScores(token, ta, narrative, exitAnalysis);
    
    // Calculate all opinions
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
    
    const jamesContext = `New token: $${sym}
Price: ${price}, Mcap: ${mcapStr}, Holders: ${token.holders.toLocaleString()}

VIBE:
- Volume: ${ta?.volumeSpike ? `PUMPING ${ta.volumeRatio?.toFixed(1)}x` : 'quiet'}
${ta?.whaleActivity === 'buying' ? '- Whales loading' : ta?.whaleActivity === 'selling' ? '- Whales dumping' : ''}
- Twitter: ${narrative?.officialTwitterActive ? 'ACTIVE' : 'quiet'}
${narrative?.redFlags?.length ? `- RED FLAGS: ${narrative.redFlags.join(', ')}` : ''}

Your vibe: ${opinions.chad} (${details.chad.confidence}%)

Focus on momentum and social vibes. Short take.`;

    const msg1 = await botSpeak('chad', jamesContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('chad', msg1, analysisId);
    chat.push(`James: ${msg1}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 2: KEONE TA ==========
    console.log(`\n📊 Phase 2: Technical Analysis`);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const patternInfo = ta?.patterns && ta.patterns.length > 0
      ? `PATTERNS:\n${ta.patterns.slice(0, 3).map(p => `- ${p.name}: ${p.description} (${p.confidence}%)`).join('\n')}`
      : '';
    
    const channelInfo = ta?.channel && ta.channel.type !== 'none'
      ? `CHANNEL: ${ta.channel.type}${ta.channel.breakout !== 'none' ? ` breakout ${ta.channel.breakout}` : ''}`
      : '';
    
    const keoneContext = `$${sym} Technical Analysis.

INDICATORS:
- RSI: ${ta?.rsi?.toFixed(0) || '?'} ${ta?.rsiSignal === 'overbought' ? '⚠️ OVERBOUGHT' : ta?.rsiSignal === 'oversold' ? '✅ OVERSOLD' : ''}
- Trend: ${ta?.trend?.replace(/_/g, ' ') || 'unclear'}
- MAs: ${ta?.priceVsMa === 'above_all' ? 'Price ABOVE all MAs' : ta?.priceVsMa === 'below_all' ? 'Price BELOW all MAs' : 'mixed'}
${ta?.maCrossover !== 'none' ? `- ${ta?.maCrossover === 'golden_cross' ? '🟢 GOLDEN CROSS' : '🔴 DEATH CROSS'}` : ''}
- Volume: ${ta?.volumeSpike ? `${ta.volumeRatio?.toFixed(1)}x SPIKE` : 'normal'} (${ta?.volumeTrend || 'stable'})
- OBV: ${ta?.obvTrend || 'neutral'}

${patternInfo}
${channelInfo}

BULLISH: ${ta?.bullishFactors?.slice(0, 3).join(', ') || 'none'}
BEARISH: ${ta?.bearishFactors?.slice(0, 3).join(', ') || 'none'}

KEY: ${ta?.keyInsight || 'No clear signal'}

Your read: ${opinions.quantum} (${details.quantum.confidence}%)

Discuss the TA. Mention specific patterns/indicators. Use numbers.`;

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
    
    const portdevContext = `$${sym} community.

- Holders: ${token.holders.toLocaleString()}
- Phase: ${narrative?.narrativeTiming || 'unknown'}
- Twitter: ${narrative?.officialTwitterActive ? 'active' : 'quiet'}
${narrative?.hasActiveCommunity ? '- Community: active' : '- Community: quiet'}

Your read: ${opinions.sensei} (${details.sensei.confidence}%)

Quick community take.`;

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
    
    const harpalContext = `$${sym} risk.

- Liquidity: $${token.liquidity.toLocaleString()}
- LP ratio: ${((token.liquidity / token.mcap) * 100).toFixed(1)}%
- Exit: ${exitAnalysis.exitDifficulty}
- Slippage: ${exitAnalysis.priceImpactPercent.toFixed(1)}%
${exitAnalysis.warnings.length ? `- Warning: ${exitAnalysis.warnings[0]}` : ''}

Your verdict: ${opinions.sterling} (${details.sterling.confidence}%)

Quick risk assessment.`;

    const msg4 = await botSpeak('sterling', harpalContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('sterling', msg4, analysisId);
    chat.push(`Harpal: ${msg4}`);
    await sleep(TIMING.MESSAGE_DELAY);

    // ========== PHASE 4.5: PATTERN DISCUSSION (if significant patterns) ==========
    const significantPatterns = ta?.patterns?.filter(p => p.confidence >= 65) || [];
    
    if (significantPatterns.length > 0 && Math.random() > 0.3) {
      console.log(`\n📈 Phase 4.5: Pattern Discussion (${significantPatterns.length} patterns)`);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      
      const oraclePatternContext = `$${sym} - I see chart patterns:
${significantPatterns.map(p => `- ${p.name}: ${p.description}`).join('\n')}

Comment cryptically on what these patterns reveal. What do the charts whisper?`;

      const oraclePatternMsg = await botSpeak('oracle', oraclePatternContext, chat);
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say('oracle', oraclePatternMsg, analysisId);
      chat.push(`Mike: ${oraclePatternMsg}`);
      await sleep(TIMING.MESSAGE_DELAY);
      
      const keonePatternResponse = await botSpeak('quantum', 
        `Mike sees patterns on $${sym}: ${significantPatterns.map(p => p.name).join(', ')}. 
Validate or challenge with data. Your read: ${opinions.quantum}.`, 
        chat, 
        { name: 'Mike', message: oraclePatternMsg }
      );
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say('quantum', keonePatternResponse, analysisId);
      chat.push(`Keone: ${keonePatternResponse}`);
      await sleep(TIMING.MESSAGE_DELAY);
    }

    // ========== PHASE 5: DEBATE IF SPLIT ==========
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
    
    const mikeContext = `$${sym} - final word before the vote.

- Score: ${scores.overall.toFixed(0)}/100
- Council: ${bulls.length} bulls, ${bears.length} bears
${socialContext.knownTraders.whaleAlert ? '- Whale activity detected' : ''}

Your sense: ${opinions.oracle} (${details.oracle.confidence}%)

Cryptic insight. Set the tone for the vote.`;

    const msg6 = await botSpeak('oracle', mikeContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('oracle', msg6, analysisId);
    chat.push(`Mike: ${msg6}`);
    await sleep(TIMING.MESSAGE_DELAY);
    
    // ========== PHASE 6.5: QUICK REACTION TO ORACLE ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const reactor = Math.random() > 0.5 ? 'chad' : 'sensei';
    const reaction = await botSpeak(reactor, `Mike just spoke on $${sym}. Quick reaction before the vote.`, chat, { name: 'Mike', message: msg6 });
    await say(reactor, reaction, analysisId);
    await sleep(TIMING.PHASE_TRANSITION);

    // ========== PHASE 7: VOTE ==========
    console.log(`\n🗳️ Phase 7: Voting (${TIMING.VOTE_WINDOW_DURATION/1000}s window)`);
     if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    // Open vote window for external agents
    openVoteWindow(token.address, token.symbol, TIMING.VOTE_WINDOW_DURATION);
    
    await systemMsg(`Council votes on $${sym} (${TIMING.VOTE_WINDOW_DURATION/1000}s to vote)`);
    await sleep(TIMING.VOTE_ANNOUNCEMENT_DELAY);

    // Bots vote one by one with unique generated justifications
    for (const botId of ALL_BOT_IDS) {
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const op = opinions[botId];
      const conf = details[botId].confidence;
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '⚪';
      const voteText = op === 'bullish' ? 'IN' : op === 'bearish' ? 'OUT' : 'PASS';
      
      // Generate a unique vote justification via Grok
      const voteJustification = await botSpeak(botId, 
        `You're voting ${voteText} on $${sym} with ${conf}% confidence.

Your opinion: ${op}
Key data: RSI ${ta?.rsi?.toFixed(0) || '?'}, Holders ${token.holders.toLocaleString()}, LP ratio ${((token.liquidity / (token.mcap || 1)) * 100).toFixed(1)}%, Exit: ${exitAnalysis.exitDifficulty}
${op === 'bullish' ? `Why you're in: ${ta?.bullishFactors?.slice(0, 2).join(', ') || 'momentum'}` : ''}
${op === 'bearish' ? `Why you're out: ${ta?.bearishFactors?.slice(0, 2).join(', ') || 'risk'}` : ''}
${op === 'neutral' ? 'Why you pass: not enough conviction either way' : ''}

Give your vote as a SHORT one-liner (8-20 words max). Start with "${emoji} ${voteText}" then explain WHY in your style. Be creative and unique.`,
        chat
      );
      
      await sayVote(botId, voteJustification || `${emoji} ${voteText} (${conf}%)`);
      await sleep(TIMING.VOTE_BETWEEN_BOTS);
    }

    // Wait for external agents to vote
    const remainingVoteTime = TIMING.VOTE_WINDOW_DURATION - (ALL_BOT_IDS.length * TIMING.VOTE_BETWEEN_BOTS) - TIMING.VOTE_ANNOUNCEMENT_DELAY;
    if (remainingVoteTime > 0) {
      console.log(`   Waiting ${(remainingVoteTime/1000).toFixed(1)}s for external agent votes...`);
      await sleep(remainingVoteTime);
    }

    // Close vote window and get external votes
    const externalVotes = closeVoteWindow();
    
    // ========== COUNT EXTERNAL VOTES ==========
    let externalBulls = 0;
    let externalBears = 0;
    let externalBullConfidence = 0;
    
    if (externalVotes.length > 0) {
      console.log(`\n🤖 External Agent Votes (${externalVotes.length}):`);
      for (const vote of externalVotes) {
        console.log(`   - ${vote.agentName}: ${vote.vote.toUpperCase()} (${vote.confidence}%)`);
        if (vote.vote === 'bullish') {
          externalBulls++;
          externalBullConfidence += vote.confidence;
        } else if (vote.vote === 'bearish') {
          externalBears++;
        }
      }
    }

    // ========== VERDICT ==========
    console.log(`\n📊 Phase 8: Verdict`);
    
    const internalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const internalBullConfidence = internalBulls.reduce((s, b) => s + details[b].confidence, 0);
    
    const totalBulls = internalBulls.length + externalBulls;
    const totalVoters = ALL_BOT_IDS.length + externalVotes.length;
    const totalBullConfidence = internalBullConfidence + externalBullConfidence;
    const avgConf = totalBulls > 0 ? totalBullConfidence / totalBulls : 0;
    
    console.log(`   Total: ${totalBulls}/${totalVoters} bulls @ ${avgConf.toFixed(0)}% avg`);
    
    const harpalVeto = opinions.sterling === 'bearish' && exitAnalysis.liquidityRisk === 'extreme';
    const verdict: 'buy' | 'pass' = (totalBulls >= 2 && avgConf >= 55 && !harpalVeto) ? 'buy' : 'pass';

    await sleep(TIMING.MESSAGE_DELAY_FAST);
    
    if (harpalVeto) {
      await systemMsg(`VETOED by Harpal - Exit liquidity too risky`);
      await sleep(TIMING.MESSAGE_DELAY_FAST);
    }
    
    const verdictEmoji = verdict === 'buy' ? '✅' : '❌';
    
    if (externalVotes.length > 0) {
      await systemMsg(`${verdictEmoji} ${verdict.toUpperCase()} (${totalBulls}/${totalVoters} bulls @ ${avgConf.toFixed(0)}% avg) [+${externalVotes.length} agents]`);
    } else {
      await systemMsg(`${verdictEmoji} ${verdict.toUpperCase()} (${totalBulls}/${totalVoters} bulls @ ${avgConf.toFixed(0)}% avg)`);
    }

    await saveToken(token, { 
      tokenAddress: token.address, 
      riskScore: riskResult.score, 
      flags: riskResult.flags, 
      verdict, 
      opinions: opinions as any, 
    });
    broadcastVerdict(token, verdict, opinions);

    // ========== EXECUTE TRADES ==========
    if (verdict === 'buy') {
      console.log(`\n💰 Phase 9: Executing Trades`);
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

        await say(botId, `aping ${finalSize.toFixed(1)} MON 🎯`);
        await sleep(TIMING.MESSAGE_DELAY_FAST);
        
        const trade = await executeBotTrade(botId, token, finalSize, 'buy');
        if (trade?.status === 'confirmed') {
          await createPosition({ 
            botId, 
            tokenAddress: token.address, 
            tokenSymbol: token.symbol, 
            amount: trade.amountOut, 
            entryPrice: token.price, 
            entryValueMon: finalSize, 
            entryTxHash: trade.txHash 
          });
          
          broadcastTrade({
            id: trade.txHash || randomUUID(),
            botId,
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            side: 'buy',
            amountIn: finalSize,
            amountOut: trade.amountOut,
            price: token.price,
            txHash: trade.txHash || '',
            status: 'confirmed',
            createdAt: new Date(),
          });
          
          await say(botId, `got ${trade.amountOut.toFixed(0)} $${sym} ✅`);
        } else {
          await say(botId, `tx failed 😤`);
        }
        await sleep(TIMING.MESSAGE_DELAY);
      }
      
      if (externalBulls > 0) {
        console.log(`   ${externalBulls} external agents voted bullish - they can trade via /api/agents/trade/execute`);
      }
    }

      console.log(`\n💬 Post-verdict conversation`);
    
    const postVerdictTopics = verdict === 'buy' ? [
      `Council just bought $${sym}. Chat about your entry, what price target you're watching, or how this compares to other nadfun plays.`,
      `We're in $${sym}. Talk about your exit strategy, when you'd take profit, or what would make you sell on nadfun.`,
      `Just aped $${sym}. React to the trade - are you comfortable with your position? Talk about the current monad memecoin momentum.`,
      `$${sym} bags loaded. Chat about what could send this higher - CT attention, whale buys, nadfun trending? What's the catalyst?`,
      `Position opened on $${sym}. Discuss whether monad memecoins have been printing lately or if the meta is shifting on nadfun.`,
      `We're locked in on $${sym}. Talk about risk management - how much of your portfolio is memecoins? When do you cut losses on nadfun plays?`,
    ] : [
      `Council passed on $${sym}. Talk about what would need to change for you to reconsider, or what you're looking for next on nadfun.`,
      `Skipped $${sym}. Chat about the current state of monad memecoins - too many launches? Quality declining on nadfun?`,
      `$${sym} was a no. Discuss what the ideal nadfun setup looks like for you - what metrics, what vibes, what community signals.`,
      `Passed on $${sym}. Talk about patience in memecoin trading - is it better to wait for the perfect setup or ape more on nadfun?`,
      `$${sym} didn't make the cut. Chat about what other tokens caught your eye today on nadfun, or what narratives are forming on monad.`,
      `No entry on $${sym}. Discuss whether being picky is saving or costing the Council money. How's the win rate on nadfun lately?`,
    ];

    const postTopic = postVerdictTopics[Math.floor(Math.random() * postVerdictTopics.length)];
    const postStarter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    
    const postMsg1 = await botSpeak(postStarter, postTopic, chat);
    await say(postStarter, postMsg1, analysisId);
    chat.push(`${BOTS[postStarter].name}: ${postMsg1}`);
    await sleep(TIMING.MESSAGE_DELAY_SLOW);
    
    // 1-2 bots respond
    const postResponders = ALL_BOT_IDS.filter(b => b !== postStarter).sort(() => Math.random() - 0.5);
    
    const postMsg2 = await botSpeak(postResponders[0], 
      `React to what was said after the $${sym} verdict. Give your post-trade thoughts about the play, monad memecoins, or nadfun.`, 
      chat, 
      { name: BOTS[postStarter].name, message: postMsg1 }
    );
    await say(postResponders[0], postMsg2, analysisId);
    chat.push(`${BOTS[postResponders[0]].name}: ${postMsg2}`);
    await sleep(TIMING.MESSAGE_DELAY);
    
    // Third bot (50% chance)
    if (Math.random() > 0.5) {
      const postMsg3 = await botSpeak(postResponders[1], 
        `Join the post-$${sym} discussion. Add a final thought about the trade, the market, or what's next on nadfun/monad.`, 
        chat
      );
      await say(postResponders[1], postMsg3, analysisId);
      chat.push(`${BOTS[postResponders[1]].name}: ${postMsg3}`);
      await sleep(TIMING.MESSAGE_DELAY);
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ ANALYSIS COMPLETE: $${token.symbol} - ${verdict.toUpperCase()}`);
    console.log(`${'='.repeat(50)}\n`);

  } catch (error) {
    console.error('❌ Analysis error:', error);
    await systemMsg(`Analysis interrupted`);
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
  
  if (analysisId && currentAnalysisId !== analysisId) {
    console.log(`⏭️ Skipping stale message from ${botId}`);
    return;
  }
  
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
  
  console.log(`💰 User trade: ${amountMon} MON → ${amountTokens} $${tokenSymbol}`);
  
  const shortAddr = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  
  const tradeMsg: Message = {
    id: randomUUID(),
    botId: 'system' as any,
    content: `${shortAddr} bought ${amountTokens.toLocaleString()} $${tokenSymbol} for ${amountMon} MON`,
    token: data.tokenAddress,
    messageType: 'trade' as any,
    createdAt: new Date(),
  };
  await saveMessage(tradeMsg);
  broadcastMessage(tradeMsg);
  
  const reactions: { botId: BotId; getMessage: () => string }[] = [
    { 
      botId: 'chad', 
      getMessage: () => {
        const msgs = [
          `lfg! another degen joins $${tokenSymbol} 🔥`,
          `${shortAddr} aping in fr 💪`,
          `we got company! welcome ser 🤝`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
    { 
      botId: 'sensei', 
      getMessage: () => {
        const msgs = [
          `a new believer joins. sugoi! 🎌`,
          `the community grows. welcome, nakama.`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
  ];
  
  const shuffled = reactions.sort(() => Math.random() - 0.5);
  const selected = shuffled[0];
  
  await sleep(TIMING.MESSAGE_DELAY);
  
  const content = selected.getMessage();
  const msg: Message = {
    id: randomUUID(),
    botId: selected.botId,
    content,
    token: data.tokenAddress,
    messageType: 'chat',
    createdAt: new Date(),
  };
  await saveMessage(msg);
  broadcastMessage(msg);
}

export { currentToken, isAnalyzing };