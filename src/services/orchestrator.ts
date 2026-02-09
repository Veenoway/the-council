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
import { getBotMentalState, calculateMentalModifiers, applyPersonalityToModifiers, recordTradeResult, loadMentalStatesFromDB, getMentalStateSummary } from './bots/mentalState.js';
import { getFullSocialContext, type NarrativeAnalysis } from './bots/narrativeAnalysis.js';
import { analyzeExitLiquidity, quickLiquidityCheck, type ExitAnalysis } from './bots/exitLiquidity.js';

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
let lastTokenScan = 0;
let lastIdleChat = 0;
let tokensAnalyzedCount = 0;
const TOKEN_SCAN_INTERVAL = 60_000;
const IDLE_CHAT_INTERVAL = 180_000;
const seenTokens = new Set<string>();
const sentMessages = new Set<string>();

// Token queue - fetch once, analyze many
const tokenQueue: Token[] = [];
const MAX_QUEUE_SIZE = 20;

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council v14 - Fast & Fluid Conversations');
  await loadMentalStatesFromDB();

  onInternalEvent('human_message', async (data) => {
    await handleHumanMessage(data);
  });

  while (true) {
    try {
      if (!isAnalyzing) {
        // If queue is empty, refill it
        if (tokenQueue.length === 0 && Date.now() - lastTokenScan > TOKEN_SCAN_INTERVAL) {
          lastTokenScan = Date.now();
          await refillTokenQueue();
        }
        
        // If we have tokens in queue, analyze next one IMMEDIATELY
        if (tokenQueue.length > 0) {
          const nextToken = tokenQueue.shift()!;
          console.log(`📋 Queue: ${tokenQueue.length} tokens remaining`);
          // Don't await - let it run and check again
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
    console.log(`🔍 Fetching new tokens to fill queue...`);
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
        console.log(`   ⏭️ ${token.symbol}: ${quickCheck.reason}`);
        continue;
      }
      
      seenTokens.add(token.address);
      tokenQueue.push(token);
      added++;
    }
    
    console.log(`   ✅ Added ${added} tokens to queue (total: ${tokenQueue.length})`);
    
    if (tokenQueue.length > 0) {
      console.log(`   📋 Queue: ${tokenQueue.map(t => t.symbol).join(', ')}`);
      
      // Announce the queue if this is a fresh batch
      if (added > 0 && tokensAnalyzedCount === 0) {
        await systemMsg(`📋 Found ${tokenQueue.length} tokens to analyze`);
      }
    }
  } catch (error) {
    console.error('Error refilling queue:', error);
  }
}

// ============================================================
// IDLE CONVERSATION — Check Monad/nad.fun Twitter when no tokens
// ============================================================

async function idleConversation(): Promise<void> {
  if (isAnalyzing) return;
  
  console.log('💬 No new tokens, starting idle conversation...');
  sentMessages.clear();
  const chat: string[] = [];
  
  try {
    // 50% chance: Check Monad/nad.fun Twitter
    // 50% chance: General crypto chat
    const doTwitterCheck = Math.random() > 0.5;
    
    if (doTwitterCheck) {
      // ========== CHECK MONAD/NADFUN TWITTER ==========
      console.log('🐦 Checking @monad_xyz and @naddotfun...');
      
      const account = Math.random() > 0.5 ? '@monad_xyz' : '@naddotfun';
      
      const twitterCheck = await grok.chat.completions.create({
        model: 'grok-3-latest',
        messages: [
          { 
            role: 'system', 
            content: 'You have real-time Twitter/X access. Check this account for recent activity.' 
          },
          { 
            role: 'user', 
            content: `Check ${account} on Twitter. What have they posted in the last 24-48 hours? Any announcements, updates, or interesting tweets? Summarize in 2-3 sentences.` 
          }
        ],
        max_tokens: 150,
        temperature: 0.5,
      });
      
      const twitterContent = twitterCheck.choices[0]?.message?.content || '';
      console.log(`📱 Twitter check result: ${twitterContent.slice(0, 100)}...`);
      
      if (twitterContent && !twitterContent.toLowerCase().includes('no recent') && !twitterContent.toLowerCase().includes('unable to')) {
        // James or Portdev spots the news
        const spotter = Math.random() > 0.5 ? 'chad' : 'sensei';
        
        const spotterMsg = await botSpeak(spotter as BotId,
          `You just checked ${account} on Twitter and saw: "${twitterContent}"
Share this with the group. React based on your personality. Keep it natural.`,
          chat
        );
        await sayIdle(spotter as BotId, spotterMsg);
        chat.push(`${BOTS[spotter as BotId].name}: ${spotterMsg}`);
        await sleep(2000);
        
        // Another bot responds
        const responder1 = (['quantum', 'sterling', 'oracle'] as BotId[])[Math.floor(Math.random() * 3)];
        const response1 = await botSpeak(responder1,
          `${account} news discussion. Give your take.`,
          chat,
          { name: BOTS[spotter as BotId].name, message: spotterMsg }
        );
        await sayIdle(responder1, response1);
        chat.push(`${BOTS[responder1].name}: ${response1}`);
        await sleep(D);
        
        // Third person
        const others = ALL_BOT_IDS.filter(b => b !== spotter && b !== responder1);
        const responder2 = others[Math.floor(Math.random() * others.length)];
        const response2 = await botSpeak(responder2,
          `Continue the ${account} discussion.`,
          chat
        );
        await sayIdle(responder2, response2);
        await sleep(D);
        
        return;
      }
    }
    
    // ========== FALLBACK: GENERAL MONAD/CRYPTO CHAT ==========
    const idleTopics = [
      { topic: 'nad.fun volume', context: 'nad.fun is the memecoin launchpad on Monad. Discuss trading volume or activity.' },
      { topic: 'Monad ecosystem', context: 'Monad is a high-performance L1 blockchain. Discuss the ecosystem growth.' },
      { topic: 'memecoin meta', context: 'What memecoin narratives are hot right now? AI? Animals? Culture?' },
      { topic: 'waiting for plays', context: 'Market is quiet. What setups are you watching?' },
      { topic: 'best entries', context: 'What makes a good memecoin entry? Discuss your criteria.' },
      { topic: 'risk management', context: 'How do you size positions? When do you cut losses?' },
      { topic: 'Monad TGE speculation', context: 'Monad mainnet and TGE coming. What are your expectations?' },
      { topic: 'CT vibes today', context: 'How is Crypto Twitter sentiment today? Bullish? Bearish?' },
    ];
    
    const selected = idleTopics[Math.floor(Math.random() * idleTopics.length)];
    console.log(`💭 Idle topic: ${selected.topic}`);
    
    // Random starter
    const starter = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    
    const starterMsg = await botSpeak(starter,
      `Start a casual conversation about: ${selected.topic}
Context: ${selected.context}
Keep it natural, like you're chatting while waiting for the next token.`,
      chat
    );
    await sayIdle(starter, starterMsg);
    chat.push(`${BOTS[starter].name}: ${starterMsg}`);
    await sleep(2000);
    
    // Someone responds
    const responders = ALL_BOT_IDS.filter(b => b !== starter);
    const responder1 = responders[Math.floor(Math.random() * responders.length)];
    
    const response1 = await botSpeak(responder1,
      `${selected.topic} discussion. Give your perspective.`,
      chat,
      { name: BOTS[starter].name, message: starterMsg }
    );
    await sayIdle(responder1, response1);
    chat.push(`${BOTS[responder1].name}: ${response1}`);
    await sleep(D);
    
    // Maybe a third person
    if (Math.random() > 0.4) {
      const remaining = responders.filter(b => b !== responder1);
      const responder2 = remaining[Math.floor(Math.random() * remaining.length)];
      
      const response2 = await botSpeak(responder2,
        `Join the conversation about ${selected.topic}.`,
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
    console.log(`   💬 ${bot.name}: "${result.slice(0, 50)}..."`);
    return result;
  } catch (e) {
    console.error(`❌ Grok error for ${botId}:`, e);
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

async function analyzeToken(token: Token): Promise<void> {
  if (isAnalyzing) return;
  isAnalyzing = true;
  currentToken = token;
  setCurrentTokenInBus(token);
  sentMessages.clear();
  const chat: string[] = [];
  
  const isFirstToken = tokensAnalyzedCount === 0;
  tokensAnalyzedCount++;
  
  // FAST DELAYS - conversation should flow naturally
  const D = isFirstToken ? 1200 : 600;  // Base delay in ms

  try {
    broadcastNewToken(token);
    const mcapStr = token.mcap >= 1_000_000 ? `${(token.mcap / 1_000_000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(0)}K`;
    
    // Quick intro
    if (isFirstToken) {
      await systemMsg(`🔍 Scanning $${token.symbol}...`);
    }
    await say('chad', `$${token.symbol} at ${mcapStr} 👀`);
    
    // ========== PARALLEL ANALYSIS - fetch all data at once ==========
    console.log(`📊 Analyzing $${token.symbol}...`);
    const [ta, riskResult, socialContext] = await Promise.all([
      analyzeTechnicals(token.address),
      calculateRiskScore(token),
      getFullSocialContext(token),
    ]);
    
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
- Volume: ${ta?.volumeSpike ? `PUMPING ${ta.volumeRatio?.toFixed(1)}x 🔥` : 'quiet'}
${ta?.whaleActivity === 'buying' ? '- Whales are loading 🐋' : ta?.whaleActivity === 'selling' ? '- Whales dumping ⚠️' : ''}
- Trend: ${ta?.trend?.replace(/_/g, ' ') || 'unclear'}

TWITTER:
${narrative?.officialTwitter ? `- Has Twitter: ${narrative.officialTwitterActive ? 'ACTIVE ✅' : 'dead account ⚠️'}` : '- No Twitter ❌'}
${narrative?.mentionCount ? `- CT mentions: ${narrative.mentionCount}` : ''}
${narrative?.sentimentOnX ? `- Sentiment: ${narrative.sentimentOnX}` : ''}
${narrative?.redFlags?.length ? `- RED FLAGS: ${narrative.redFlags.join(', ')}` : ''}

Your vibe: ${opinions.chad} (${details.chad.confidence}%)

Talk about the MOMENTUM and SOCIAL vibes. Don't mention RSI or technical indicators - that's Keone's job. Focus on: mcap, holders, volume, twitter activity.`;

    const msg1 = await botSpeak('chad', jamesContext, chat);
    await say('chad', msg1);
    chat.push(`James: ${msg1}`);
    await sleep(D);

    // ========== PHASE 2: KEONE TECHNICAL ANALYSIS ==========
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
    await say('quantum', msg2);
    chat.push(`Keone: ${msg2}`);
    await sleep(D);

    // ========== PHASE 3: JAMES RESPONDS TO KEONE ==========
    const msg3 = await botSpeak('chad', `$${sym} discussion. You're ${opinions.chad}.`, chat, { name: 'Keone', message: msg2 });
    await say('chad', msg3);
    chat.push(`James: ${msg3}`);
    await sleep(D);

    // ========== PHASE 4: PORTDEV ON COMMUNITY ==========
    const portdevContext = `$${sym} community check.

- Holders: ${token.holders.toLocaleString()}
- Phase: ${narrative?.narrativeTiming || 'unknown'}
${narrative?.officialTwitter ? `- Twitter: ${narrative.officialTwitterActive ? 'active' : 'inactive'}` : '- No Twitter'}
${narrative?.hasActiveCommunity ? '- Community: active' : '- Community: quiet'}
${socialContext.knownTraders.knownTraders.length ? `- Known traders in: ${socialContext.knownTraders.knownTraders.slice(0, 2).join(', ')}` : ''}

Your read: ${opinions.sensei} (${details.sensei.confidence}%)

Quick take on community strength.`;

    const msg4 = await botSpeak('sensei', portdevContext, chat);
    await say('sensei', msg4);
    chat.push(`Portdev: ${msg4}`);
    await sleep(D);

    // ========== PHASE 5: SOMEONE RESPONDS TO PORTDEV ==========
    const responder = Math.random() > 0.5 ? 'chad' : 'quantum';
    const msg5 = await botSpeak(responder, `$${sym}. You're ${opinions[responder]}.`, chat, { name: 'Portdev', message: msg4 });
    await say(responder, msg5);
    chat.push(`${BOTS[responder].name}: ${msg5}`);
    await sleep(D);

    // ========== PHASE 6: HARPAL RISK CHECK ==========
    const harpalContext = `$${sym} risk check.

- Liquidity: $${token.liquidity.toLocaleString()}
- LP ratio: ${((token.liquidity / token.mcap) * 100).toFixed(1)}%
- Exit difficulty: ${exitAnalysis.exitDifficulty}
- Slippage on sell: ${exitAnalysis.priceImpactPercent.toFixed(1)}%
- Max position: ${exitAnalysis.recommendedPositionMON.toFixed(1)} MON
${exitAnalysis.warnings.length ? `- Warnings: ${exitAnalysis.warnings[0]}` : ''}
${narrative?.isLikelyScam ? '⚠️ SCAM SIGNALS' : ''}

Your verdict: ${opinions.sterling} (${details.sterling.confidence}%)

Quick risk assessment.`;

    const msg6 = await botSpeak('sterling', harpalContext, chat);
    await say('sterling', msg6);
    chat.push(`Harpal: ${msg6}`);
    await sleep(D);

    // ========== PHASE 7: DEBATE IF SPLIT ==========
    const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');
    
    if (bulls.length > 0 && bears.length > 0) {
      // Bull pushes back
      const bull = bulls[0];
      const bear = bears[0];
      
      const bullArg = await botSpeak(bull, `You're bullish on $${sym}. ${BOTS[bear].name} seems skeptical.`, chat, 
        { name: BOTS[bear].name, message: chat[chat.length - 1].split(': ')[1] });
      await say(bull, bullArg);
      chat.push(`${BOTS[bull].name}: ${bullArg}`);
      await sleep(D);

      // Bear responds
      const bearResp = await botSpeak(bear, `$${sym} debate. You're ${opinions[bear]}.`, chat,
        { name: BOTS[bull].name, message: bullArg });
      await say(bear, bearResp);
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
        await say(third, thirdMsg);
        chat.push(`${BOTS[third].name}: ${thirdMsg}`);
        await sleep(D);
      }
    }

    // ========== PHASE 8: MIKE'S VERDICT ==========
    const allAgree = bulls.length >= 4 || bears.length >= 4;
    const mikeContext = `$${sym} - final word.

- Score: ${scores.overall.toFixed(0)}/100
- Council: ${bulls.length} bulls, ${bears.length} bears
${allAgree ? '- Everyone agrees... suspicious?' : ''}
${socialContext.knownTraders.whaleAlert ? '- Whale activity detected' : ''}

Your sense: ${opinions.oracle} (${details.oracle.confidence}%)

Cryptic but data-backed insight.`;

    const msg8 = await botSpeak('oracle', mikeContext, chat);
    await say('oracle', msg8);
    chat.push(`Mike: ${msg8}`);
    await sleep(D);

    // ========== PHASE 9: QUICK REACTIONS ==========
    const reactor = Math.random() > 0.5 ? 'chad' : 'sensei';
    const reaction = await botSpeak(reactor, `Mike just spoke on $${sym}.`, chat, { name: 'Mike', message: msg8 });
    await say(reactor, reaction);
    await sleep(D * 0.8);

    // ========== PHASE 10: VOTE ==========
    await systemMsg(`🗳️ Council votes on $${sym}`);
    await sleep(D * 0.6);

    for (const botId of ALL_BOT_IDS) {
      const op = opinions[botId];
      const conf = details[botId].confidence;
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '⚪';
      const voteText = op === 'bullish' ? 'IN' : op === 'bearish' ? 'OUT' : 'PASS';
      await sayVote(botId, `${emoji} ${voteText} (${conf}%)`);
      await sleep(D * 0.2);
    }

    // ========== VERDICT ==========
    const finalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const avgConf = finalBulls.length > 0 ? finalBulls.reduce((s, b) => s + details[b].confidence, 0) / finalBulls.length : 0;
    const harpalVeto = opinions.sterling === 'bearish' && exitAnalysis.liquidityRisk === 'extreme';
    const verdict: 'buy' | 'pass' = (finalBulls.length >= 2 && avgConf >= 55 && !harpalVeto) ? 'buy' : 'pass';

    await sleep(D * 0.4);
    if (harpalVeto) await systemMsg(`🚫 VETOED by Harpal - Exit liquidity too risky`);
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

        await say(botId, `aping ${finalSize.toFixed(1)} MON 🎯`);
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
          
          await say(botId, `got ${trade.amountOut.toFixed(0)} $${sym} ✅`);
        } else {
          await say(botId, `tx failed 😤`);
        }
        await sleep(D * 0.4);
      }
    }

  } catch (error) {
    console.error('❌ Analysis error:', error);
    // Broadcast l'erreur pour debugging
    await systemMsg(`⚠️ Analysis interrupted`);
  } finally {
    isAnalyzing = false;
    // Reset scan timer so we scan for new tokens immediately
    lastTokenScan = 0;
    console.log(`✅ Analysis complete for ${token?.symbol || 'unknown'} - ready for next token`);
  }
}

// ============================================================
// HELPERS
// ============================================================

async function say(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;
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
  const msg: Message = { id: randomUUID(), botId, content, token: currentToken?.address, messageType: 'vote', createdAt: new Date() };
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

export { currentToken, isAnalyzing };