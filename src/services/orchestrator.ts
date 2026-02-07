// ============================================================
// ORCHESTRATOR v11 — Natural conversation, real prices, no duplicates
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
// BOT CONFIGS
// ============================================================

const BOTS: Record<BotId, {
  name: string;
  style: string;
  expertise: string;
  uniqueAngles: string[];
  weights: { holders: number; ta: number; lp: number; momentum: number; };
  bullishThreshold: number;
  bearishThreshold: number;
}> = {
  chad: {
    name: 'James',
    style: 'casual degen, uses fr/ngl/ser sparingly, emojis 🔥💀, never lists names',
    expertise: 'momentum and social buzz',
    uniqueAngles: ['social momentum', 'degen energy', 'fomo potential', 'meme strength'],
    weights: { holders: 0.35, ta: 0.15, lp: 0.10, momentum: 0.40 },
    bullishThreshold: 50,
    bearishThreshold: 30,
  },
  quantum: {
    name: 'Keone', 
    style: 'analytical, precise with numbers, measured tone, never lists names',
    expertise: 'technical analysis and chart patterns',
    uniqueAngles: ['RSI levels', 'MACD signals', 'Bollinger bands', 'chart patterns', 'MA structure'],
    weights: { holders: 0.20, ta: 0.45, lp: 0.15, momentum: 0.20 },
    bullishThreshold: 55,
    bearishThreshold: 40,
  },
  sensei: {
    name: 'Portdev',
    style: 'chill anime vibes, occasional Japanese, wise, never lists names',
    expertise: 'community dynamics and holder behavior',
    uniqueAngles: ['holder conviction', 'diamond hands', 'community loyalty', 'organic growth'],
    weights: { holders: 0.45, ta: 0.15, lp: 0.10, momentum: 0.30 },
    bullishThreshold: 50,
    bearishThreshold: 30,
  },
  sterling: {
    name: 'Harpal',
    style: 'formal risk analyst, dry humor, measured, never lists names',
    expertise: 'risk assessment and liquidity',
    uniqueAngles: ['LP depth', 'slippage risk', 'exit liquidity', 'position sizing'],
    weights: { holders: 0.25, ta: 0.25, lp: 0.35, momentum: 0.15 },
    bullishThreshold: 60,
    bearishThreshold: 45,
  },
  oracle: {
    name: 'Mike',
    style: 'cryptic oracle, short mysterious statements, 👁️, never lists names',
    expertise: 'whale movements and hidden signals',
    uniqueAngles: ['whale wallets', 'smart money', 'accumulation', 'hidden patterns'],
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

// Anti-duplicate: track exact messages sent this session
const sentMessages = new Set<string>();

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council v11 - Natural conversation');

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
// PRICE FORMATTING — Use real prices
// ============================================================

function formatPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  if (price >= 0.0001) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(8)}`;
}

function formatMcap(mcap: number): string {
  if (mcap >= 1_000_000) return `${(mcap / 1_000_000).toFixed(1)}M`;
  return `${(mcap / 1000).toFixed(0)}K`;
}

// ============================================================
// TA SUMMARY BUILDER — With real prices
// ============================================================

interface TASummary {
  keyIndicators: string[];
  patterns: string[];
  signals: string[];
  verdict: string;
  score: number;
  forKeone: string[];
  forJames: string[];
  forPortdev: string[];
  forHarpal: string[];
  forMike: string[];
}

function buildTASummary(ta: TechnicalIndicators | null, token: Token, riskFlags: string[]): TASummary {
  const forKeone: string[] = [];
  const forJames: string[] = [];
  const forPortdev: string[] = [];
  const forHarpal: string[] = [];
  const forMike: string[] = [];
  
  const keyIndicators: string[] = [];
  const patterns: string[] = [];
  const signals: string[] = [];
  let score = 50;

  const price = formatPrice(token.price);
  const mcap = formatMcap(token.mcap);

  if (!ta) {
    return {
      keyIndicators: ['Limited data'],
      patterns: [],
      signals: [],
      verdict: 'insufficient data',
      score: 50,
      forKeone: ['Not enough candle data yet'],
      forJames: ['Volume building'],
      forPortdev: [`${token.holders.toLocaleString()} holders in`],
      forHarpal: ['Need more data for full risk assessment'],
      forMike: ['The data keeps its secrets for now'],
    };
  }

  // ============ RSI ============
  if (ta.rsi !== undefined) {
    const rsi = ta.rsi.toFixed(0);
    if (ta.rsi <= 30) {
      forKeone.push(`RSI at ${rsi} - oversold, bounce setup`);
      score += 15;
    } else if (ta.rsi <= 40) {
      forKeone.push(`RSI ${rsi} approaching oversold`);
      score += 8;
    } else if (ta.rsi >= 80) {
      forKeone.push(`RSI ${rsi} way overbought - careful here`);
      score -= 15;
    } else if (ta.rsi >= 70) {
      forKeone.push(`RSI ${rsi} getting hot`);
      score -= 5;
    } else if (ta.rsi >= 55) {
      forKeone.push(`RSI ${rsi} showing healthy momentum`);
      score += 8;
    } else {
      forKeone.push(`RSI ${rsi} neutral zone`);
    }
    keyIndicators.push(`RSI ${rsi}`);
  }

  // ============ MACD ============
  if (ta.macdCrossover === 'bullish') {
    forKeone.push('MACD just crossed bullish');
    signals.push('MACD buy signal');
    score += 15;
  } else if (ta.macdCrossover === 'bearish') {
    forKeone.push('MACD crossed bearish');
    score -= 12;
  }
  
  if (ta.macdHistogram !== undefined && ta.macdHistogram > 0) {
    forKeone.push('MACD histogram expanding positive');
    score += 5;
  }

  // ============ BOLLINGER BANDS ============
  if (ta.bbSqueeze) {
    forKeone.push('BB squeeze forming - big move coming');
    forMike.push('The bands tighten... coiling for release');
    patterns.push('BB squeeze');
    score += 12;
  }
  
  if (ta.bbPosition === 'below_lower') {
    forKeone.push('Below lower BB - oversold');
    score += 8;
  } else if (ta.bbPosition === 'above_upper') {
    forKeone.push('Riding upper BB - extended');
    score -= 5;
  }

  // ============ MOVING AVERAGES ============
  if (ta.maCrossover === 'golden_cross') {
    forKeone.push('Golden cross confirmed');
    patterns.push('Golden cross');
    score += 15;
  } else if (ta.maCrossover === 'death_cross') {
    forKeone.push('Death cross forming');
    patterns.push('Death cross');
    score -= 15;
  }
  
  if (ta.priceVsMa === 'above_all') {
    forKeone.push('Price above all major MAs');
    score += 10;
  } else if (ta.priceVsMa === 'below_all') {
    forKeone.push('Below all MAs - downtrend');
    score -= 10;
  }

  // ============ CHART PATTERNS ============
  if (ta.patterns && ta.patterns.length > 0) {
    for (const p of ta.patterns) {
      const name = p.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (p.direction === 'bullish') {
        forKeone.push(`${name} pattern (${p.confidence}% confidence)`);
        patterns.push(name);
        score += Math.floor(p.confidence / 8);
      } else if (p.direction === 'bearish') {
        forKeone.push(`${name} - bearish pattern`);
        patterns.push(name);
        score -= Math.floor(p.confidence / 8);
      }
    }
  }

  // ============ TREND ============
  if (ta.trend === 'strong_uptrend') {
    forKeone.push('Strong uptrend - higher highs, higher lows');
    score += 12;
  } else if (ta.trend === 'uptrend') {
    forKeone.push('Uptrend intact');
    score += 8;
  } else if (ta.trend === 'sideways') {
    forKeone.push('Consolidating sideways');
  } else if (ta.trend === 'downtrend') {
    forKeone.push('Downtrend active');
    score -= 10;
  }

  // ============ SUPPORT/RESISTANCE - Use real price ============
  if (ta.nearSupport && ta.supportLevel) {
    forKeone.push(`Testing support at ${formatPrice(ta.supportLevel)}`);
    score += 5;
  } else if (ta.nearSupport) {
    forKeone.push('Near key support level');
    score += 5;
  }
  
  if (ta.nearResistance && ta.resistanceLevel) {
    forKeone.push(`Resistance at ${formatPrice(ta.resistanceLevel)}`);
    score -= 5;
  }

  // ============ VOLUME ============
  if (ta.volumeSpike) {
    forJames.push(`Volume spiking ${ta.volumeRatio?.toFixed(1)}x`);
    forMike.push('Volume speaks... someone knows');
    score += 10;
  } else if (ta.volumeRatio && ta.volumeRatio > 1.5) {
    forJames.push(`Volume up ${ta.volumeRatio.toFixed(1)}x`);
    score += 5;
  }

  // ============ OBV ============
  if (ta.obvTrend === 'accumulation') {
    forMike.push('OBV showing accumulation');
    signals.push('Accumulation');
    score += 8;
  } else if (ta.obvTrend === 'distribution') {
    forMike.push('OBV diverging - distribution');
    forHarpal.push('OBV shows distribution');
    score -= 10;
  }

  // ============ WHALE ACTIVITY ============
  if (ta.whaleActivity === 'buying') {
    forMike.push('Whale wallets accumulating');
    score += 12;
  } else if (ta.whaleActivity === 'selling') {
    forMike.push('Whale distribution detected');
    forHarpal.push('Large holders reducing');
    score -= 15;
  }

  // ============ HOLDERS (for Portdev) ============
  const h = token.holders;
  if (h >= 20000) {
    forPortdev.push(`${h.toLocaleString()} holders - that's massive for Monad`);
  } else if (h >= 10000) {
    forPortdev.push(`${h.toLocaleString()} believers - serious community`);
  } else if (h >= 5000) {
    forPortdev.push(`${h.toLocaleString()} holders showing conviction`);
  } else if (h >= 1000) {
    forPortdev.push(`${h.toLocaleString()} holders building`);
  }

  // ============ RISK (for Harpal) ============
  const lpRatio = token.liquidity / (token.mcap || 1);
  if (lpRatio < 0.05) {
    forHarpal.push(`LP at ${(lpRatio * 100).toFixed(1)}% is thin - watch slippage`);
  } else if (lpRatio < 0.08) {
    forHarpal.push(`${(lpRatio * 100).toFixed(1)}% LP - size accordingly`);
  } else if (lpRatio >= 0.15) {
    forHarpal.push(`${(lpRatio * 100).toFixed(1)}% LP is healthy`);
  } else {
    forHarpal.push(`LP ratio at ${(lpRatio * 100).toFixed(1)}%`);
  }
  
  if (riskFlags.length > 0) {
    forHarpal.push(`Flags: ${riskFlags.slice(0, 2).join(', ')}`);
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let verdict: string;
  if (score >= 75) verdict = 'strong bullish';
  else if (score >= 60) verdict = 'bullish';
  else if (score >= 45) verdict = 'neutral';
  else if (score >= 30) verdict = 'bearish';
  else verdict = 'strong bearish';

  return { keyIndicators, patterns, signals, verdict, score, forKeone, forJames, forPortdev, forHarpal, forMike };
}

// ============================================================
// SCORES
// ============================================================

interface TokenScores {
  holdersScore: number;
  taScore: number;
  lpScore: number;
  momentumScore: number;
  overall: number;
  holderVerdict: string;
  lpVerdict: string;
  taSummary: TASummary;
}

function calculateScores(token: Token, ta: TechnicalIndicators | null, riskScore: number, riskFlags: string[]): TokenScores {
  const taSummary = buildTASummary(ta, token, riskFlags);
  
  let holdersScore = 0, holderVerdict = '';
  if (token.holders >= 30000) { holdersScore = 98; holderVerdict = 'exceptional'; }
  else if (token.holders >= 20000) { holdersScore = 95; holderVerdict = 'massive'; }
  else if (token.holders >= 10000) { holdersScore = 90; holderVerdict = 'huge'; }
  else if (token.holders >= 5000) { holdersScore = 80; holderVerdict = 'very strong'; }
  else if (token.holders >= 2000) { holdersScore = 70; holderVerdict = 'solid'; }
  else if (token.holders >= 1000) { holdersScore = 60; holderVerdict = 'decent'; }
  else { holdersScore = 45; holderVerdict = 'early'; }

  const taScore = taSummary.score;

  const lpRatio = token.liquidity / (token.mcap || 1);
  let lpScore = 0, lpVerdict = '';
  if (lpRatio >= 0.15) { lpScore = 85; lpVerdict = 'healthy'; }
  else if (lpRatio >= 0.10) { lpScore = 70; lpVerdict = 'decent'; }
  else if (lpRatio >= 0.07) { lpScore = 55; lpVerdict = 'acceptable'; }
  else if (lpRatio >= 0.05) { lpScore = 40; lpVerdict = 'thin'; }
  else { lpScore = 25; lpVerdict = 'low'; }

  let momentumScore = 50;
  if (ta) {
    let m = 50;
    if (ta.volumeSpike) m += 20;
    else if (ta.volumeRatio && ta.volumeRatio > 1.5) m += 10;
    if (ta.obvTrend === 'accumulation') m += 10;
    else if (ta.obvTrend === 'distribution') m -= 10;
    if (ta.whaleActivity === 'buying') m += 10;
    else if (ta.whaleActivity === 'selling') m -= 15;
    momentumScore = Math.max(0, Math.min(100, m));
  }

  const overall = (holdersScore + taScore + lpScore + momentumScore) / 4;

  return { holdersScore, taScore, lpScore, momentumScore, overall, holderVerdict, lpVerdict, taSummary };
}

function calculateBotOpinion(botId: BotId, scores: TokenScores): 'bullish' | 'bearish' | 'neutral' {
  const bot = BOTS[botId];
  const w = 
    (scores.holdersScore * bot.weights.holders) +
    (scores.taScore * bot.weights.ta) +
    (scores.lpScore * bot.weights.lp) +
    (scores.momentumScore * bot.weights.momentum);
  
  if (w >= bot.bullishThreshold) return 'bullish';
  if (w < bot.bearishThreshold) return 'bearish';
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
  sentMessages.clear();

  const chat: string[] = [];

  try {
    broadcastNewToken(token);

    await sleep(1500);
    const ta = await analyzeTechnicals(token.address);
    await sleep(2000);
    const { score: riskScore, flags } = await calculateRiskScore(token);
    
    const scores = calculateScores(token, ta, riskScore, flags);
    const summary = scores.taSummary;
    
    const opinions: Record<BotId, 'bullish' | 'bearish' | 'neutral'> = {
      chad: calculateBotOpinion('chad', scores),
      quantum: calculateBotOpinion('quantum', scores),
      sensei: calculateBotOpinion('sensei', scores),
      sterling: calculateBotOpinion('sterling', scores),
      oracle: calculateBotOpinion('oracle', scores),
    };

    // Real token data
    const sym = token.symbol;
    const price = formatPrice(token.price);
    const mcap = formatMcap(token.mcap);
    const holders = token.holders.toLocaleString();
    const lpPct = ((token.liquidity / token.mcap) * 100).toFixed(1);

    // =========================================================
    // PHASE 1: James alerts
    // =========================================================

    const msg1 = await generate('chad', `
Alert: $${sym} on Monad

REAL DATA (use these exact numbers):
- Price: ${price}
- Mcap: ${mcap}
- Holders: ${holders}
- Your vibe: ${opinions.chad}

Alert the group naturally. Pick 1-2 stats that excite you.
DON'T list everyone's names. 12-20 words max.
    `, chat);
    
    await say('chad', msg1);
    chat.push(`James: ${msg1}`);
    await sleep(4000);

    // =========================================================
    // PHASE 2: Keone TA
    // =========================================================

    const keonePoints = summary.forKeone.slice(0, 3);
    const msg2 = await generate('quantum', `
$${sym} - giving my TA.

REAL DATA:
- Price: ${price}
- Mcap: ${mcap}

MY TA FINDINGS (pick 2-3):
${keonePoints.map(p => '• ' + p).join('\n')}
${summary.patterns.length > 0 ? '• Patterns: ' + summary.patterns.join(', ') : ''}

I'm ${opinions.quantum}. Give technical analysis.
Use REAL price ${price} if mentioning levels.
DON'T start with names. 18-28 words.
    `, chat);
    
    await say('quantum', msg2);
    chat.push(`Keone: ${msg2}`);
    await sleep(4500);

    // =========================================================
    // PHASE 3: James follow-up
    // =========================================================

    const msg3 = await generate('chad', `
Keone gave TA on $${sym}.

React naturally or ask a quick question. 
DON'T just say "Keone," - be natural. 8-14 words.

Keone said: "${msg2}"
    `, chat);
    
    await say('chad', msg3);
    chat.push(`James: ${msg3}`);
    await sleep(3000);

    // =========================================================
    // PHASE 4: Portdev community
    // =========================================================

    const portdevPoints = summary.forPortdev.slice(0, 2);
    const msg4 = await generate('sensei', `
$${sym} discussion.

MY COMMUNITY INSIGHTS:
${portdevPoints.map(p => '• ' + p).join('\n')}

I'm ${opinions.sensei}. Add community perspective.
DON'T start by listing names. Be natural. 14-22 words.

Recent chat:
${chat.slice(-2).join('\n')}
    `, chat);
    
    await say('sensei', msg4);
    chat.push(`Portdev: ${msg4}`);
    await sleep(4000);

    // =========================================================
    // PHASE 5: Harpal risk
    // =========================================================

    const harpalPoints = summary.forHarpal.slice(0, 2);
    const msg5 = await generate('sterling', `
$${sym} risk check.

MY RISK FINDINGS:
${harpalPoints.map(p => '• ' + p).join('\n')}

I'm ${opinions.sterling}. Give risk perspective.
DON'T start with "James, Keone, Portdev" - just talk naturally.
If setup looks ok, say so. 16-24 words.

Recent:
${chat.slice(-2).join('\n')}
    `, chat);
    
    await say('sterling', msg5);
    chat.push(`Harpal: ${msg5}`);
    await sleep(4000);

    // =========================================================
    // PHASE 6: Debate if needed
    // =========================================================

    const bulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const bears = ALL_BOT_IDS.filter(b => opinions[b] === 'bearish');

    if (bulls.length > 0 && bears.length > 0) {
      const bull = bulls[0];
      const bear = bears[0];

      const bullArg = await generate(bull, `
You're bullish on $${sym}. ${BOTS[bear].name} seems cautious.

Push back with ONE good point. Don't list names. 10-18 words.

${BOTS[bear].name}'s concern: "${chat[chat.length - 1].split(': ')[1]}"
      `, chat);
      
      await say(bull, bullArg);
      chat.push(`${BOTS[bull].name}: ${bullArg}`);
      await sleep(3500);

      const bearResp = await generate(bear, `
${BOTS[bull].name} pushed back: "${bullArg}"

Respond - concede if valid, or maintain position.
Don't start with their name. 10-18 words.
      `, chat);
      
      await say(bear, bearResp);
      chat.push(`${BOTS[bear].name}: ${bearResp}`);
      
      if (bearResp.toLowerCase().match(/fair|point|true|right|agree|fine|valid|maybe/)) {
        if (opinions[bear] === 'bearish') opinions[bear] = 'neutral';
      }
      await sleep(3500);
    }

    // Someone else adds quick thought
    const others = ALL_BOT_IDS.filter(b => b !== 'oracle' && !chat.some(c => c.startsWith(BOTS[b].name) && chat.indexOf(c) > chat.length - 3));
    if (others.length > 0) {
      const other = others[Math.floor(Math.random() * others.length)];
      const extra = await generate(other, `
$${sym} discussion. Add a brief fresh thought.
Don't repeat what was said. Don't list names. 8-14 words.

Recent:
${chat.slice(-2).join('\n')}
      `, chat);
      
      await say(other, extra);
      chat.push(`${BOTS[other].name}: ${extra}`);
      await sleep(3000);
    }

    // =========================================================
    // PHASE 7: Mike verdict
    // =========================================================

    const mikePoints = summary.forMike.slice(0, 2);
    const mikeMsg = await generate('oracle', `
$${sym} - time for verdict.

MY HIDDEN INSIGHTS:
${mikePoints.map(p => '• ' + p).join('\n')}

Score: ${scores.overall.toFixed(0)}/100
I'm ${opinions.oracle}.

Cryptic but clear direction. Don't list names. 8-14 words.
    `, chat);
    
    await say('oracle', mikeMsg);
    chat.push(`Mike: ${mikeMsg}`);
    await sleep(3500);

    // =========================================================
    // PHASE 8: Quick reaction
    // =========================================================

    const reactor = Math.random() > 0.5 ? 'chad' : 'sensei';
    const reaction = await generate(reactor, `
Mike said: "${mikeMsg}"

Quick natural reaction. 5-10 words. Don't start with "Mike,".
    `, chat);
    
    await say(reactor, reaction);
    await sleep(2500);

    // =========================================================
    // PHASE 9: Vote
    // =========================================================

    await systemMsg(`🗳️ Vote on $${sym}`);
    await sleep(2000);

    for (const botId of ALL_BOT_IDS) {
      const op = opinions[botId];
      const emoji = op === 'bullish' ? '🟢' : op === 'bearish' ? '🔴' : '⚪';
      const word = op === 'bullish' ? 'in' : op === 'bearish' ? 'out' : 'pass';
      await say(botId, `${emoji} ${word}`);
      await sleep(800);
    }

    const finalBulls = ALL_BOT_IDS.filter(b => opinions[b] === 'bullish');
    const verdict: 'buy' | 'pass' = finalBulls.length >= 2 ? 'buy' : 'pass';

    await sleep(1500);
    await systemMsg(`📊 ${verdict.toUpperCase()} (${finalBulls.length}/5) | Score: ${scores.overall.toFixed(0)}/100`);

    await saveToken(token, { tokenAddress: token.address, riskScore, flags, verdict, opinions: opinions as any });
    broadcastVerdict(token, verdict, opinions);

    // =========================================================
    // TRADES
    // =========================================================

    if (verdict === 'buy') {
      await sleep(2000);

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

        await say(botId, `aping ${size.toFixed(1)} MON 🎯`);
        await sleep(1200);

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
          await say(botId, `scooped ${trade.amountOut.toFixed(0)} $${token.symbol} ✅`);
        } else {
          await say(botId, `tx failed`);
        }
        await sleep(1500);
      }
    }

  } catch (error) {
    console.error('Analysis error:', error);
  } finally {
    isAnalyzing = false;
  }
}

// ============================================================
// MESSAGE GENERATION — Anti-duplicate, no name lists
// ============================================================

async function generate(botId: BotId, prompt: string, chat: string[]): Promise<string> {
  const bot = BOTS[botId];
  
  const systemPrompt = `You are ${bot.name}, a crypto trader in a group chat.

STYLE: ${bot.style}

ABSOLUTE RULES:
1. NEVER start messages with lists of names like "James, Keone, Portdev,"
2. NEVER start with "yo", "hey", "oh", "so", "well", "look"
3. If responding to someone, either use their name naturally mid-sentence OR don't use it at all
4. Keep it natural like a real group chat
5. Use ONLY the real prices/numbers given to you - never invent prices
6. Don't repeat what others already said

BAD: "James, Keone, the RSI looks good"
BAD: "Guys, the chart shows..."
GOOD: "RSI at 66 shows momentum, and that holder count backs it up"
GOOD: "That's a solid setup - 31K holders don't lie"`;

  try {
    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 85,
      temperature: 1.0,
    });

    let text = res.choices[0]?.message?.content || '';
    
    // Clean up common issues
    text = text.replace(/^(yo|hey|oh|so|well|look|okay|guys),?\s*/i, '');
    // Remove name lists at start
    text = text.replace(/^(james|keone|portdev|harpal|mike)(,\s*(james|keone|portdev|harpal|mike))+,?\s*/i, '');
    
    return text.trim().slice(0, 220);
  } catch (e) {
    console.error(`Error for ${botId}:`, e);
    return 'interesting setup';
  }
}

// ============================================================
// SAY — With duplicate prevention
// ============================================================

async function say(botId: BotId, content: string): Promise<void> {
  if (!content || content.length < 2) return;
  
  // Normalize for duplicate check
  const normalized = content.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
  if (sentMessages.has(normalized)) {
    console.log(`Skipping duplicate: ${content.slice(0, 30)}...`);
    return;
  }
  sentMessages.add(normalized);

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