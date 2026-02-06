// ============================================================
// ORCHESTRATOR — Main coordinator for The Council
// ============================================================

import type { BotId, Token, Message, Trade, BotEvent, ChatContext, Position } from '../types/index.js';
import { ALL_BOT_IDS, getBotConfig } from '../bots/personalities.js';
import { generateBotResponse, generateTokenAnalysis, generateDiscussionResponse, selectBotsToReact } from './grok.js';
import { getNewTokens, getTokenInfo, calculateRiskScore } from './nadfun.js';
import { executeBotTrade, shouldBotTrade, calculateTradeSize, getBotBalance } from './trading.js';
import { broadcastMessage, broadcastNewToken, broadcastVerdict, onInternalEvent } from './websocket.js';
import { saveMessage, getRecentMessages, saveToken, getOpenPositions } from '../db/index.js';
import { setCurrentToken as setCurrentTokenInBus } from './messageBus.js';
import { randomUUID } from 'crypto';

// ============================================================
// STATE
// ============================================================

let currentToken: Token | null = null;
let isAnalyzing = false;
let lastTokenScan = 0;
const TOKEN_SCAN_INTERVAL = 30_000; // 30 seconds
const seenTokens = new Set<string>();

// ============================================================
// MAIN LOOP
// ============================================================

export async function startOrchestrator(): Promise<void> {
  console.log('🏛️ The Council is now in session');

  // Listen for human events
  onInternalEvent('human_trade_request', handleHumanTradeRequest);
  onInternalEvent('human_message', handleHumanMessage);

  // Start the main loop
  loop();
}

async function loop(): Promise<void> {
  while (true) {
    try {
      // Scan for new tokens periodically
      if (Date.now() - lastTokenScan > TOKEN_SCAN_INTERVAL && !isAnalyzing) {
        await scanForNewTokens();
        lastTokenScan = Date.now();
      }

      // Small delay to prevent CPU spinning
      await sleep(1000);
    } catch (error) {
      console.error('Orchestrator error:', error);
      await sleep(5000);
    }
  }
}

// ============================================================
// TOKEN SCANNING
// ============================================================

async function scanForNewTokens(): Promise<void> {
  const tokens = await getNewTokens(10);
  
  for (const token of tokens) {
    if (seenTokens.has(token.address)) continue;
    seenTokens.add(token.address);

    // Testnet-friendly filters (lower thresholds)
    if (token.mcap < 100) continue; // Min $100 mcap
    if (token.holders < 2) continue; // At least 2 holders

    console.log(`🔍 New token found: $${token.symbol}`);
    
    // Start analysis
    await analyzeToken(token);
    break; // Only analyze one token at a time
  }
}

// ============================================================
// TOKEN ANALYSIS
// ============================================================

async function analyzeToken(token: Token): Promise<void> {
  if (isAnalyzing) return;
  isAnalyzing = true;
  currentToken = token;
  setCurrentTokenInBus(token); // Sync with messageBus for API

  try {
    // Broadcast that we're looking at a new token
    broadcastNewToken(token);
    console.log(`📢 Broadcasting new token: $${token.symbol}`);

    // Chad usually spots tokens first
    await botSaysAsync('chad', `Yo new token just dropped: $${token.symbol}. ${(token.mcap / 1000).toFixed(1)}K mcap, let's check it out 👀`);
    console.log(`💬 Chad announced token`);

    await sleep(2000);

    // Calculate risk score
    console.log(`⚠️ Calculating risk score...`);
    const { score: riskScore, flags } = await calculateRiskScore(token);
    console.log(`⚠️ Risk score: ${riskScore}/100, Flags: ${flags.join(', ') || 'None'}`);

    // ============================================================
    // PHASE 1: Initial Analysis (each bot gives first take)
    // ============================================================
    await systemMessage(`💬 Council, analyze $${token.symbol}. Discussion phase begins.`);
    console.log(`🎯 Starting Phase 1: Initial Analysis`);
    
    const opinions: Record<BotId, { opinion: string; sentiment: string; confidence: number }> = {} as any;
    const discussionHistory: Array<{ botId: BotId; content: string }> = [];
    
    // First round: each bot gives initial analysis
    const firstSpeaker = ALL_BOT_IDS[Math.floor(Math.random() * ALL_BOT_IDS.length)];
    const speakingOrder = [firstSpeaker, ...ALL_BOT_IDS.filter(b => b !== firstSpeaker)];
    console.log(`🗣️ Speaking order: ${speakingOrder.join(', ')}`);
    
    for (const botId of speakingOrder) {
      console.log(`🤖 Generating analysis for ${botId}...`);
      const additionalContext = `Risk Score: ${riskScore}/100\nFlags: ${flags.join(', ') || 'None'}`;
      const analysis = await generateTokenAnalysis(botId, token, additionalContext, discussionHistory);
      console.log(`✅ ${botId}: "${analysis.opinion.substring(0, 50)}..." [${analysis.sentiment}]`);
      opinions[botId] = analysis;

      await botSaysAsync(botId, analysis.opinion);
      discussionHistory.push({ botId, content: analysis.opinion });
      await sleep(2000 + Math.random() * 1500);
    }

    // ============================================================
    // PHASE 2: Discussion Rounds (bots respond to each other)
    // ============================================================
    const DISCUSSION_ROUNDS = 2; // 2 rounds of back-and-forth
    
    for (let round = 0; round < DISCUSSION_ROUNDS; round++) {
      // Select 2-3 bots to respond this round
      const respondingBots = selectBotsForDiscussion(discussionHistory, 3);
      
      for (const botId of respondingBots) {
        const response = await generateDiscussionResponse(botId, token, discussionHistory, riskScore);
        
        if (response && response.trim()) {
          await botSaysAsync(botId, response);
          discussionHistory.push({ botId, content: response });
          
          // Update opinion if bot changed their mind
          const newSentiment = detectSentimentChange(response);
          if (newSentiment) {
            opinions[botId].sentiment = newSentiment;
          }
        }
        
        await sleep(2000 + Math.random() * 1000);
      }
    }

    // ============================================================
    // PHASE 3: Voting
    // ============================================================
    console.log(`🗳️ Starting Phase 3: Voting`);
    await systemMessage(`🗳️ VOTE TIME! Council, cast your votes on $${token.symbol}.`);
    await sleep(1500);

    // Each bot announces their vote
    for (const botId of ALL_BOT_IDS) {
      const analysis = opinions[botId];
      const vote = analysis.sentiment === 'bullish' ? '🟢 BUY' : 
                   analysis.sentiment === 'bearish' ? '🔴 PASS' : '🟡 WATCH';
      const config = getBotConfig(botId);
      
      await botSaysAsync(botId, `${vote} — ${getVoteReason(botId, analysis.sentiment)}`);
      await sleep(1000 + Math.random() * 500);
    }

    // ============================================================
    // PHASE 4: Final Verdict
    // ============================================================
    console.log(`📊 Calculating final verdict...`);
    const verdict = determineVerdict(opinions, riskScore);
    
    // Count votes
    const buyVotes = Object.values(opinions).filter(o => o.sentiment === 'bullish').length;
    const passVotes = Object.values(opinions).filter(o => o.sentiment === 'bearish').length;
    const watchVotes = Object.values(opinions).filter(o => o.sentiment === 'neutral').length;

    await systemMessage(`📊 VERDICT: ${verdict.toUpperCase()} — BUY: ${buyVotes} | PASS: ${passVotes} | WATCH: ${watchVotes}`);

    // Save token analysis
    await saveToken(token, {
      tokenAddress: token.address,
      riskScore,
      flags,
      verdict,
      opinions: Object.fromEntries(
        Object.entries(opinions).map(([k, v]) => [k, v.opinion])
      ) as Record<BotId, string>,
    });

    // Broadcast verdict
    broadcastVerdict(
      token,
      verdict,
      Object.fromEntries(
        Object.entries(opinions).map(([k, v]) => [k, v.opinion])
      )
    );

    // Execute trades based on verdict
    if (verdict === 'buy') {
      await executeTrades(token, opinions, riskScore);
    } else {
      await botSaysAsync('sterling', `Gentlemen, the council has spoken: ${verdict.toUpperCase()}. Moving on.`);
    }

  } catch (error) {
    console.error('Error analyzing token:', error);
  } finally {
    isAnalyzing = false;
  }
}

// ============================================================
// DISCUSSION HELPERS
// ============================================================

function selectBotsForDiscussion(
  history: Array<{ botId: BotId; content: string }>,
  maxBots: number
): BotId[] {
  // Bots who haven't spoken recently should speak
  const recentSpeakers = history.slice(-3).map(h => h.botId);
  const candidates = ALL_BOT_IDS.filter(b => !recentSpeakers.includes(b));
  
  // If all bots spoke recently, pick randomly
  const pool = candidates.length >= 2 ? candidates : ALL_BOT_IDS;
  
  // Shuffle and pick
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(maxBots, shuffled.length));
}

function detectSentimentChange(response: string): 'bullish' | 'bearish' | 'neutral' | null {
  const lower = response.toLowerCase();
  
  // Detect if bot changed their mind
  if (lower.includes('fair point') || lower.includes('you\'re right') || lower.includes('i agree') || 
      lower.includes('good point') || lower.includes('ok ') || lower.includes('actually')) {
    // Bot might have changed their mind - check new sentiment
    if (lower.includes('bullish') || lower.includes('ape') || lower.includes('buy')) return 'bullish';
    if (lower.includes('pass') || lower.includes('rug') || lower.includes('skip')) return 'bearish';
    return 'neutral';
  }
  
  return null; // No change detected
}

function getVoteReason(botId: BotId, sentiment: string): string {
  const reasons: Record<BotId, Record<string, string>> = {
    chad: {
      bullish: "let's fkn go, aping this 🔥",
      bearish: "even I'm not touching this one 💀",
      neutral: "setup forming, not ready yet",
    },
    quantum: {
      bullish: "data supports entry, probability favors upside",
      bearish: "statistics indicate high rug probability",
      neutral: "insufficient data, need more confirmation",
    },
    sensei: {
      bullish: "the vibes are immaculate, nakama energy strong 🎌",
      bearish: "no community soul here, feels like a trap",
      neutral: "mixed signals, watching for now",
    },
    sterling: {
      bullish: "reluctantly, the fundamentals check out",
      bearish: "wouldn't touch this with a ten-foot pole 🎩",
      neutral: "more due diligence required",
    },
    oracle: {
      bullish: "the chains whisper... fortune awaits 👁️",
      bearish: "darkness surrounds this one... avoid",
      neutral: "the path is unclear...",
    },
  };
  
  return reasons[botId]?.[sentiment] || "no comment";
}

// ============================================================
// VERDICT DETERMINATION
// ============================================================

function determineVerdict(
  opinions: Record<BotId, { opinion: string; sentiment: string; confidence: number }>,
  riskScore: number
): 'buy' | 'pass' | 'watch' {
  // Weight by win rate (would come from DB in real impl)
  const weights: Record<BotId, number> = {
    oracle: 1.5,    // Oracle has best track record
    sterling: 1.3,  // Sterling is conservative but accurate
    quantum: 1.2,   // Data-driven
    sensei: 1.0,    // Average
    chad: 0.7,      // Chad's opinion matters less due to poor record
  };

  let bullishScore = 0;
  let bearishScore = 0;
  let totalWeight = 0;

  for (const [botId, analysis] of Object.entries(opinions)) {
    const weight = weights[botId as BotId] * (analysis.confidence / 100);
    totalWeight += weight;

    if (analysis.sentiment === 'bullish') {
      bullishScore += weight;
    } else if (analysis.sentiment === 'bearish') {
      bearishScore += weight;
    }
  }

  const bullishPercent = (bullishScore / totalWeight) * 100;
  const bearishPercent = (bearishScore / totalWeight) * 100;

  // High risk = need more consensus to buy
  const buyThreshold = riskScore > 50 ? 70 : 55;
  const passThreshold = 40;

  if (bullishPercent >= buyThreshold && riskScore < 70) {
    return 'buy';
  } else if (bearishPercent >= passThreshold || riskScore >= 70) {
    return 'pass';
  } else {
    return 'watch';
  }
}

// ============================================================
// EXECUTE TRADES
// ============================================================

async function executeTrades(
  token: Token,
  opinions: Record<BotId, { opinion: string; sentiment: string; confidence: number }>,
  riskScore: number
): Promise<void> {
  for (const botId of ALL_BOT_IDS) {
    const analysis = opinions[botId];
    
    // Check if bot wants to trade
    if (!shouldBotTrade(botId, riskScore, analysis.sentiment as any, analysis.confidence)) {
      continue;
    }

    const balance = await getBotBalance(botId);
    const tradeSize = calculateTradeSize(botId, balance, analysis.confidence);

    if (tradeSize < 0.1) continue; // Too small

    // Announce trade intent
    const config = getBotConfig(botId);
    await botSaysAsync(botId, getTradeAnnouncement(botId, tradeSize, token.symbol));

    await sleep(1000);

    // Execute trade
    const trade = await executeBotTrade(botId, token, tradeSize, 'buy');

    if (trade && trade.status === 'confirmed') {
      // Announce successful trade
      await botSaysAsync(botId, getTradeConfirmation(botId, trade));
      
      // Other bots might react
      await handleBotReactions({
        type: 'bot_trade',
        data: { botId, side: 'buy', amount: tradeSize, token: token.symbol, txHash: trade.txHash },
      });
    } else {
      await botSaysAsync(botId, `Trade failed... ${botId === 'chad' ? 'rip 💀' : ''}`);
    }

    await sleep(2000);
  }
}

// ============================================================
// BOT MESSAGES
// ============================================================

async function botSaysAsync(botId: BotId, content: string): Promise<void> {
  const message: Message = {
    id: randomUUID(),
    botId,
    content,
    token: currentToken?.address,
    messageType: 'chat',
    createdAt: new Date(),
  };

  await saveMessage(message);
  broadcastMessage(message);
}

async function systemMessage(content: string): Promise<void> {
  const message: Message = {
    id: randomUUID(),
    botId: 'system' as any,
    content,
    messageType: 'system',
    createdAt: new Date(),
  };

  await saveMessage(message);
  broadcastMessage(message);
}

// ============================================================
// BOT REACTIONS
// ============================================================

async function handleBotReactions(event: BotEvent): Promise<void> {
  const botsToReact = selectBotsToReact(event, 2);
  
  for (const botId of botsToReact) {
    // Don't react to own events
    if (event.type === 'bot_trade' && (event.data as any).botId === botId) continue;

    await sleep(1500 + Math.random() * 1500);

    const context = await buildContext(event);
    const response = await generateBotResponse(botId, context);

    await botSaysAsync(botId, response);
  }
}

async function buildContext(event: BotEvent): Promise<ChatContext> {
  const recentMessages = await getRecentMessages(10);
  const positions: Position[] = []; // Would fetch from DB

  return {
    currentToken,
    recentMessages,
    positions,
    event,
  };
}

// ============================================================
// HUMAN INTERACTIONS
// ============================================================

async function handleHumanTradeRequest(data: {
  address: string;
  token: string;
  amount: number;
}): Promise<void> {
  // Broadcast human trade (they execute on frontend, we just react)
  const event: BotEvent = {
    type: 'human_trade',
    data: {
      address: data.address,
      side: 'buy',
      amount: data.amount,
      token: data.token,
      txHash: '', // Would come from frontend
    },
  };

  await handleBotReactions(event);
}

async function handleHumanMessage(data: {
  address: string;
  content: string;
}): Promise<void> {
  const message: Message = {
    id: randomUUID(),
    botId: `human_${data.address}`,
    content: data.content,
    token: currentToken?.address,
    messageType: 'chat',
    createdAt: new Date(),
  };

  await saveMessage(message);
  broadcastMessage(message);

  // Bots might react to human message
  await handleBotReactions({
    type: 'new_message',
    data: message,
  });
}

// ============================================================
// TRADE ANNOUNCEMENTS (personality-specific)
// ============================================================

function getTradeAnnouncement(botId: BotId, amount: number, symbol: string): string {
  switch (botId) {
    case 'chad':
      return `Aight I'm aping ${amount} MON into $${symbol}, LFG 🦍`;
    case 'quantum':
      return `The data supports a position. Allocating ${amount} MON to $${symbol}.`;
    case 'sensei':
      return `The vibes are strong with this one. Entering with ${amount} MON, sugoi!`;
    case 'sterling':
      return `Against my better judgment, I'm committing ${amount} MON. This better not be another one of Chad's disasters.`;
    case 'oracle':
      return `The patterns align. ${amount} MON.`;
    default:
      return `Buying ${amount} MON of $${symbol}`;
  }
}

function getTradeConfirmation(botId: BotId, trade: Trade): string {
  const txShort = trade.txHash.slice(0, 10) + '...';
  
  switch (botId) {
    case 'chad':
      return `We're in boys 🔥 TX: ${txShort}`;
    case 'quantum':
      return `Position confirmed. TX: ${txShort}. Now we observe.`;
    case 'sensei':
      return `Yosh! Trade complete. TX: ${txShort}`;
    case 'sterling':
      return `Transaction confirmed: ${txShort}. Let's hope this ages well.`;
    case 'oracle':
      return `It is done. ${txShort}`;
    default:
      return `Trade confirmed: ${txShort}`;
  }
}

// ============================================================
// UTILS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// EXPORT
// ============================================================

export { currentToken, isAnalyzing };