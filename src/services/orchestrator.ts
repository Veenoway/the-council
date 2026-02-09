// ============================================================
// ORCHESTRATOR v13 — Real conversations, Twitter search, debates
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { ALL_BOT_IDS, getBotConfig } from '../bots/personalities.js';
import { getNewTokens, calculateRiskScore } from './nadfun.js';
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

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// ============================================================
// BOT PERSONALITIES — Full detail for conversations
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
let currentAnalysisId: string | null = null;  // Unique ID for current analysis
let shouldInterrupt = false;  // Flag to interrupt current analysis
let interruptedBy: string | null = null;  // Who interrupted
let interruptToken: Token | null = null;  // Token that caused interruption
let lastTokenScan = 0;
let lastIdleChat = 0;
let tokensAnalyzedCount = 0;
const TOKEN_SCAN_INTERVAL = 60_000;
const IDLE_CHAT_INTERVAL = 180_000;
const MIN_ANALYSIS_DURATION = 45_000;  // Minimum 45 seconds per token
let lastAnalysisEnd = 0;
const seenTokens = new Set<string>();
const sentMessages = new Set<string>();

// Token queue - fetch once, analyze many
const tokenQueue: Token[] = [];
const MAX_QUEUE_SIZE = 20;

// Priority queue for holder-requested tokens
const priorityQueue: { token: Token; requestedBy: string }[] = [];

// ============================================================
// EXPORTED FUNCTIONS — For API endpoints
// ============================================================

export function getIsAnalyzing(): boolean {
  return isAnalyzing;
}

// Check if we should interrupt (called during analysis)
export function checkInterrupt(): boolean {
  return shouldInterrupt;
}

export async function queueTokenForAnalysis(tokenAddress: string, requestedBy?: string, tokenData?: { symbol?: string; name?: string; }): Promise<boolean> {
  try {
    let symbol = tokenData?.symbol || 'UNKNOWN';
    let name = tokenData?.name || 'Unknown Token';
    let price = 0;
    let mcap = 0;
    let liquidity = 0;
    let holders = 0;
    let deployer = '';
    let createdAt = new Date();

    console.log(`Fetching token data for ${tokenAddress} (frontend: $${symbol})...`);

    // Try to fetch from nad.fun API first
    try {
      const response = await fetch(`https://api.nad.fun/token/${tokenAddress}`);
      if (response.ok) {
        const data = await response.json();
        const tokenInfo = data.token_info || {};
        const marketInfo = data.market_info || {};
        
        symbol = tokenInfo.symbol || symbol;
        name = tokenInfo.name || name;
        price = parseFloat(marketInfo.token_price || marketInfo.price_usd || '0');
        holders = parseInt(marketInfo.holder_count) || 0;
        
        // Calculate mcap and liquidity
        const totalSupply = parseFloat(marketInfo.total_supply || '0') / 1e18;
        mcap = price * totalSupply;
        
        const reserveNative = parseFloat(marketInfo.reserve_native || '0') / 1e18;
        const nativePrice = parseFloat(marketInfo.native_price || '0.0175');
        liquidity = reserveNative * nativePrice * 2;
        
        deployer = tokenInfo.creator?.account_id || '';
        createdAt = tokenInfo.created_at ? new Date(tokenInfo.created_at * 1000) : new Date();
        
        console.log(`Fetched $${symbol}: ${holders.toLocaleString()} holders, $${mcap.toLocaleString()} mcap, $${liquidity.toLocaleString()} liq`);
      } else {
        console.log(`nad.fun API returned ${response.status}, using frontend data for $${symbol}`);
      }
    } catch (fetchError) {
      console.error('Failed to fetch from nad.fun:', fetchError);
      console.log(`Using frontend data for $${symbol}`);
    }

    const token: Token = {
      address: tokenAddress,
      symbol,
      name,
      price,
      priceChange24h: 0,
      mcap,
      liquidity,
      holders,
      deployer,
      createdAt,
    };

    console.log(`Token $${token.symbol} requested by holder ${requestedBy}`);

    // If currently analyzing, interrupt!
    if (isAnalyzing && currentToken) {
      console.log(`INTERRUPTING analysis of $${currentToken.symbol} for $${token.symbol}`);
      shouldInterrupt = true;
      interruptedBy = requestedBy || 'a Council holder';
      interruptToken = token;
      
      // Broadcast interruption message
      broadcastMessage({
        id: randomUUID(),
        botId: 'system' as BotId,
        content: `INTERRUPT: Council holder wants to analyze $${token.symbol}!`,
        token: tokenAddress,
        messageType: 'system' as MessageType & 'system',
        createdAt: new Date() as Date,
      });

      return true;
    }

    // Not analyzing - add to priority queue
    priorityQueue.unshift({ token, requestedBy: requestedBy || 'anonymous' });
    
    // Broadcast that a holder requested analysis
    broadcastMessage({
      id: randomUUID(),
      botId: 'system' as BotId,
      content: `Council holder requested analysis of $${token.symbol}`,
      token: tokenAddress,
      messageType: 'system' as MessageType & 'system',
      createdAt: new Date(),
    });

    return true;
  } catch (error) {
    console.error('Failed to queue token:', error);
    return false;
  }
}

// Handle the interruption - bots react and switch to new token
async function handleInterruption(): Promise<void> {
  if (!interruptToken || !interruptedBy) return;

  const token = interruptToken;
  const requester = interruptedBy;
  const oldToken = currentToken;

  // Reset interrupt flags
  shouldInterrupt = false;
  interruptedBy = null;
  interruptToken = null;

  // Bots react to being interrupted
  const reactions = [
    { botId: 'chad' as BotId, msg: `Ayo hold up! A holder wants us to check $${token.symbol}? Say less fam, let's see what we got` },
    { botId: 'quantum' as BotId, msg: `Interrupting analysis... New priority target: $${token.symbol}. Recalibrating metrics.` },
    { botId: 'sensei' as BotId, msg: `The community speaks! A holder summons us to $${token.symbol}. We answer the call.` },
    { botId: 'sterling' as BotId, msg: `*sighs* Another urgent request. Very well, redirecting attention to $${token.symbol}.` },
    { botId: 'oracle' as BotId, msg: `The holders guide us to $${token.symbol}. Let me see what the charts reveal.` },
  ];

  // Pick 2-3 random bots to react
  const shuffled = reactions.sort(() => Math.random() - 0.5);
  const reactingBots = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));

  for (const { botId, msg } of reactingBots) {
    await say(botId, msg);
    await sleep(800);
  }

  // Now start analyzing the new token
  await sleep(500);
  analyzeToken(token);
}

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('The Council v15 - With Interruption Support');
  await loadMentalStatesFromDB();

  onInternalEvent('human_message', async (data) => {
    await handleHumanMessage(data);
  });

  while (true) {
    try {
      // Check for interruption first
      if (shouldInterrupt && interruptToken) {
        console.log(`Processing interruption for $${interruptToken.symbol}`);
        isAnalyzing = false; // Force stop current analysis
        await handleInterruption();
        continue;
      }

      if (!isAnalyzing) {
        // Priority: Check holder-requested tokens first (no cooldown for holders)
        if (priorityQueue.length > 0) {
          const { token, requestedBy } = priorityQueue.shift()!;
          console.log(`Processing priority request from ${requestedBy}: $${token.symbol}`);
          analyzeToken(token);
        }
        // Check cooldown for automatic tokens
        else if (Date.now() - lastAnalysisEnd < MIN_ANALYSIS_DURATION) {
          // Still in cooldown, wait
          const remaining = Math.round((MIN_ANALYSIS_DURATION - (Date.now() - lastAnalysisEnd)) / 1000);
          if (remaining > 0 && remaining % 10 === 0) {
            console.log(`Cooldown: ${remaining}s until next auto-analysis`);
          }
        }
        // If queue is empty, refill it
        else if (tokenQueue.length === 0 && Date.now() - lastTokenScan > TOKEN_SCAN_INTERVAL) {
          lastTokenScan = Date.now();
          await refillTokenQueue();
        }
        // If we have tokens in queue, analyze next one
        else if (tokenQueue.length > 0) {
          const nextToken = tokenQueue.shift()!;
            console.log(`Queue: ${tokenQueue.length} tokens remaining`);
          analyzeToken(nextToken);
        } 
        // No tokens? Maybe idle chat
        else if (Date.now() - lastIdleChat > IDLE_CHAT_INTERVAL) {
          lastIdleChat = Date.now();
          await idleConversation();
        }
      }
      await sleep(500);  // Check more frequently
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
    console.log(`Fetching new tokens to fill queue...`);
    const tokens = await getNewTokens(30);  // Fetch more to filter
    
    let added = 0;
    for (const token of tokens) {
      if (tokenQueue.length >= MAX_QUEUE_SIZE) break;
      if (seenTokens.has(token.address)) continue;
      
      // Basic filters
      if (token.mcap < 3000 || token.mcap > 10_000_000) continue;
      if (token.liquidity < 300) continue;
      
      // Quick liquidity check
      const quickCheck = quickLiquidityCheck(token, 1);
      if (!quickCheck.ok) {
        console.log(`  ${token.symbol}: ${quickCheck.reason}`);
        continue;
      }
      
      seenTokens.add(token.address);
      tokenQueue.push(token);
      added++;
    }
    
    console.log(`Added ${added} tokens to queue (total: ${tokenQueue.length})`);
    
    if (tokenQueue.length > 0) {
      console.log(`Queue: ${tokenQueue.map(t => t.symbol).join(', ')}`);
      
      // Announce the queue if this is a fresh batch
      if (added > 0 && tokensAnalyzedCount === 0) {
        await systemMsg(`Found ${tokenQueue.length} tokens to analyze`);
      }
    }
  } catch (error) {
    console.error('Error refilling queue:', error);
  }
}

// ============================================================
// IDLE CONVERSATION — General Monad/crypto chat when no tokens
// ============================================================

async function idleConversation(): Promise<void> {
  if (isAnalyzing) return;
  
  console.log('No new tokens, starting idle conversation...');
  sentMessages.clear();
  const chat: string[] = [];
  const IDLE_DELAY = 2000;
  
  try {
    // General Monad/crypto chat topics
    const idleTopics = [
      { topic: 'Monad speed', context: 'Monad is insanely fast - 10,000 TPS. How does this change memecoin trading?' },
      { topic: 'memecoin meta', context: 'What memecoin narratives are hot right now? AI agents? Animals? Culture coins?' },
      { topic: 'waiting for plays', context: 'Market is quiet. What setups are you watching? What would make you ape?' },
      { topic: 'best entries', context: 'What makes a good memecoin entry? Low mcap? Strong community? Good chart?' },
      { topic: 'risk management', context: 'How do you size positions on memecoins? When do you cut losses?' },
      { topic: 'Monad ecosystem', context: 'Monad mainnet is live. What projects are you excited about?' },
      { topic: 'rug pulls', context: 'How do you spot a rug? What are the red flags you look for?' },
      { topic: 'diamond hands vs taking profit', context: 'When do you hold vs take profit? Discuss your strategy.' },
      { topic: 'CT alpha', context: 'Where do you find alpha? CT? Telegram? On-chain analysis?' },
      { topic: 'recent trades', context: 'Talk about a recent trade - win or loss. What did you learn?' },
    ];
    
    const selected = idleTopics[Math.floor(Math.random() * idleTopics.length)];
    console.log(`Idle topic: ${selected.topic}`);
    
    // Random starter
    const starter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    
    const starterMsg = await botSpeak(starter,
      `Start a casual conversation about: ${selected.topic}
Context: ${selected.context}
Keep it natural, like you're chatting while waiting for the next token to analyze.`,
      chat
    );
    await sayIdle(starter, starterMsg);
    chat.push(`${BOTS[starter].name}: ${starterMsg}`);
    await sleep(IDLE_DELAY);
    
    // Someone responds
    const responders = ALL_BOT_IDS.filter(b => b !== starter);
    const responder1 = responders[Math.floor(Math.random() * responders.length)];
    
    const response1 = await botSpeak(responder1,
      `${selected.topic} discussion. Give your perspective based on your expertise.`,
      chat,
      { name: BOTS[starter].name, message: starterMsg }
    );
    await sayIdle(responder1, response1);
    chat.push(`${BOTS[responder1].name}: ${response1}`);
    await sleep(IDLE_DELAY);
    
    // Maybe a third person (60% chance)
    if (Math.random() > 0.4) {
      const remaining = responders.filter(b => b !== responder1);
      const responder2 = remaining[Math.floor(Math.random() * remaining.length)];
      
      const response2 = await botSpeak(responder2,
        `Join the conversation about ${selected.topic}. Add your unique perspective.`,
        chat
      );
      await sayIdle(responder2, response2);
    }
    
  } catch (error) {
    console.error('Idle conversation error:', error);
  }
}

// Idle messages don't have a token context
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
  
  const systemPrompt = `You are ${bot.name} in a crypto trading group chat.

PERSONALITY: ${bot.personality}
EXPERTISE: ${bot.expertise}
SPEAKING STYLE: ${bot.speakingStyle}
PHRASES YOU USE: ${bot.catchphrases.join(', ')}

CURRENT MENTAL STATE: ${mentalSummary || 'focused'}
${mentalState.lossStreak >= 2 ? `You've had ${mentalState.lossStreak} losses recently - you're more cautious.` : ''}
${mentalState.winStreak >= 2 ? `You're on a ${mentalState.winStreak} win streak - confident but not reckless.` : ''}

CRITICAL RULES:
1. ALWAYS CITE SPECIFIC DATA - say "RSI at 42" not just "oversold", say "2.3x volume spike" not just "volume up"
2. EXPLAIN YOUR REASONING - "I'm bullish because X, Y, Z" not just "bullish"
3. USE ACTUAL NUMBERS given to you - prices, percentages, holder counts
4. Stay in character - use your speaking style and phrases
5. Keep it 15-30 words - concise but informative
6. NEVER start with someone's name
7. Be SKEPTICAL - 95% of memecoins fail
8. If you disagree, say WHY with data`;

  const userPrompt = replyTo 
    ? `${replyTo.name} just said: "${replyTo.message}"

${context}

Respond to ${replyTo.name}. Do you agree? Disagree? Have a follow-up question?`
    : `${context}

Recent chat:
${chatHistory.slice(-4).join('\n')}

Share your take. What's your read?`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 120,  // Increased for more detailed explanations
      temperature: 0.9,
    });

    let text = res.choices[0]?.message?.content || '';
    // Clean up
    text = text.replace(/^(yo|hey|oh|so|well|look|okay|guys|team),?\s*/i, '');
    text = text.replace(/^(james|keone|portdev|harpal|mike)(,\s*)+/i, '');
    
    const result = text.trim().slice(0, 200);
      console.log(`${bot.name}: "${result.slice(0, 50)}..."`);
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
  
  // Intuition randomness
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
  
  // Overrides
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
// MAIN ANALYSIS — Fast & Fluid conversations
// ============================================================

// Helper to check if we should abort current analysis
function shouldAbort(analysisId: string): boolean {
  // Abort if interrupted OR if this analysis is stale (new one started)
  if (shouldInterrupt) {
    console.log(`Analysis ${analysisId} interrupted by user request!`);
    return true;
  }
  if (currentAnalysisId !== analysisId) {
    console.log(`Analysis ${analysisId} is stale (current: ${currentAnalysisId})`);
    return true;
  }
  return false;
}

async function analyzeToken(token: Token): Promise<void> {
  // Generate unique ID for this analysis
  const analysisId = randomUUID();
  
  // If already analyzing, don't start another (wait for interrupt to be processed)
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
  
  // SLOWER DELAYS - give users time to read
  const D = isFirstToken ? 500 : 1000;  // Base delay in ms (was 600-1200)

  try {
    broadcastNewToken(token);
    const mcapStr = token.mcap >= 1_000_000 ? `${(token.mcap / 1_000_000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(0)}K`;
    
    // Quick intro
    if (isFirstToken) {
      await systemMsg(`Scanning $${token.symbol}...`);
    }
    await say('chad', `$${token.symbol} at ${mcapStr} 👀`, analysisId);
    
    // CHECK INTERRUPT after intro
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    // ========== PARALLEL ANALYSIS - fetch all data at once ==========
    console.log(`Analyzing $${token.symbol}...`);
    
    // ========== LOADING CHAT — Bots chat while data is fetched ==========
    // Start fetching data in background
    const dataPromise = Promise.all([
      analyzeTechnicals(token.address),
      calculateRiskScore(token),
      getFullSocialContext(token),
    ]);

    // Meanwhile, bots have a quick chat about the token or Monad
    const loadingChats = [
      { botId: 'chad' as BotId, msg: `pulling up the charts for $${token.symbol}...` },
      { botId: 'quantum' as BotId, msg: `running technical analysis on $${token.symbol}...` },
      { botId: 'sensei' as BotId, msg: `checking the community vibes for $${token.symbol}...` },
        { botId: 'chad' as BotId, msg: `let's see what CT is saying about this one` },
      { botId: 'oracle' as BotId, msg: `scanning the whale wallets...` },
      { botId: 'sterling' as BotId, msg: `calculating exit liquidity metrics...` },
      { botId: 'sensei' as BotId, msg: `nad.fun been cooking lately ngl` },
      { botId: 'chad' as BotId, msg: `monad szn coming fr fr` },
      { botId: 'quantum' as BotId, msg: `volume on nad.fun looking healthy today` },
    ];

    // Pick 1-2 random loading messages
    const shuffled = loadingChats.sort(() => Math.random() - 0.5);
    const loadingMsg = shuffled[0];
    
    await say(loadingMsg.botId, loadingMsg.msg, analysisId);
    
    // Maybe a second bot responds while waiting
    if (Math.random() > 0.5) {
      await sleep(800);
      const secondMsg = shuffled.find(m => m.botId !== loadingMsg.botId);
      if (secondMsg) {
        await say(secondMsg.botId, secondMsg.msg, analysisId);
      }
    }

    // Wait for data to be ready
    const [ta, riskResult, socialContext] = await dataPromise;
    
    // CHECK INTERRUPT after data fetch
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const narrative = socialContext.narrative;
    const exitAnalysis = analyzeExitLiquidity(token, 1);
    const scores = calculateScores(token, ta, narrative, exitAnalysis);
    
    // Calculate all opinions upfront
    const opinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {} as any;
    const details: Record<BotId, { confidence: number; positionMultiplier: number }> = {} as any;
    for (const botId of ALL_BOT_IDS) {
      const result = calculateBotOpinion(botId, scores, narrative, exitAnalysis);
      opinions[botId] = result.opinion;
      details[botId] = { confidence: result.confidence, positionMultiplier: result.positionMultiplier };
    }

    const sym = token.symbol;
    const price = token.price >= 1 ? `$${token.price.toFixed(2)}` : `$${token.price.toFixed(6)}`;
    const mcap = mcapStr;

    // ========== PHASE 1: JAMES SPOTS IT (momentum/vibe) ==========
    const jamesContext = `New token spotted: $${sym}
Price: ${price}, Mcap: ${mcap}, Holders: ${token.holders.toLocaleString()}

VIBE CHECK:
- Volume: ${ta?.volumeSpike ? `PUMPING ${ta.volumeRatio?.toFixed(1)}x` : 'quiet'}
${ta?.whaleActivity === 'buying' ? '- Whales are loading' : ta?.whaleActivity === 'selling' ? '- Whales dumping' : ''}
- Trend: ${ta?.trend?.replace(/_/g, ' ') || 'unclear'}

TWITTER:
  ${narrative?.officialTwitter ? `- Has Twitter: ${narrative.officialTwitterActive ? 'ACTIVE' : 'dead account'}` : '- No Twitter'}
${narrative?.mentionCount ? `- CT mentions: ${narrative.mentionCount}` : ''}
${narrative?.sentimentOnX ? `- Sentiment: ${narrative.sentimentOnX}` : ''}
${narrative?.redFlags?.length ? `- RED FLAGS: ${narrative.redFlags.join(', ')}` : ''}

Your vibe: ${opinions.chad} (${details.chad.confidence}%)

Talk about the MOMENTUM and SOCIAL vibes. Don't mention RSI or technical indicators - that's Keone's job. Focus on: mcap, holders, volume, twitter activity.`;

    const msg1 = await botSpeak('chad', jamesContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('chad', msg1, analysisId);
    chat.push(`James: ${msg1}`);
    await sleep(D);

    // ========== PHASE 2: KEONE TECHNICAL ANALYSIS ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const keoneContext = `$${sym} - your turn for TA.

TECHNICALS:
- RSI: ${ta?.rsi?.toFixed(0) || '?'} ${ta?.rsiSignal === 'overbought' ? '(overbought)' : ta?.rsiSignal === 'oversold' ? '(oversold)' : ''}
- Trend: ${ta?.trend?.replace(/_/g, ' ') || 'unclear'}
- MAs: ${ta?.maSignal || 'N/A'} ${ta?.maCrossover === 'golden_cross' ? '(golden cross)' : ta?.maCrossover === 'death_cross' ? '(death cross)' : ''}
- Volume: ${ta?.volumeSpike ? `${ta.volumeRatio?.toFixed(1)}x spike` : 'normal'}
- OBV: ${ta?.obvTrend || 'neutral'}
${ta?.bullishFactors?.length ? `- Bullish: ${ta.bullishFactors.slice(0, 2).join(', ')}` : ''}
${ta?.bearishFactors?.length ? `- Bearish: ${ta.bearishFactors.slice(0, 2).join(', ')}` : ''}

Your read: ${opinions.quantum} (${details.quantum.confidence}%)

Give your TA take. Mention RSI, trend, volume. Be specific with numbers.`;

    const msg2 = await botSpeak('quantum', keoneContext, chat, { name: 'James', message: msg1 });
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('quantum', msg2, analysisId);
    chat.push(`Keone: ${msg2}`);
    await sleep(D);

    // ========== PHASE 3: JAMES RESPONDS TO KEONE ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const msg3 = await botSpeak('chad', `$${sym} discussion. You're ${opinions.chad}.`, chat, { name: 'Keone', message: msg2 });
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('chad', msg3, analysisId);
    chat.push(`James: ${msg3}`);
    await sleep(D);

    // ========== PHASE 4: PORTDEV ON COMMUNITY ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const portdevContext = `$${sym} community check.

- Holders: ${token.holders.toLocaleString()}
- Phase: ${narrative?.narrativeTiming || 'unknown'}
${narrative?.officialTwitter ? `- Twitter: ${narrative.officialTwitterActive ? 'active' : 'inactive'}` : '- No Twitter'}
${narrative?.hasActiveCommunity ? '- Community: active' : '- Community: quiet'}
${socialContext.knownTraders.knownTraders.length ? `- Known traders in: ${socialContext.knownTraders.knownTraders.slice(0, 2).join(', ')}` : ''}

Your read: ${opinions.sensei} (${details.sensei.confidence}%)

Quick take on community strength.`;

    const msg4 = await botSpeak('sensei', portdevContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('sensei', msg4, analysisId);
    chat.push(`Portdev: ${msg4}`);
    await sleep(D);

    // ========== PHASE 5: SOMEONE RESPONDS TO PORTDEV ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const responder = Math.random() > 0.5 ? 'chad' : 'quantum';
    const msg5 = await botSpeak(responder, `$${sym}. You're ${opinions[responder]}.`, chat, { name: 'Portdev', message: msg4 });
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say(responder, msg5, analysisId);
    chat.push(`${BOTS[responder].name}: ${msg5}`);
    await sleep(D);

    // ========== PHASE 6: HARPAL RISK CHECK ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const harpalContext = `$${sym} risk check.

- Liquidity: $${token.liquidity.toLocaleString()}
- LP ratio: ${((token.liquidity / token.mcap) * 100).toFixed(1)}%
- Exit difficulty: ${exitAnalysis.exitDifficulty}
- Slippage on sell: ${exitAnalysis.priceImpactPercent.toFixed(1)}%
- Max position: ${exitAnalysis.recommendedPositionMON.toFixed(1)} MON
${exitAnalysis.warnings.length ? `- Warnings: ${exitAnalysis.warnings[0]}` : ''}
${narrative?.isLikelyScam ? 'SCAM SIGNALS' : ''}

Your verdict: ${opinions.sterling} (${details.sterling.confidence}%)

Quick risk assessment.`;

    const msg6 = await botSpeak('sterling', harpalContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('sterling', msg6, analysisId);
    chat.push(`Harpal: ${msg6}`);
    await sleep(D);

    // ========== PHASE 7: DEBATE IF SPLIT ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');
    
    if (bulls.length > 0 && bears.length > 0) {
      // Bull pushes back
      const bull = bulls[0];
      const bear = bears[0];
      
      const bullArg = await botSpeak(bull, `You're bullish on $${sym}. ${BOTS[bear].name} seems skeptical.`, chat, 
        { name: BOTS[bear].name, message: chat[chat.length - 1].split(': ')[1] });
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say(bull, bullArg, analysisId);
      chat.push(`${BOTS[bull].name}: ${bullArg}`);
      await sleep(D);

      // Bear responds
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const bearResp = await botSpeak(bear, `$${sym} debate. You're ${opinions[bear]}.`, chat,
        { name: BOTS[bull].name, message: bullArg });
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      await say(bear, bearResp, analysisId);
      chat.push(`${BOTS[bear].name}: ${bearResp}`);
      
      // Check if bear concedes
      if (bearResp.toLowerCase().match(/fair|point|true|agree|valid|maybe|fine|ok/)) {
        if (opinions[bear] === 'bearish') opinions[bear] = 'neutral';
      }
      await sleep(D);

      // Third person jumps in
      const others = ALL_BOT_IDS.filter(b => b !== bull && b !== bear && b !== 'oracle');
      if (others.length > 0) {
        const third = others[Math.floor(Math.random() * others.length)];
        const thirdMsg = await botSpeak(third, `$${sym} debate ongoing. Your take: ${opinions[third]}`, chat);
        if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
        await say(third, thirdMsg, analysisId);
        chat.push(`${BOTS[third].name}: ${thirdMsg}`);
        await sleep(D);
      }
    }

    // ========== PHASE 8: MIKE'S VERDICT ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const allAgree = bulls.length >= 4 || bears.length >= 4;
    const mikeContext = `$${sym} - final word.

- Score: ${scores.overall.toFixed(0)}/100
- Council: ${bulls.length} bulls, ${bears.length} bears
${allAgree ? '- Everyone agrees... suspicious?' : ''}
${socialContext.knownTraders.whaleAlert ? '- Whale activity detected' : ''}

Your sense: ${opinions.oracle} (${details.oracle.confidence}%)

Cryptic but data-backed insight.`;

    const msg8 = await botSpeak('oracle', mikeContext, chat);
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say('oracle', msg8, analysisId);
    chat.push(`Mike: ${msg8}`);
    await sleep(D);

    // ========== PHASE 9: QUICK REACTIONS ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    const reactor = Math.random() > 0.5 ? 'chad' : 'sensei';
    const reaction = await botSpeak(reactor, `Mike just spoke on $${sym}.`, chat, { name: 'Mike', message: msg8 });
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    await say(reactor, reaction, analysisId);
    await sleep(D * 0.8);

    // ========== PHASE 10: VOTE ==========
    if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
    
    await systemMsg(`Council votes on $${sym}`);
    await sleep(D * 0.6);

    for (const botId of ALL_BOT_IDS) {
      if (shouldAbort(analysisId)) { isAnalyzing = false; return; }
      const op = opinions[botId];
      const conf = details[botId].confidence;
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '🔴';
      const voteText = op === 'bullish' ? 'IN' : op === 'bearish' ? 'OUT' : 'PASS';
      await sayVote(botId, `${emoji} ${voteText} (${conf}%)`);
      await sleep(D * 0.2);
    }

    // ========== VERDICT ==========
    // No more interrupts after this point - we need to finish the verdict
    const finalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const avgConf = finalBulls.length > 0 ? finalBulls.reduce((s, b) => s + details[b].confidence, 0) / finalBulls.length : 0;
    const harpalVeto = opinions.sterling === 'bearish' && exitAnalysis.liquidityRisk === 'extreme';
    const verdict: 'buy' | 'pass' = (finalBulls.length >= 2 && avgConf >= 55 && !harpalVeto) ? 'buy' : 'pass';

    await sleep(D * 0.4);
    if (harpalVeto) await systemMsg(`VETOED by Harpal - Exit liquidity too risky`);
    await systemMsg(`📊 ${verdict.toUpperCase()} (${finalBulls.length}/5 @ ${avgConf.toFixed(0)}% avg)`);

    await saveToken(token, { tokenAddress: token.address, riskScore: riskResult.score, flags: riskResult.flags, verdict, opinions: opinions as any });
    broadcastVerdict(token, verdict, opinions);

    // ========== EXECUTE TRADES ==========
    if (verdict === 'buy') {
      await sleep(D * 0.6);
      for (const botId of finalBulls) {
        const { allowed, reason } = await canBotTrade(botId);
        if (!allowed) { await say(botId, `wanted in but ${reason}`); continue; }
        
        const balance = await getBotBalance(botId);
        if (balance < 1) continue;
        
        const baseSize = calculateTradeSize(botId, balance, Math.min(85, scores.overall));
        const finalSize = Math.min(baseSize * details[botId].positionMultiplier, exitAnalysis.recommendedPositionMON);
        if (finalSize < 0.3) continue;

        await say(botId, `aping ${finalSize.toFixed(1)} MON`);
        await sleep(D * 0.3);
        
        const trade = await executeBotTrade(botId, token, finalSize, 'buy');
        if (trade?.status === 'confirmed') {
          await createPosition({ botId, tokenAddress: token.address, tokenSymbol: token.symbol, amount: trade.amountOut, entryPrice: token.price, entryValueMon: finalSize, entryTxHash: trade.txHash });
          
          // Broadcast trade to frontend
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
          
          await say(botId, `got ${trade.amountOut.toFixed(0)} $${sym}`);
        } else {
          await say(botId, `tx failed 😤`);
        }
        await sleep(D * 0.4);
      }
    }

  } catch (error) {
    console.error('❌ Analysis error:', error);
    // Broadcast l'erreur pour debugging
    await systemMsg(`Analysis interrupted`);
  } finally {
    isAnalyzing = false;
    lastAnalysisEnd = Date.now();  // Record when analysis ended for cooldown
    // Reset scan timer so we scan for new tokens immediately
    lastTokenScan = 0;
    console.log(`Analysis complete for ${token?.symbol || 'unknown'} - cooldown ${MIN_ANALYSIS_DURATION/1000}s before next auto-token`);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function say(botId: BotId, content: string, analysisId?: string): Promise<void> {
  if (!content || content.length < 2) return;
  
  // If analysisId provided, check it's still the current analysis
  if (analysisId && currentAnalysisId !== analysisId) {
    console.log(`Skipping stale message from ${botId} (analysis changed)`);
    return;
  }
  
  const normalized = content.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
  if (sentMessages.has(normalized)) return;
  sentMessages.add(normalized);

  const msg: Message = { id: randomUUID(), botId, content, token: currentToken?.address, messageType: 'chat', createdAt: new Date() };
  await saveMessage(msg);
  broadcastMessage(msg);
}

// Vote messages should never be filtered - each bot must vote
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
// USER TRADE REACTIONS — Bots react when a user buys
// ============================================================

export async function handleUserTrade(data: {
  userAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  amountMon: number;
  amountTokens: number;
  txHash: string;
}): Promise<void> {
  const { userAddress, tokenSymbol, amountMon, amountTokens, txHash } = data;
  
  console.log(`💰 User trade detected: ${amountMon} MON → ${amountTokens} $${tokenSymbol}`);
  
  // Format user address for display
  const shortAddr = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  
  // System message announcing the trade
  const tradeMsg: Message = {
    id: randomUUID(),
    botId: 'system',
    content: `💰 ${shortAddr} bought ${amountTokens.toLocaleString()} $${tokenSymbol} for ${amountMon} MON`,
    token: data.tokenAddress,
    messageType: 'user_trade',
    createdAt: new Date(),
  };
  await saveMessage(tradeMsg);
  broadcastMessage(tradeMsg);
  
  // Pick 1-2 bots to react
  const reactions: { botId: BotId; getMessage: () => string }[] = [
    { 
      botId: 'chad', 
      getMessage: () => {
        const msgs = [
          `lfg! another degen joins the $${tokenSymbol} party 🔥`,
          `${shortAddr} aping in fr fr 💪`,
          `someone's feeling bullish on $${tokenSymbol} 👀`,
          `we got company! welcome to $${tokenSymbol} ser 🤝`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
    { 
      botId: 'quantum', 
      getMessage: () => {
        const msgs = [
          `${amountMon} MON position noted. Watching for follow-through.`,
          `another buyer at this level. accumulation pattern forming.`,
          `${shortAddr} adding to buy pressure on $${tokenSymbol}.`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
    { 
      botId: 'sensei', 
      getMessage: () => {
        const msgs = [
          `a new believer joins the $${tokenSymbol} community. sugoi! 🎌`,
          `the community grows stronger. welcome, nakama.`,
          `diamond hands in the making? time will tell.`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
    { 
      botId: 'sterling', 
      getMessage: () => {
        const msgs = [
          `${amountMon} MON entry. reasonable position size, I approve.`,
          `another participant. let's hope they've done their research.`,
          `new capital flowing in. liquidity improving slightly.`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
    { 
      botId: 'oracle', 
      getMessage: () => {
        const msgs = [
          `the signs attracted another... 👁️`,
          `conviction. I sense it.`,
          `another joins the dance. interesting timing.`,
        ];
        return msgs[Math.floor(Math.random() * msgs.length)];
      }
    },
  ];
  
  // Shuffle and pick 1-2 bots to react
  const shuffled = reactions.sort(() => Math.random() - 0.5);
  const numReactions = Math.random() > 0.5 ? 2 : 1;
  const selectedBots = shuffled.slice(0, numReactions);
  
  // React with delay
  await sleep(800);
  
  for (const { botId, getMessage } of selectedBots) {
    const content = getMessage();
    const msg: Message = {
      id: randomUUID(),
      botId,
      content,
      token: data.tokenAddress,
      messageType: 'chat',
      createdAt: new Date(),
    };
    await saveMessage(msg);
    broadcastMessage(msg);
    await sleep(600);
  }
}

export { currentToken, isAnalyzing }; 