// ============================================================
// ENHANCED COUNCIL ANALYSIS — Full integration of all systems
// ============================================================

import OpenAI from 'openai';
import type { BotId, Token } from '../../types/index.js';
import type { TechnicalIndicators } from '../technicalAnalysis.js';

// Import all enhanced systems
import { 
  getBotMentalState, 
  recordTradeResult,
  loadMentalStatesFromDB,
  getMentalStateSummary 
} from './mentalState.js';

import { 
  analyzeNarrative, 
  getFullSocialContext,
  type NarrativeAnalysis 
} from './narrativeAnalysis.js';

import { 
  analyzeExitLiquidity, 
  quickLiquidityCheck,
  suggestPositionSize,
  type ExitAnalysis 
} from './exitLiquidity.js';

import { 
  calculateBotDecision,
  type BotDecision,
  type EnhancedScores 
} from './enhancedOpinion.js';

import {
  ENHANCED_SYSTEM_PROMPTS,
  generateAnalysisPrompt,
  generateDebatePrompt,
  getBotNarrativeSummary,
} from './enhancedPrompts.js';

import { ALL_BOT_IDS, getBotConfig } from '../../bots/personalities.js';

// ============================================================
// TYPES
// ============================================================

export interface CouncilAnalysisResult {
  token: Token;
  timestamp: Date;
  
  // Individual bot decisions
  decisions: Record<BotId, BotDecision>;
  
  // Bot messages for chat
  messages: Array<{
    botId: BotId;
    content: string;
    opinion: 'bullish' | 'bearish' | 'neutral';
    confidence: number;
    mentalState: string;
  }>;
  
  // Shared analysis
  narrative: NarrativeAnalysis | null;
  exitAnalysis: ExitAnalysis;
  
  // Consensus
  consensus: {
    opinion: 'bullish' | 'bearish' | 'neutral' | 'split';
    averageConfidence: number;
    bullishVotes: number;
    bearishVotes: number;
    neutralVotes: number;
    shouldTrade: boolean;
  };
  
  // If trading
  tradeRecommendation: {
    shouldBuy: boolean;
    positionSizeMON: number;
    reasoning: string[];
    risks: string[];
  };
}

// ============================================================
// GROK CLIENT
// ============================================================

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// ============================================================
// MAIN ANALYSIS FUNCTION
// ============================================================

export async function runEnhancedCouncilAnalysis(
  token: Token,
  technicals: TechnicalIndicators | null,
  proposedPositionMON: number = 1
): Promise<CouncilAnalysisResult> {
  console.log(`\n🏛️ Enhanced Council Analysis for $${token.symbol}`);
  
  // === STEP 1: Parallel analysis ===
  console.log('📊 Running parallel analysis (narrative + exit liquidity)...');
  
  const [narrativeResult, exitAnalysis] = await Promise.all([
    getFullSocialContext(token).catch(err => {
      console.error('Narrative analysis failed:', err);
      return null;
    }),
    Promise.resolve(analyzeExitLiquidity(token, proposedPositionMON)),
  ]);
  
  const narrative = narrativeResult?.narrative || null;
  
  console.log(`   Narrative: ${narrative?.narrativeType || 'unknown'} (${narrative?.narrativeScore || 0}/100)`);
  console.log(`   Exit: ${exitAnalysis.exitDifficulty} (${exitAnalysis.liquidityScore}/100)`);
  
  // === STEP 2: Get each bot's decision ===
  console.log('🤖 Calculating bot decisions...');
  
  const decisions: Record<BotId, BotDecision> = {} as any;
  
  for (const botId of ALL_BOT_IDS) {
    const decision = calculateBotDecision(
      botId,
      token,
      technicals,
      narrative,
      exitAnalysis,
      proposedPositionMON
    );
    decisions[botId] = decision;
    
    const config = getBotConfig(botId) as any;
    console.log(`   ${config?.emoji || '🤖'} ${config?.name || botId}: ${decision.opinion} (${decision.confidence}%)`);
  }
  
  // === STEP 3: Generate messages in character ===
  console.log('💬 Generating bot messages...');
  
  const messages: CouncilAnalysisResult['messages'] = [];
  
  for (const botId of ALL_BOT_IDS) {
    const decision = decisions[botId];
    const mentalState = getBotMentalState(botId);
    const config = getBotConfig(botId);
    
    // Skip if bot should skip
    if (decision.skipReason) {
      messages.push({
        botId,
        content: `*${decision.skipReason}* - sitting this one out`,
        opinion: 'neutral',
        confidence: 0,
        mentalState: decision.mentalState,
      });
      continue;
    }
    
    try {
      const prompt = generateAnalysisPrompt(
        botId,
        token.symbol,
        token.name,
        decision.scores,
        decision,
        mentalState,
        narrative,
        exitAnalysis
      );
      
      const response = await grok.chat.completions.create({
        model: 'grok-3-latest',
        messages: [
          { role: 'system', content: ENHANCED_SYSTEM_PROMPTS[botId] },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.9,
      });
      
      const content = response.choices[0]?.message?.content?.trim() || 
        `${decision.opinion === 'bullish' ? '👍' : decision.opinion === 'bearish' ? '👎' : '🤷'} ${decision.reasoning[0] || 'No comment'}`;
      
      messages.push({
        botId,
        content,
        opinion: decision.opinion,
        confidence: decision.confidence,
        mentalState: decision.mentalState,
      });
      
    } catch (error) {
      // Fallback message
      messages.push({
        botId,
        content: `${decision.opinion.toUpperCase()}: ${decision.reasoning[0] || 'Based on my analysis'}`,
        opinion: decision.opinion,
        confidence: decision.confidence,
        mentalState: decision.mentalState,
      });
    }
    
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  
  // === STEP 4: Calculate consensus ===
  const bullishVotes = Object.values(decisions).filter(d => d.opinion === 'bullish').length;
  const bearishVotes = Object.values(decisions).filter(d => d.opinion === 'bearish').length;
  const neutralVotes = Object.values(decisions).filter(d => d.opinion === 'neutral').length;
  
  const bullishConfidence = Object.values(decisions)
    .filter(d => d.opinion === 'bullish')
    .reduce((sum, d) => sum + d.confidence, 0) / Math.max(1, bullishVotes);
  
  const avgConfidence = Object.values(decisions)
    .reduce((sum, d) => sum + d.confidence, 0) / ALL_BOT_IDS.length;
  
  let consensusOpinion: 'bullish' | 'bearish' | 'neutral' | 'split';
  
  if (bullishVotes >= 3 && bullishConfidence >= 60) {
    consensusOpinion = 'bullish';
  } else if (bearishVotes >= 3) {
    consensusOpinion = 'bearish';
  } else if (bullishVotes === bearishVotes) {
    consensusOpinion = 'split';
  } else if (neutralVotes >= 3) {
    consensusOpinion = 'neutral';
  } else {
    consensusOpinion = bullishVotes > bearishVotes ? 'bullish' : 'bearish';
  }
  
  // Sterling (Harpal) has veto power on liquidity issues
  if (decisions.sterling.opinion === 'bearish' && 
      exitAnalysis.liquidityRisk === 'extreme') {
    consensusOpinion = 'bearish';
    console.log('⚠️ Sterling vetoed due to liquidity risk');
  }
  
  const shouldTrade = consensusOpinion === 'bullish' && avgConfidence >= 55;
  
  // === STEP 5: Trade recommendation ===
  const avgPositionMultiplier = Object.values(decisions)
    .filter(d => d.opinion === 'bullish')
    .reduce((sum, d) => sum + d.positionSizeMultiplier, 0) / Math.max(1, bullishVotes);
  
  // Use the safer of: average recommendation or exit liquidity recommendation
  const safePosition = Math.min(
    proposedPositionMON * avgPositionMultiplier,
    exitAnalysis.recommendedPositionMON
  );
  
  const reasoning: string[] = [];
  const risks: string[] = [];
  
  if (shouldTrade) {
    reasoning.push(`${bullishVotes}/5 bullish votes`);
    reasoning.push(`Average confidence: ${avgConfidence.toFixed(0)}%`);
    if (narrative?.narrativeType === 'fresh') {
      reasoning.push('Fresh narrative');
    }
    if (exitAnalysis.liquidityRisk === 'low') {
      reasoning.push('Good exit liquidity');
    }
  }
  
  if (exitAnalysis.warnings.length > 0) {
    risks.push(...exitAnalysis.warnings.slice(0, 2));
  }
  if (narrative?.redFlags && narrative.redFlags.length > 0) {
    risks.push(...narrative.redFlags.slice(0, 2));
  }
  if (bearishVotes >= 2) {
    risks.push(`${bearishVotes} bearish votes`);
  }
  
  return {
    token,
    timestamp: new Date(),
    decisions,
    messages,
    narrative,
    exitAnalysis,
    consensus: {
      opinion: consensusOpinion,
      averageConfidence: Math.round(avgConfidence),
      bullishVotes,
      bearishVotes,
      neutralVotes,
      shouldTrade,
    },
    tradeRecommendation: {
      shouldBuy: shouldTrade,
      positionSizeMON: Math.round(safePosition * 100) / 100,
      reasoning,
      risks,
    },
  };
}

// ============================================================
// RECORD TRADE OUTCOME
// ============================================================

export function recordCouncilTradeOutcome(
  result: CouncilAnalysisResult,
  tradeOutcome: 'win' | 'loss',
  pnl: number,
  actualPositionMON: number
): void {
  console.log(`📝 Recording trade outcome: ${tradeOutcome} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} MON)`);
  
  // Record for each bot that voted bullish
  for (const botId of ALL_BOT_IDS) {
    const decision = result.decisions[botId];
    
    if (decision.opinion === 'bullish' && decision.shouldTrade) {
      // Bot participated in the trade
      recordTradeResult(
        botId,
        tradeOutcome,
        pnl * decision.positionSizeMultiplier, // Proportional PnL
        (actualPositionMON / 10) * 100 // Risk as % of 10 MON base
      );
    } else if (decision.opinion === 'bearish' && tradeOutcome === 'loss') {
      // Bot correctly predicted the loss - boost confidence
      const state = getBotMentalState(botId);
      state.confidence = Math.min(90, state.confidence + 5);
    }
  }
}

// ============================================================
// QUICK ANALYSIS (for rapid decisions)
// ============================================================

export async function quickCouncilCheck(
  token: Token,
  proposedPositionMON: number = 1
): Promise<{
  shouldConsider: boolean;
  reason: string;
  quickScores: {
    liquidity: number;
    holders: number;
    narrative: number;
  };
}> {
  // Quick liquidity check
  const liquidityCheck = quickLiquidityCheck(token, proposedPositionMON);
  
  if (!liquidityCheck.ok) {
    return {
      shouldConsider: false,
      reason: liquidityCheck.reason,
      quickScores: { liquidity: 0, holders: 0, narrative: 0 },
    };
  }
  
  // Quick holder check
  if (token.holders < 100) {
    return {
      shouldConsider: false,
      reason: 'Too few holders (<100)',
      quickScores: { liquidity: 50, holders: 0, narrative: 0 },
    };
  }
  
  // Quick market cap check
  if (token.mcap < 1000) {
    return {
      shouldConsider: false,
      reason: 'Market cap too low (<$1000)',
      quickScores: { liquidity: 50, holders: 30, narrative: 0 },
    };
  }
  
  const holdersScore = Math.min(100, token.holders / 100);
  const liquidityScore = liquidityCheck.ok ? 70 : 30;
  
  return {
    shouldConsider: true,
    reason: 'Passes quick checks',
    quickScores: {
      liquidity: liquidityScore,
      holders: holdersScore,
      narrative: 50, // Unknown until full analysis
    },
  };
}

// ============================================================
// INITIALIZE
// ============================================================

export async function initEnhancedCouncil(): Promise<void> {
  console.log('🧠 Initializing Enhanced Council systems...');
  await loadMentalStatesFromDB();
  console.log('✅ Enhanced Council ready');
}

// ============================================================
// EXPORTS
// ============================================================

export {
  getBotMentalState,
  getMentalStateSummary,
  recordTradeResult,
  analyzeNarrative,
  analyzeExitLiquidity,
  calculateBotDecision,
  ENHANCED_SYSTEM_PROMPTS,
};