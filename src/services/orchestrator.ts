// ============================================================
// ORCHESTRATOR — Real conversations, real debates, real decisions
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { ALL_BOT_IDS, getBotConfig } from '../bots/personalities.js';
import { getNewTokens, calculateRiskScore, getMarketData, getSwapHistory } from './nadfun.js';
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
const recentMessages = new Set<string>(); // Anti-duplicate

// ============================================================
// BOT PERSONALITIES — Core beliefs that drive analysis
// ============================================================

const BOT_PERSPECTIVES: Record<BotId, {
  name: string;
  role: string;
  style: string;
  focusAreas: string[];
  biases: string[];
  persuadedBy: string[];
  skepticalOf: string[];
}> = {
  chad: {
    name: 'James',
    role: 'momentum trader',
    style: 'degen energy, uses "fr", "ngl", "lfg", "ser", "bussin", emoji: 💀😭🔥',
    focusAreas: ['price action', 'volume', 'momentum', 'hype'],
    biases: ['loves pumps', 'FOMO prone', 'optimistic', 'action-oriented'],
    persuadedBy: ['volume spikes', 'price momentum', 'social buzz', 'other degens buying'],
    skepticalOf: ['too much caution', 'waiting too long', 'missing opportunities'],
  },
  quantum: {
    name: 'Keone',
    role: 'quantitative analyst',
    style: 'data-driven, mentions numbers/percentages, slightly pedantic, precise',
    focusAreas: ['LP ratio', 'holder distribution', 'volume patterns', 'statistical probability'],
    biases: ['trusts only data', 'risk-adjusted thinking', 'historical patterns'],
    persuadedBy: ['solid numbers', 'good LP ratio', 'healthy holder distribution', 'statistical evidence'],
    skepticalOf: ['vibes', 'hype without data', 'emotional arguments'],
  },
  sensei: {
    name: 'Portdev',
    role: 'community analyst',
    style: 'weeb energy, uses Japanese words (sugoi, yabai, nakama), anime references, chill vibes',
    focusAreas: ['community size', 'social sentiment', 'meme quality', 'holder engagement'],
    biases: ['believes in community power', 'vibes matter', 'memes have souls'],
    persuadedBy: ['strong community', 'organic growth', 'passionate holders', 'good meme energy'],
    skepticalOf: ['dead communities', 'paid shills', 'no social presence'],
  },
  sterling: {
    name: 'Harpal',
    role: 'risk manager',
    style: 'formal, dry wit, old school finance, references experience, British formality',
    focusAreas: ['deployer history', 'contract risks', 'liquidity locks', 'red flags'],
    biases: ['extremely cautious', 'seen too many rugs', 'preservation of capital'],
    persuadedBy: ['locked liquidity', 'clean deployer history', 'established tokens', 'low risk scores'],
    skepticalOf: ['new tokens', 'hype', 'fast pumps', 'anything that seems too good'],
  },
  oracle: {
    name: 'Mike',
    role: 'pattern seer',
    style: 'cryptic, mysterious, short sentences, uses 👁️, speaks in riddles',
    focusAreas: ['whale movements', 'hidden patterns', 'contrarian signals', 'chain analysis'],
    biases: ['sees what others miss', 'contrarian', 'trusts the chains'],
    persuadedBy: ['unusual wallet activity', 'hidden accumulation', 'patterns others miss'],
    skepticalOf: ['obvious plays', 'crowd consensus', 'too much hype'],
  },
};

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

      if (token.mcap < 5000) continue;
      if (token.mcap > 5_000_000) continue;
      if (token.liquidity < 500) continue;

      console.log(`✅ Analyzing $${token.symbol} (mcap: $${(token.mcap / 1000).toFixed(1)}K, holders: ${token.holders})`);
      await analyzeToken(token);
      break;
    }
  } catch (error) {
    console.error('Scan error:', error);
  }
}

// ============================================================
// MAIN ANALYSIS — Real conversation flow
// ============================================================

async function analyzeToken(token: Token): Promise<void> {
  if (isAnalyzing) return;
  isAnalyzing = true;
  currentToken = token;
  setCurrentTokenInBus(token);
  recentMessages.clear();

  // Track evolving opinions (can change during debate!)
  const currentOpinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {
    chad: 'neutral',
    quantum: 'neutral',
    sensei: 'neutral',
    sterling: 'neutral',
    oracle: 'neutral',
  };

  const conversationHistory: Array<{ bot: BotId; msg: string; sentiment?: string }> = [];

  try {
    broadcastNewToken(token);

    // =========================================================
    // PHASE 1: Data gathering
    // =========================================================
    
    const ta = await analyzeTechnicals(token.address);
    const { score: riskScore, flags } = await calculateRiskScore(token);
    const marketData = await getMarketData(token.address);
    const swapHistory = await getSwapHistory(token.address, 30);

    // Build comprehensive data context
    const dataContext = buildDataContext(token, ta, riskScore, flags, marketData, swapHistory);

    // =========================================================
    // PHASE 2: Chad spots the token
    // =========================================================

    await say('chad', `yo new token just dropped - $${token.symbol}, ${(token.mcap / 1000).toFixed(1)}k mcap, ${token.holders} holders. thoughts?`);
    conversationHistory.push({ bot: 'chad', msg: 'spotted token, asking for thoughts' });
    await sleep(2000);

    // =========================================================
    // PHASE 3: Each bot does their analysis (async-ish feel)
    // =========================================================

    // Quantum analyzes data first
    const quantumAnalysis = await generateAnalysis('quantum', dataContext, conversationHistory);
    await say('quantum', quantumAnalysis.message);
    currentOpinions['quantum'] = quantumAnalysis.sentiment;
    conversationHistory.push({ bot: 'quantum', msg: quantumAnalysis.message, sentiment: quantumAnalysis.sentiment });
    await sleep(2500);

    // Sensei checks community
    const senseiAnalysis = await generateAnalysis('sensei', dataContext, conversationHistory);
    await say('sensei', senseiAnalysis.message);
    currentOpinions['sensei'] = senseiAnalysis.sentiment;
    conversationHistory.push({ bot: 'sensei', msg: senseiAnalysis.message, sentiment: senseiAnalysis.sentiment });
    await sleep(2500);

    // Sterling checks risks
    const sterlingAnalysis = await generateAnalysis('sterling', dataContext, conversationHistory);
    await say('sterling', sterlingAnalysis.message);
    currentOpinions['sterling'] = sterlingAnalysis.sentiment;
    conversationHistory.push({ bot: 'sterling', msg: sterlingAnalysis.message, sentiment: sterlingAnalysis.sentiment });
    await sleep(2500);

    // Oracle sees patterns
    const oracleAnalysis = await generateAnalysis('oracle', dataContext, conversationHistory);
    await say('oracle', oracleAnalysis.message);
    currentOpinions['oracle'] = oracleAnalysis.sentiment;
    conversationHistory.push({ bot: 'oracle', msg: oracleAnalysis.message, sentiment: oracleAnalysis.sentiment });
    await sleep(2500);

    // Chad reacts to everyone
    const chadAnalysis = await generateAnalysis('chad', dataContext, conversationHistory);
    await say('chad', chadAnalysis.message);
    currentOpinions['chad'] = chadAnalysis.sentiment;
    conversationHistory.push({ bot: 'chad', msg: chadAnalysis.message, sentiment: chadAnalysis.sentiment });
    await sleep(2000);

    // =========================================================
    // PHASE 4: DEBATE — This is where opinions can change!
    // =========================================================

    await systemMsg(`💬 Council debate begins...`);
    await sleep(1500);

    // Multiple rounds of debate
    for (let round = 0; round < 3; round++) {
      // Find disagreements
      const bulls = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'bullish');
      const bears = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'bearish');
      const neutrals = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'neutral');

      // If everyone agrees, short debate
      if (bulls.length === 5 || bears.length === 5) {
        await say(shuffle(ALL_BOT_IDS)[0], bulls.length === 5 ? 'we all agree, lets do it' : 'yeah nobody wants this');
        break;
      }

      // Generate debate exchanges
      if (bulls.length > 0 && bears.length > 0) {
        // Bull argues their case
        const bull = shuffle(bulls)[0];
        const bear = shuffle(bears)[0];

        const bullArgument = await generateDebateMessage(bull, bear, 'challenge', dataContext, conversationHistory, currentOpinions);
        await say(bull, bullArgument.message);
        conversationHistory.push({ bot: bull, msg: bullArgument.message });
        await sleep(2000);

        // Bear responds
        const bearResponse = await generateDebateMessage(bear, bull, 'defend', dataContext, conversationHistory, currentOpinions);
        await say(bear, bearResponse.message);
        conversationHistory.push({ bot: bear, msg: bearResponse.message });
        await sleep(2000);

        // Check if anyone's opinion changed based on the debate
        for (const botId of neutrals) {
          const maybeChanged = await checkOpinionChange(botId, dataContext, conversationHistory, currentOpinions);
          if (maybeChanged.changed) {
            currentOpinions[botId] = maybeChanged.newOpinion;
            await say(botId, maybeChanged.message);
            conversationHistory.push({ bot: botId, msg: maybeChanged.message, sentiment: maybeChanged.newOpinion });
            await sleep(1800);
          }
        }

        // Sometimes a bull or bear changes their mind
        const maybeFlip = shuffle([...bulls, ...bears])[0];
        if (Math.random() > 0.7) { // 30% chance someone flips
          const flipCheck = await checkOpinionChange(maybeFlip, dataContext, conversationHistory, currentOpinions);
          if (flipCheck.changed && flipCheck.newOpinion !== currentOpinions[maybeFlip]) {
            currentOpinions[maybeFlip] = flipCheck.newOpinion;
            await say(maybeFlip, flipCheck.message);
            conversationHistory.push({ bot: maybeFlip, msg: flipCheck.message, sentiment: flipCheck.newOpinion });
            await sleep(2000);
          }
        }
      }

      // Add some cross-talk
      if (round < 2) {
        const randomBot = shuffle(ALL_BOT_IDS.filter(b => 
          !conversationHistory.slice(-3).map(c => c.bot).includes(b)
        ))[0];
        
        if (randomBot) {
          const interjection = await generateInterjection(randomBot, dataContext, conversationHistory, currentOpinions);
          if (interjection) {
            await say(randomBot, interjection);
            conversationHistory.push({ bot: randomBot, msg: interjection });
            await sleep(1800);
          }
        }
      }

      await sleep(1000);
    }

    // =========================================================
    // PHASE 5: Final opinions & Vote
    // =========================================================

    await sleep(1000);
    await systemMsg(`🗳️ Final vote on $${token.symbol}`);
    await sleep(1500);

    // Each bot states their final position
    for (const botId of ALL_BOT_IDS) {
      const finalStatement = await generateFinalVote(botId, currentOpinions[botId], dataContext, conversationHistory);
      await say(botId, finalStatement);
      await sleep(800);
    }

    // Count votes
    const finalBulls = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'bullish');
    const finalBears = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'bearish');
    const finalNeutrals = ALL_BOT_IDS.filter(b => currentOpinions[b] === 'neutral');

    const inCount = finalBulls.length;
    const outCount = finalBears.length + finalNeutrals.length;

    const verdict: 'buy' | 'pass' = inCount >= 3 ? 'buy' : 'pass';

    await sleep(800);
    await systemMsg(`📊 ${verdict.toUpperCase()} (${inCount} in / ${outCount} out)`);

    await saveToken(token, { tokenAddress: token.address, riskScore, flags, verdict, opinions: currentOpinions as any });
    broadcastVerdict(token, verdict, currentOpinions);

    // =========================================================
    // PHASE 6: Execute trades
    // =========================================================

    if (verdict === 'buy' && inCount > 0) {
      await sleep(1500);

      for (const botId of finalBulls) {
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

        await say(botId, `aping ${size.toFixed(1)} MON`);
        await sleep(800);

        const trade = await executeBotTrade(botId, token, size, 'buy');

        if (trade?.status === 'confirmed') {
          await createPosition({
            botId,
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            amount: trade.amountOut,
            entryPrice: token.price,
            entryValueMon: size,
            entryTxHash: trade.txHash,
          });

          await say(botId, `✅ bought ${trade.amountOut.toFixed(0)} $${token.symbol}`);
        } else {
          await say(botId, `❌ trade failed`);
        }

        await sleep(1000);
      }
    } else {
      await systemMsg(`Council passed — no trades executed`);
    }

  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    isAnalyzing = false;
  }
}

// ============================================================
// DATA CONTEXT BUILDER
// ============================================================

interface DataContext {
  symbol: string;
  mcap: number;
  mcapFormatted: string;
  holders: number;
  liquidity: number;
  lpRatio: number;
  lpRatioFormatted: string;
  ageHours: number;
  ageFormatted: string;
  priceChange: number;
  riskScore: number;
  flags: string[];
  // Technical
  rsi: number | null;
  trend: string;
  volumeSpike: boolean;
  buySellRatio: number;
  // Social
  recentBuys: number;
  recentSells: number;
  avgTradeSize: number;
}

function buildDataContext(
  token: Token,
  ta: TechnicalIndicators | null,
  riskScore: number,
  flags: string[],
  marketData: any,
  swapHistory: any[]
): DataContext {
  const ageHours = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
  const lpRatio = token.liquidity / (token.mcap || 1);

  const recentBuys = swapHistory.filter(s => s.eventType === 'BUY').length;
  const recentSells = swapHistory.filter(s => s.eventType === 'SELL').length;
  const avgTradeSize = swapHistory.length > 0
    ? swapHistory.reduce((sum, s) => sum + parseFloat(s.nativeAmount || '0'), 0) / swapHistory.length
    : 0;

  return {
    symbol: token.symbol,
    mcap: token.mcap,
    mcapFormatted: token.mcap > 1000000 ? `${(token.mcap / 1000000).toFixed(1)}M` : `${(token.mcap / 1000).toFixed(1)}K`,
    holders: token.holders,
    liquidity: token.liquidity,
    lpRatio,
    lpRatioFormatted: `${(lpRatio * 100).toFixed(1)}%`,
    ageHours,
    ageFormatted: ageHours < 1 ? `${Math.round(ageHours * 60)}min` : ageHours < 24 ? `${ageHours.toFixed(0)}h` : `${(ageHours / 24).toFixed(1)}d`,
    priceChange: token.priceChange24h || 0,
    riskScore,
    flags,
    rsi: ta?.rsi || null,
    trend: ta?.trend || 'unknown',
    volumeSpike: ta?.volumeSpike || false,
    buySellRatio: ta?.buySellRatio || 1,
    recentBuys,
    recentSells,
    avgTradeSize,
  };
}

// ============================================================
// AI MESSAGE GENERATION
// ============================================================

async function generateAnalysis(
  botId: BotId,
  data: DataContext,
  history: Array<{ bot: BotId; msg: string; sentiment?: string }>
): Promise<{ message: string; sentiment: 'bullish' | 'bearish' | 'neutral' }> {

  const bot = BOT_PERSPECTIVES[botId];
  const recentChat = history.slice(-4).map(h => `${h.bot}: ${h.msg}`).join('\n');

  const prompt = `You are ${bot.name}, a ${bot.role} in a crypto trading group called The Council.

YOUR PERSONALITY:
- Style: ${bot.style}
- You focus on: ${bot.focusAreas.join(', ')}
- Your biases: ${bot.biases.join(', ')}
- You're persuaded by: ${bot.persuadedBy.join(', ')}
- You're skeptical of: ${bot.skepticalOf.join(', ')}

TOKEN DATA for $${data.symbol}:
- Market cap: $${data.mcapFormatted}
- Holders: ${data.holders}
- LP ratio: ${data.lpRatioFormatted}
- Age: ${data.ageFormatted}
- Risk score: ${data.riskScore}/100
${data.flags.length > 0 ? `- Red flags: ${data.flags.join(', ')}` : '- No major red flags'}
${data.rsi ? `- RSI: ${data.rsi.toFixed(0)}` : ''}
- Trend: ${data.trend}
- Recent trades: ${data.recentBuys} buys, ${data.recentSells} sells
${data.volumeSpike ? '- VOLUME SPIKE detected' : ''}

RECENT CONVERSATION:
${recentChat || 'Chad just spotted this token'}

TASK:
1. Analyze this token from YOUR perspective (${bot.focusAreas[0]})
2. Give your honest take in 10-20 words
3. Be specific - mention actual numbers or observations
4. End with your sentiment: [BULLISH], [BEARISH], or [NEUTRAL]

Respond naturally in your style. Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 80,
      temperature: 1.1,
    });

    const raw = res.choices[0]?.message?.content || '';
    const sentiment = extractSentiment(raw);
    const message = cleanMessage(raw);

    return { message, sentiment };
  } catch (e) {
    console.error(`Analysis error for ${botId}:`, e);
    return { message: 'need more time to analyze this one', sentiment: 'neutral' };
  }
}

async function generateDebateMessage(
  speaker: BotId,
  target: BotId,
  type: 'challenge' | 'defend',
  data: DataContext,
  history: Array<{ bot: BotId; msg: string }>,
  opinions: Record<BotId, string>
): Promise<{ message: string }> {

  const bot = BOT_PERSPECTIVES[speaker];
  const targetBot = BOT_PERSPECTIVES[target];
  const recentChat = history.slice(-4).map(h => `${h.bot}: ${h.msg}`).join('\n');
  const targetLastMsg = history.filter(h => h.bot === target).slice(-1)[0]?.msg || '';

  const prompt = `You are ${bot.name}, a ${bot.role}. You're ${opinions[speaker]} on $${data.symbol}.

YOUR STYLE: ${bot.style}

${targetBot.name} (${target}) is ${opinions[target]} and said: "${targetLastMsg}"

RECENT CHAT:
${recentChat}

TOKEN FACTS:
- Holders: ${data.holders}, LP: ${data.lpRatioFormatted}, Age: ${data.ageFormatted}, Risk: ${data.riskScore}/100

TASK: ${type === 'challenge' ? `Challenge ${targetBot.name}'s position. Push back with YOUR perspective.` : `Defend your position against ${targetBot.name}'s argument.`}

Rules:
- Be direct, reference what they said
- Use specific data to support your point
- 8-18 words, natural conversation
- Stay in character

Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
      temperature: 1.1,
    });

    return { message: cleanMessage(res.choices[0]?.message?.content || '') };
  } catch {
    return { message: '' };
  }
}

async function checkOpinionChange(
  botId: BotId,
  data: DataContext,
  history: Array<{ bot: BotId; msg: string }>,
  currentOpinions: Record<BotId, string>
): Promise<{ changed: boolean; newOpinion: 'bullish' | 'bearish' | 'neutral'; message: string }> {

  const bot = BOT_PERSPECTIVES[botId];
  const recentChat = history.slice(-6).map(h => `${h.bot}: ${h.msg}`).join('\n');
  const currentOpinion = currentOpinions[botId];

  const prompt = `You are ${bot.name}, a ${bot.role}. You're currently ${currentOpinion} on $${data.symbol}.

YOUR PERSONALITY:
- You're persuaded by: ${bot.persuadedBy.join(', ')}
- You're skeptical of: ${bot.skepticalOf.join(', ')}

DEBATE SO FAR:
${recentChat}

TOKEN: $${data.symbol} - ${data.holders} holders, ${data.lpRatioFormatted} LP, ${data.ageFormatted} old

QUESTION: Based on the arguments you've heard, has your opinion changed?

If YES - respond with your new take and end with [BULLISH], [BEARISH], or [NEUTRAL]
If NO - respond with just "NO_CHANGE"

Be honest - good arguments from others CAN change your mind. 8-15 words if changed.`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
      temperature: 1.0,
    });

    const raw = res.choices[0]?.message?.content || '';
    
    if (raw.includes('NO_CHANGE')) {
      return { changed: false, newOpinion: currentOpinion as any, message: '' };
    }

    const newSentiment = extractSentiment(raw);
    if (newSentiment !== currentOpinion) {
      return { changed: true, newOpinion: newSentiment, message: cleanMessage(raw) };
    }

    return { changed: false, newOpinion: currentOpinion as any, message: '' };
  } catch {
    return { changed: false, newOpinion: currentOpinion as any, message: '' };
  }
}

async function generateInterjection(
  botId: BotId,
  data: DataContext,
  history: Array<{ bot: BotId; msg: string }>,
  opinions: Record<BotId, string>
): Promise<string | null> {

  const bot = BOT_PERSPECTIVES[botId];
  const recentChat = history.slice(-4).map(h => `${h.bot}: ${h.msg}`).join('\n');

  const prompt = `You are ${bot.name}, a ${bot.role}. Style: ${bot.style}

You're ${opinions[botId]} on $${data.symbol}.

DEBATE:
${recentChat}

Add a brief comment (5-12 words) - agree with someone, ask a question, or add a new point. Stay in character.
If you have nothing to add, say "SKIP".

Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 30,
      temperature: 1.1,
    });

    const raw = res.choices[0]?.message?.content || '';
    if (raw.includes('SKIP')) return null;
    return cleanMessage(raw);
  } catch {
    return null;
  }
}

async function generateFinalVote(
  botId: BotId,
  opinion: string,
  data: DataContext,
  history: Array<{ bot: BotId; msg: string }>
): Promise<string> {

  const bot = BOT_PERSPECTIVES[botId];
  const emoji = opinion === 'bullish' ? '🟢' : opinion === 'bearish' ? '🔴' : '⚪';

  const prompt = `You are ${bot.name}. You're voting ${opinion.toUpperCase()} on $${data.symbol}.

Style: ${bot.style}

Give your final vote in 3-8 words. Start with "${emoji}" then your brief reason.

Just the message:`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 25,
      temperature: 1.0,
    });

    return cleanMessage(res.choices[0]?.message?.content || `${emoji} ${opinion}`);
  } catch {
    return `${emoji} ${opinion}`;
  }
}

// ============================================================
// HELPERS
// ============================================================

function extractSentiment(text: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = text.toLowerCase();
  if (lower.includes('[bullish]') || lower.includes('bullish')) return 'bullish';
  if (lower.includes('[bearish]') || lower.includes('bearish')) return 'bearish';
  return 'neutral';
}

function cleanMessage(msg: string): string {
  return msg
    .replace(/\[BULLISH\]/gi, '')
    .replace(/\[BEARISH\]/gi, '')
    .replace(/\[NEUTRAL\]/gi, '')
    .replace(/^["']|["']$/g, '')
    .replace(/^\*.*?\*\s*/g, '')
    .trim()
    .slice(0, 150);
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
// MESSAGES — Anti-duplicate
// ============================================================

async function say(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;

  const msgKey = `${botId}:${content.toLowerCase().slice(0, 50)}`;
  if (recentMessages.has(msgKey)) {
    console.log(`🔇 Skipping duplicate: ${botId}`);
    return;
  }
  recentMessages.add(msgKey);

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