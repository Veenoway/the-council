// ============================================================
// ORCHESTRATOR v8 — Opinions based on REAL TA + fundamentals
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
// BOT CONFIGS — What each bot cares about for their opinion
// ============================================================

const BOTS: Record<BotId, {
  name: string;
  style: string;
  // What this bot weighs for their opinion
  weights: {
    holders: number;      // Community size importance (0-1)
    ta: number;           // Technical analysis importance (0-1)
    lp: number;           // Liquidity importance (0-1)
    momentum: number;     // Volume/momentum importance (0-1)
  };
  bullishThreshold: number;  // Score needed to be bullish (0-100)
  bearishThreshold: number;  // Score below which they're bearish (0-100)
}> = {
  chad: {
    name: 'James',
    style: 'casual degen, uses fr/ngl/ser/lfg sparingly, emojis 🔥💀',
    weights: { holders: 0.35, ta: 0.15, lp: 0.10, momentum: 0.40 },
    bullishThreshold: 50,  // Easy to convince
    bearishThreshold: 30,
  },
  quantum: {
    name: 'Keone', 
    style: 'analytical, cites specific numbers, measured',
    weights: { holders: 0.20, ta: 0.45, lp: 0.15, momentum: 0.20 },
    bullishThreshold: 55,
    bearishThreshold: 40,
  },
  sensei: {
    name: 'Portdev',
    style: 'chill, occasional Japanese (sugoi, yabai), anime refs',
    weights: { holders: 0.45, ta: 0.15, lp: 0.10, momentum: 0.30 },
    bullishThreshold: 50,
    bearishThreshold: 30,
  },
  sterling: {
    name: 'Harpal',
    style: 'formal, dry humor, risk-focused',
    weights: { holders: 0.25, ta: 0.25, lp: 0.35, momentum: 0.15 },
    bullishThreshold: 60,  // Harder to convince
    bearishThreshold: 45,
  },
  oracle: {
    name: 'Mike',
    style: 'cryptic, short, mysterious, 👁️',
    weights: { holders: 0.30, ta: 0.30, lp: 0.15, momentum: 0.25 },
    bullishThreshold: 55,
    bearishThreshold: 40,
  },
};

// ============================================================
// STATE
// ============================================================

let currentToken: Token | null = null;
let isAnalyzing = false;
let lastTokenScan = 0;
const TOKEN_SCAN_INTERVAL = 120_000;
const seenTokens = new Set<string>();
const recentMessages = new Set<string>();

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council v8 - TA-based opinions');

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

      if (token.mcap < 3000 || token.mcap > 10_000_000) continue;
      if (token.liquidity < 300) continue;

      await analyzeToken(token);
      break;
    }
  } catch (error) {
    console.error('Scan error:', error);
  }
}

// ============================================================
// SCORE CALCULATIONS — Real TA-based scoring
// ============================================================

interface TokenScores {
  // Individual scores (0-100)
  holdersScore: number;
  taScore: number;
  lpScore: number;
  momentumScore: number;
  
  // Derived
  overall: number;
  
  // Human readable
  holderVerdict: string;
  taVerdict: string;
  lpVerdict: string;
  momentumVerdict: string;
  
  // Raw data for prompts
  data: {
    holders: number;
    holdersFormatted: string;
    mcapK: string;
    lpRatio: string;
    rsi: string;
    rsiSignal: string;
    macd: string;
    trend: string;
    bbPosition: string;
    bbSqueeze: boolean;
    volumeRatio: string;
    volumeSpike: boolean;
    whales: string;
    obv: string;
    patterns: string;
    signal: string;
    support: boolean;
    resistance: boolean;
    bullishFactors: string[];
    bearishFactors: string[];
  };
}

function calculateScores(token: Token, ta: TechnicalIndicators | null, riskScore: number): TokenScores {
  // ============ HOLDER SCORE (for Monad) ============
  let holdersScore = 0;
  let holderVerdict = '';
  
  if (token.holders >= 30000) { holdersScore = 98; holderVerdict = 'exceptional - top tier on Monad'; }
  else if (token.holders >= 20000) { holdersScore = 95; holderVerdict = 'massive community'; }
  else if (token.holders >= 10000) { holdersScore = 90; holderVerdict = 'huge for Monad'; }
  else if (token.holders >= 5000) { holdersScore = 80; holderVerdict = 'very strong community'; }
  else if (token.holders >= 2000) { holdersScore = 70; holderVerdict = 'solid holder base'; }
  else if (token.holders >= 1000) { holdersScore = 60; holderVerdict = 'decent community'; }
  else if (token.holders >= 500) { holdersScore = 50; holderVerdict = 'building momentum'; }
  else if (token.holders >= 200) { holdersScore = 40; holderVerdict = 'early stage'; }
  else { holdersScore = 25; holderVerdict = 'very early'; }

  // ============ TA SCORE ============
  let taScore = 50; // Default neutral
  let taVerdict = 'neutral signals';
  
  if (ta) {
    let taPoints = 50; // Start neutral
    
    // RSI contribution (-15 to +15)
    if (ta.rsi <= 30) taPoints += 15;  // Oversold = bullish
    else if (ta.rsi <= 40) taPoints += 10;
    else if (ta.rsi <= 60) taPoints += 5;  // Neutral-ish is fine
    else if (ta.rsi <= 70) taPoints += 0;  // Getting warm
    else if (ta.rsi <= 80) taPoints -= 5;  // Overbought warning
    else taPoints -= 15;  // Very overbought
    
    // MACD contribution (-10 to +15)
    if (ta.macdCrossover === 'bullish') taPoints += 15;
    else if (ta.macdCrossover === 'bearish') taPoints -= 10;
    if (ta.macdHistogram > 0) taPoints += 5;
    else if (ta.macdHistogram < 0) taPoints -= 5;
    
    // Moving averages (-10 to +10)
    if (ta.priceVsMa === 'above_all') taPoints += 10;
    else if (ta.priceVsMa === 'below_all') taPoints -= 10;
    if (ta.maCrossover === 'golden_cross') taPoints += 10;
    else if (ta.maCrossover === 'death_cross') taPoints -= 10;
    
    // Bollinger Bands (-5 to +10)
    if (ta.bbSqueeze) taPoints += 10;  // Squeeze = potential breakout
    if (ta.bbPosition === 'below_lower') taPoints += 5;  // Oversold
    else if (ta.bbPosition === 'above_upper') taPoints -= 5;  // Overbought
    
    // Trend (-10 to +15)
    if (ta.trend === 'strong_uptrend') taPoints += 15;
    else if (ta.trend === 'uptrend') taPoints += 10;
    else if (ta.trend === 'sideways') taPoints += 0;
    else if (ta.trend === 'downtrend') taPoints -= 10;
    else if (ta.trend === 'strong_downtrend') taPoints -= 15;
    
    // Support/Resistance
    if (ta.nearSupport) taPoints += 5;  // Good entry
    if (ta.nearResistance) taPoints -= 5;  // Potential rejection
    
    // Patterns
    for (const p of ta.patterns) {
      if (p.direction === 'bullish') taPoints += (p.confidence / 10);
      else if (p.direction === 'bearish') taPoints -= (p.confidence / 10);
    }
    
    // Overall signal boost
    if (ta.signal === 'strong_buy') taPoints += 10;
    else if (ta.signal === 'buy') taPoints += 5;
    else if (ta.signal === 'sell') taPoints -= 5;
    else if (ta.signal === 'strong_sell') taPoints -= 10;
    
    taScore = Math.max(0, Math.min(100, taPoints));
    
    // Verdict
    if (taScore >= 75) taVerdict = 'strong bullish signals';
    else if (taScore >= 60) taVerdict = 'bullish leaning';
    else if (taScore >= 45) taVerdict = 'neutral/mixed signals';
    else if (taScore >= 30) taVerdict = 'bearish leaning';
    else taVerdict = 'strong bearish signals';
  }

  // ============ LP SCORE ============
  const lpRatio = token.liquidity / (token.mcap || 1);
  let lpScore = 0;
  let lpVerdict = '';
  
  if (lpRatio >= 0.20) { lpScore = 90; lpVerdict = 'excellent liquidity'; }
  else if (lpRatio >= 0.15) { lpScore = 80; lpVerdict = 'very healthy LP'; }
  else if (lpRatio >= 0.10) { lpScore = 70; lpVerdict = 'good liquidity'; }
  else if (lpRatio >= 0.08) { lpScore = 60; lpVerdict = 'decent LP'; }
  else if (lpRatio >= 0.06) { lpScore = 50; lpVerdict = 'acceptable for meme'; }
  else if (lpRatio >= 0.04) { lpScore = 35; lpVerdict = 'thin liquidity'; }
  else { lpScore = 20; lpVerdict = 'low LP - careful with size'; }

  // ============ MOMENTUM SCORE ============
  let momentumScore = 50;
  let momentumVerdict = 'average activity';
  
  if (ta) {
    let momPoints = 50;
    
    // Volume
    if (ta.volumeSpike) momPoints += 20;
    else if (ta.volumeRatio > 1.5) momPoints += 10;
    else if (ta.volumeRatio < 0.5) momPoints -= 10;
    
    // Volume trend
    if (ta.volumeTrend === 'increasing') momPoints += 10;
    else if (ta.volumeTrend === 'decreasing') momPoints -= 10;
    
    // Buy/sell pressure
    if (ta.buySellRatio > 2) momPoints += 15;
    else if (ta.buySellRatio > 1.5) momPoints += 10;
    else if (ta.buySellRatio > 1.2) momPoints += 5;
    else if (ta.buySellRatio < 0.5) momPoints -= 15;
    else if (ta.buySellRatio < 0.8) momPoints -= 10;
    
    // OBV trend
    if (ta.obvTrend === 'accumulation') momPoints += 10;
    else if (ta.obvTrend === 'distribution') momPoints -= 10;
    
    // Whale activity
    if (ta.whaleActivity === 'buying') momPoints += 10;
    else if (ta.whaleActivity === 'selling') momPoints -= 15;
    
    momentumScore = Math.max(0, Math.min(100, momPoints));
    
    if (momentumScore >= 75) momentumVerdict = 'strong buying momentum';
    else if (momentumScore >= 60) momentumVerdict = 'positive momentum';
    else if (momentumScore >= 45) momentumVerdict = 'neutral momentum';
    else if (momentumScore >= 30) momentumVerdict = 'weak momentum';
    else momentumVerdict = 'negative momentum';
  }

  // ============ OVERALL (simple average for display) ============
  const overall = (holdersScore + taScore + lpScore + momentumScore) / 4;

  // ============ BUILD DATA OBJECT ============
  const data = {
    holders: token.holders,
    holdersFormatted: token.holders.toLocaleString(),
    mcapK: (token.mcap / 1000).toFixed(0),
    lpRatio: (lpRatio * 100).toFixed(1),
    rsi: ta?.rsi?.toFixed(0) || 'N/A',
    rsiSignal: ta?.rsiSignal || 'unknown',
    macd: ta?.macdCrossover || 'none',
    trend: ta?.trend?.replace(/_/g, ' ') || 'unknown',
    bbPosition: ta?.bbPosition?.replace(/_/g, ' ') || 'middle',
    bbSqueeze: ta?.bbSqueeze || false,
    volumeRatio: ta?.volumeRatio?.toFixed(1) || '1.0',
    volumeSpike: ta?.volumeSpike || false,
    whales: ta?.whaleActivity || 'none',
    obv: ta?.obvTrend || 'neutral',
    patterns: ta?.patterns?.map(p => p.name).join(', ') || 'none',
    signal: ta?.signal?.replace(/_/g, ' ') || 'hold',
    support: ta?.nearSupport || false,
    resistance: ta?.nearResistance || false,
    bullishFactors: ta?.bullishFactors || [],
    bearishFactors: ta?.bearishFactors || [],
  };

  return {
    holdersScore,
    taScore,
    lpScore,
    momentumScore,
    overall,
    holderVerdict,
    taVerdict,
    lpVerdict,
    momentumVerdict,
    data,
  };
}

// ============================================================
// BOT OPINION CALCULATOR — Based on their weights
// ============================================================

function calculateBotOpinion(botId: BotId, scores: TokenScores): 'bullish' | 'bearish' | 'neutral' {
  const bot = BOTS[botId];
  
  // Calculate weighted score for this bot
  const weightedScore = 
    (scores.holdersScore * bot.weights.holders) +
    (scores.taScore * bot.weights.ta) +
    (scores.lpScore * bot.weights.lp) +
    (scores.momentumScore * bot.weights.momentum);
  
  if (weightedScore >= bot.bullishThreshold) return 'bullish';
  if (weightedScore < bot.bearishThreshold) return 'bearish';
  return 'neutral';
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

async function analyzeToken(token: Token): Promise<void> {
  if (isAnalyzing) return;
  isAnalyzing = true;
  currentToken = token;
  setCurrentTokenInBus(token);
  recentMessages.clear();

  const chat: string[] = [];

  try {
    broadcastNewToken(token);

    await sleep(500);
    const ta = await analyzeTechnicals(token.address);
    await sleep(1000);
    const { score: riskScore, flags } = await calculateRiskScore(token);
    
    // Calculate all scores
    const scores = calculateScores(token, ta, riskScore);
    
    // Pre-calculate opinions based on data (can be influenced by debate)
    const opinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {
      chad: calculateBotOpinion('chad', scores),
      quantum: calculateBotOpinion('quantum', scores),
      sensei: calculateBotOpinion('sensei', scores),
      sterling: calculateBotOpinion('sterling', scores),
      oracle: calculateBotOpinion('oracle', scores),
    };

    const d = scores.data;

    // =========================================================
    // PHASE 1: James alerts
    // =========================================================

    const jamesOpinion = opinions.chad;
    const msg1 = await generate('chad', `
Alert: $${token.symbol} on Monad

Stats:
- ${d.holdersFormatted} holders (${scores.holderVerdict})
- ${d.mcapK}K mcap
- ${d.lpRatio}% LP
${d.volumeSpike ? '- Volume spiking ' + d.volumeRatio + 'x!' : ''}
${d.macd === 'bullish' ? '- MACD bullish cross' : ''}

Your analysis says: ${jamesOpinion}
${jamesOpinion === 'bullish' ? 'You like this setup.' : jamesOpinion === 'bearish' ? 'You have concerns.' : 'You want more info.'}

Alert the group with your take. 12-18 words. Be natural.
    `, chat);
    
    await say('chad', msg1);
    chat.push(`James: ${msg1}`);
    await sleep(3500);

    // =========================================================
    // PHASE 2: Keone with TA focus
    // =========================================================

    const keoneOpinion = opinions.quantum;
    const msg2 = await generate('quantum', `
James alerted about $${token.symbol}.

Your TA analysis:
- RSI: ${d.rsi} (${d.rsiSignal})
- MACD: ${d.macd}
- Trend: ${d.trend}
- MAs: price ${ta?.priceVsMa?.replace(/_/g, ' ') || 'mixed'}
- TA Score: ${scores.taScore}/100 (${scores.taVerdict})

Your calculated opinion: ${keoneOpinion}

James said: "${msg1}"

Respond to James with your TA perspective. Reference specific indicators.
You're ${keoneOpinion} based on the data. 15-22 words.
    `, chat);
    
    await say('quantum', msg2);
    chat.push(`Keone: ${msg2}`);
    await sleep(3500);

    // =========================================================
    // PHASE 3: Portdev on community
    // =========================================================

    const portdevOpinion = opinions.sensei;
    const msg3 = await generate('sensei', `
$${token.symbol} discussion.

Community data:
- ${d.holdersFormatted} holders (${scores.holderVerdict})
- Holder score: ${scores.holdersScore}/100
- Momentum: ${scores.momentumVerdict}
${d.volumeSpike ? '- Volume is pumping!' : ''}

Your calculated opinion: ${portdevOpinion}

Chat:
${chat.join('\n')}

Add your community/momentum perspective. Respond to what was said.
You're ${portdevOpinion}. 15-22 words.
    `, chat);
    
    await say('sensei', msg3);
    chat.push(`Portdev: ${msg3}`);
    await sleep(3500);

    // =========================================================
    // PHASE 4: Harpal on risk
    // =========================================================

    const harpalOpinion = opinions.sterling;
    const msg4 = await generate('sterling', `
$${token.symbol} risk assessment.

Risk metrics:
- LP: ${d.lpRatio}% (${scores.lpVerdict})
- LP Score: ${scores.lpScore}/100
- Whale activity: ${d.whales}
- Risk flags: ${flags.length > 0 ? flags.join(', ') : 'none major'}

Positive factors: ${d.holdersFormatted} holders is ${scores.holderVerdict}

Your calculated opinion: ${harpalOpinion}
${harpalOpinion === 'bullish' ? 'Risk/reward looks acceptable to you.' : harpalOpinion === 'bearish' ? 'You have concerns about risk.' : 'You see both sides.'}

Chat:
${chat.join('\n')}

Give your risk take. Respond to the others. 18-25 words.
    `, chat);
    
    await say('sterling', msg4);
    chat.push(`Harpal: ${msg4}`);
    await sleep(3500);

    // =========================================================
    // PHASE 5: Debate if disagreement
    // =========================================================

    const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');

    if (bulls.length > 0 && bears.length > 0) {
      const bull = bulls[0];
      const bear = bears[0];

      // Bull argues
      const bullArg = await generate(bull, `
You're bullish on $${token.symbol}. ${BOTS[bear].name} seems cautious.

Your strongest points:
${scores.holdersScore >= 70 ? '- ' + d.holdersFormatted + ' holders is strong for Monad' : ''}
${scores.taScore >= 55 ? '- TA shows ' + scores.taVerdict : ''}
${scores.momentumScore >= 60 ? '- ' + scores.momentumVerdict : ''}

Chat:
${chat.slice(-3).join('\n')}

Make your case to ${BOTS[bear].name}. Reference specific data. 12-18 words.
      `, chat);
      
      await say(bull, bullArg);
      chat.push(`${BOTS[bull].name}: ${bullArg}`);
      await sleep(3000);

      // Bear responds
      const bearResp = await generate(bear, `
${BOTS[bull].name} made a bullish case for $${token.symbol}: "${bullArg}"

Your concerns:
${scores.lpScore < 60 ? '- LP at ' + d.lpRatio + '% is ' + scores.lpVerdict : ''}
${scores.taScore < 50 ? '- TA shows ' + scores.taVerdict : ''}
${d.whales === 'selling' ? '- Whale selling detected' : ''}

But also consider: ${d.holdersFormatted} holders is ${scores.holderVerdict}

Respond to ${BOTS[bull].name}. You can:
- Push back with your concerns
- Acknowledge their points and soften your stance
- Stay neutral

12-18 words.
      `, chat);
      
      await say(bear, bearResp);
      chat.push(`${BOTS[bear].name}: ${bearResp}`);
      await sleep(3000);

      // Check if bear softened (look for concession language)
      const softened = bearResp.toLowerCase().match(/fair|point|true|right|agree|fine|ok|maybe|could/);
      if (softened && opinions[bear] === 'bearish') {
        opinions[bear] = 'neutral';
      }

      // Another bot can weigh in
      const others = ALL_BOT_IDS.filter(b => b !== bull && b !== bear && b !== 'oracle');
      if (others.length > 0) {
        const other = others[Math.floor(Math.random() * others.length)];
        const otherOpinion = opinions[other];
        
        const weighIn = await generate(other, `
${BOTS[bull].name} and ${BOTS[bear].name} debating $${token.symbol}.

Your analysis says: ${otherOpinion}

Chat:
${chat.slice(-3).join('\n')}

Quick take - who do you agree with? Or add something new. 10-15 words.
        `, chat);
        
        await say(other, weighIn);
        chat.push(`${BOTS[other].name}: ${weighIn}`);
        await sleep(2500);
      }
    }

    // =========================================================
    // PHASE 6: Mike's verdict
    // =========================================================

    const mikeOpinion = opinions.oracle;
    const mikeMsg = await generate('oracle', `
Council debated $${token.symbol}.

Key data:
- Overall score: ${scores.overall.toFixed(0)}/100
- ${d.holdersFormatted} holders (${scores.holderVerdict})
- TA: ${scores.taVerdict}
- OBV: ${d.obv}
${d.bullishFactors.length > 0 ? '- Bullish: ' + d.bullishFactors.slice(0, 2).join(', ') : ''}

Your calculated opinion: ${mikeOpinion}

Chat:
${chat.slice(-3).join('\n')}

Final cryptic take. Clear direction. 8-14 words.
    `, chat);
    
    await say('oracle', mikeMsg);
    chat.push(`Mike: ${mikeMsg}`);
    await sleep(3000);

    // =========================================================
    // PHASE 7: James final react
    // =========================================================

    const jamesFinal = await generate('chad', `
Mike said: "${mikeMsg}"

Mike is ${mikeOpinion}. The group respects his calls.

Quick reaction. 6-12 words.
    `, chat);
    
    await say('chad', jamesFinal);
    await sleep(2500);

    // =========================================================
    // PHASE 8: Vote
    // =========================================================

    await systemMsg(`🗳️ Vote on $${token.symbol}`);
    await sleep(1500);

    for (const botId of ALL_BOT_IDS) {
      const op = opinions[botId];
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '⚪';
      const word = op === 'bullish' ? 'in' : op === 'bearish' ? 'out' : 'pass';
      await say(botId, `${emoji} ${word}`);
      await sleep(600);
    }

    const finalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const verdict: 'buy' | 'pass' = finalBulls.length >= 2 ? 'buy' : 'pass';

    await sleep(1000);
    await systemMsg(`📊 ${verdict.toUpperCase()} (${finalBulls.length}/5) | Score: ${scores.overall.toFixed(0)}/100`);

    await saveToken(token, { tokenAddress: token.address, riskScore, flags, verdict, opinions: opinions as any });
    broadcastVerdict(token, verdict, opinions);

    // =========================================================
    // TRADES
    // =========================================================

    if (verdict === 'buy') {
      await sleep(1500);

      for (const botId of finalBulls) {
        const { allowed, reason } = await canBotTrade(botId);
        if (!allowed) {
          await say(botId, `wanted in but ${reason}`);
          continue;
        }

        const balance = await getBotBalance(botId);
        if (balance < 1) continue;

        const size = calculateTradeSize(botId, balance, Math.min(85, scores.overall));
        if (size < 0.3) continue;

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
          await say(botId, `got ${trade.amountOut.toFixed(0)} $${token.symbol} ✅`);
        } else {
          await say(botId, `trade failed`);
        }
        await sleep(1000);
      }
    }

  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    isAnalyzing = false;
  }
}

// ============================================================
// MESSAGE GENERATION
// ============================================================

async function generate(botId: BotId, prompt: string, chat: string[]): Promise<string> {
  const bot = BOTS[botId];
  
  const systemPrompt = `You are ${bot.name}, a crypto trader.

STYLE: ${bot.style}

RULES:
- Don't start with "yo" or "hey"
- Be natural, like a real group chat
- Use names when responding to people
- Stay concise
- Monad holder thresholds:
  * 1000+ = solid
  * 5000+ = strong
  * 10000+ = huge
  * 20000+ = massive`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 70,
      temperature: 1.0,
    });

    let text = res.choices[0]?.message?.content || '';
    text = text.replace(/^(yo|hey|oh|so),?\s*/i, '');
    return text.trim().slice(0, 180);
  } catch (e) {
    console.error(`Error for ${botId}:`, e);
    return 'interesting setup';
  }
}

// ============================================================
// HELPERS
// ============================================================

async function say(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;
  const msgKey = `${botId}:${content.slice(0, 30)}`;
  if (recentMessages.has(msgKey)) return;
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