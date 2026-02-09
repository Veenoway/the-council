// ============================================================
// ENHANCED BOT OPINION — With Mental State, Narrative, Exit Liquidity
// ============================================================

import type { BotId, Token } from '../../types/index.js';
import type { TechnicalIndicators } from '../technicalAnalysis.js';
import type { NarrativeAnalysis } from './narrativeAnalysis.js';
import type { ExitAnalysis } from './exitLiquidity.js';
import { 
  getBotMentalState, 
  calculateMentalModifiers, 
  applyPersonalityToModifiers,
  getPersonalityTraits,
  type MentalModifiers 
} from './mentalState.js';

// ============================================================
// TYPES
// ============================================================

export interface EnhancedScores {
  // Base scores (from TA)
  holdersScore: number;
  taScore: number;
  lpScore: number;
  momentumScore: number;
  
  // New scores
  narrativeScore: number;
  exitLiquidityScore: number;
  scamRiskScore: number;  // Higher = safer
  
  // Computed
  rawScore: number;
  mentalAdjustedScore: number;
  finalScore: number;
  
  // Metadata
  weights: Record<string, number>;
  adjustments: string[];
}

export interface BotDecision {
  opinion: 'bullish' | 'bearish' | 'neutral';
  confidence: number;        // 0-100
  positionSizeMultiplier: number;  // 0.3 - 1.5
  shouldTrade: boolean;
  skipReason?: string;
  reasoning: string[];
  mentalState: string;
  scores: EnhancedScores;
}

// ============================================================
// BOT WEIGHTS — Each bot prioritizes differently
// ============================================================

const BOT_WEIGHTS: Record<BotId, {
  holders: number;
  ta: number;
  lp: number;
  momentum: number;
  narrative: number;
  exitLiquidity: number;
  scamRisk: number;
  bullishThreshold: number;
  bearishThreshold: number;
}> = {
  chad: {
    holders: 0.15,
    ta: 0.10,
    lp: 0.05,
    momentum: 0.25,
    narrative: 0.30,      // James cares A LOT about narrative/memes
    exitLiquidity: 0.05,  // YOLO
    scamRisk: 0.10,
    bullishThreshold: 45, // Easy to convince
    bearishThreshold: 25,
  },
  quantum: {
    holders: 0.15,
    ta: 0.35,             // Keone is all about TA
    lp: 0.15,
    momentum: 0.15,
    narrative: 0.05,      // Doesn't care about memes
    exitLiquidity: 0.10,
    scamRisk: 0.05,
    bullishThreshold: 55, // Needs solid data
    bearishThreshold: 40,
  },
  sensei: {
    holders: 0.35,        // Community is everything
    ta: 0.10,
    lp: 0.10,
    momentum: 0.15,
    narrative: 0.20,      // Believes in the story
    exitLiquidity: 0.05,
    scamRisk: 0.05,
    bullishThreshold: 50,
    bearishThreshold: 30,
  },
  sterling: {
    holders: 0.10,
    ta: 0.15,
    lp: 0.25,             // LP is critical for Harpal
    momentum: 0.05,
    narrative: 0.05,
    exitLiquidity: 0.30,  // Can we get out? Most important
    scamRisk: 0.10,
    bullishThreshold: 65, // Very hard to convince
    bearishThreshold: 50,
  },
  oracle: {
    holders: 0.15,
    ta: 0.20,
    lp: 0.10,
    momentum: 0.15,
    narrative: 0.25,      // Follows the "signs"
    exitLiquidity: 0.05,
    scamRisk: 0.10,
    bullishThreshold: 50,
    bearishThreshold: 35,
  },
};

// ============================================================
// CALCULATE ENHANCED SCORES
// ============================================================

export function calculateEnhancedScores(
  botId: BotId,
  token: Token,
  ta: TechnicalIndicators | null,
  narrative: NarrativeAnalysis | null,
  exitAnalysis: ExitAnalysis | null,
  proposedPositionMON: number
): EnhancedScores {
  const weights = BOT_WEIGHTS[botId];
  const adjustments: string[] = [];
  
  // === BASE SCORES ===
  
  // Holders score (0-100)
  let holdersScore = 50;
  if (token.holders >= 30000) holdersScore = 98;
  else if (token.holders >= 20000) holdersScore = 95;
  else if (token.holders >= 10000) holdersScore = 90;
  else if (token.holders >= 5000) holdersScore = 80;
  else if (token.holders >= 2000) holdersScore = 70;
  else if (token.holders >= 1000) holdersScore = 60;
  else if (token.holders >= 500) holdersScore = 50;
  else holdersScore = 30;
  
  // TA score (from technical analysis)
  const taScore = ta?.confidence || 50;
  
  // LP score
  const lpRatio = token.liquidity / token.mcap;
  let lpScore = 50;
  if (lpRatio >= 0.20) lpScore = 90;
  else if (lpRatio >= 0.15) lpScore = 80;
  else if (lpRatio >= 0.10) lpScore = 70;
  else if (lpRatio >= 0.07) lpScore = 55;
  else if (lpRatio >= 0.05) lpScore = 40;
  else lpScore = 20;
  
  // Momentum score
  let momentumScore = 50;
  if (ta) {
    if (ta.volumeSpike) momentumScore += 15;
    if (ta.obvTrend === 'accumulation') momentumScore += 10;
    if (ta.whaleActivity === 'buying') momentumScore += 15;
    if (ta.whaleActivity === 'selling') momentumScore -= 20;
    if (ta.trend === 'strong_uptrend') momentumScore += 15;
    if (ta.trend === 'downtrend') momentumScore -= 15;
  }
  momentumScore = Math.max(0, Math.min(100, momentumScore));
  
  // === NEW SCORES ===
  
  // Narrative score
  let narrativeScore = 50;
  if (narrative) {
    narrativeScore = (narrative.narrativeScore * 0.4 + narrative.socialScore * 0.4 + (narrative.shouldTrade ? 20 : 0));
    
    // Penalties
    if (narrative.isLikelyScam) {
      narrativeScore *= 0.2;
      adjustments.push('Scam signals detected');
    }
    if (narrative.narrativeType === 'dead' || narrative.narrativeType === 'tired') {
      narrativeScore *= 0.6;
      adjustments.push('Narrative is tired/dead');
    }
    if (narrative.narrativeTiming === 'late' || narrative.narrativeTiming === 'dead') {
      narrativeScore *= 0.7;
      adjustments.push('Late to the narrative');
    }
    
    // Bonuses
    if (narrative.narrativeType === 'fresh') {
      narrativeScore *= 1.2;
      adjustments.push('Fresh narrative');
    }
    if (narrative.hasActiveCommunity) {
      narrativeScore *= 1.1;
      adjustments.push('Active community');
    }
  }
  narrativeScore = Math.max(0, Math.min(100, narrativeScore));
  
  // Exit liquidity score
  let exitLiquidityScore = 50;
  if (exitAnalysis) {
    exitLiquidityScore = exitAnalysis.liquidityScore;
    
    if (!exitAnalysis.canExit) {
      exitLiquidityScore = 0;
      adjustments.push('Cannot exit position');
    } else if (exitAnalysis.exitDifficulty === 'hard') {
      exitLiquidityScore *= 0.5;
      adjustments.push('Hard to exit');
    } else if (exitAnalysis.exitDifficulty === 'moderate') {
      exitLiquidityScore *= 0.8;
    }
    
    if (exitAnalysis.priceImpactPercent > 10) {
      adjustments.push(`${exitAnalysis.priceImpactPercent.toFixed(1)}% exit slippage`);
    }
  }
  
  // Scam risk score (higher = safer)
  let scamRiskScore = 70; // Default assume somewhat safe
  if (narrative) {
    if (narrative.isLikelyScam) {
      scamRiskScore = 10;
      adjustments.push('HIGH SCAM RISK');
    } else if (narrative.redFlags.length >= 3) {
      scamRiskScore = 30;
      adjustments.push(`${narrative.redFlags.length} red flags`);
    } else if (narrative.redFlags.length >= 1) {
      scamRiskScore = 50;
    } else {
      scamRiskScore = 80;
    }
  }
  
  // === CALCULATE RAW SCORE ===
  const rawScore = 
    holdersScore * weights.holders +
    taScore * weights.ta +
    lpScore * weights.lp +
    momentumScore * weights.momentum +
    narrativeScore * weights.narrative +
    exitLiquidityScore * weights.exitLiquidity +
    scamRiskScore * weights.scamRisk;
  
  return {
    holdersScore,
    taScore,
    lpScore,
    momentumScore,
    narrativeScore,
    exitLiquidityScore,
    scamRiskScore,
    rawScore,
    mentalAdjustedScore: rawScore, // Will be adjusted later
    finalScore: rawScore,          // Will be adjusted later
    weights: weights as any,
    adjustments,
  };
}

// ============================================================
// MAIN DECISION FUNCTION
// ============================================================

export function calculateBotDecision(
  botId: BotId,
  token: Token,
  ta: TechnicalIndicators | null,
  narrative: NarrativeAnalysis | null,
  exitAnalysis: ExitAnalysis | null,
  proposedPositionMON: number
): BotDecision {
  const weights = BOT_WEIGHTS[botId];
  const traits = getPersonalityTraits(botId);
  const mentalState = getBotMentalState(botId);
  const mentalModifiers = applyPersonalityToModifiers(botId, calculateMentalModifiers(botId));
  
  const reasoning: string[] = [];
  
  // === CHECK IF SHOULD SKIP ===
  if (mentalModifiers.shouldSkip) {
    return {
      opinion: 'neutral',
      confidence: 0,
      positionSizeMultiplier: 0,
      shouldTrade: false,
      skipReason: mentalModifiers.skipReason,
      reasoning: [mentalModifiers.skipReason || 'Skipping this one'],
      mentalState: mentalModifiers.mentalNote,
      scores: calculateEnhancedScores(botId, token, ta, narrative, exitAnalysis, proposedPositionMON),
    };
  }
  
  // === CALCULATE SCORES ===
  const scores = calculateEnhancedScores(botId, token, ta, narrative, exitAnalysis, proposedPositionMON);
  
  // === APPLY MENTAL STATE ADJUSTMENT ===
  let adjustedScore = scores.rawScore;
  
  // Emotional bias
  adjustedScore += mentalState.emotionalBias * (1 - traits.emotionalStability) * 0.5;
  
  // Confidence affects conviction
  if (mentalState.confidence < 40) {
    adjustedScore *= 0.9;
    reasoning.push('Low confidence affecting judgment');
  } else if (mentalState.confidence > 80) {
    adjustedScore *= 1.05;
  }
  
  scores.mentalAdjustedScore = adjustedScore;
  
  // === ADD INTUITION (RANDOMNESS) ===
  const intuition = (Math.random() * 10) - 5; // -5 to +5
  const intuitionWeight = 1 - traits.emotionalStability; // More emotional = more intuition
  adjustedScore += intuition * intuitionWeight;
  
  if (Math.abs(intuition) > 3) {
    reasoning.push(intuition > 0 ? 'Got a good feeling about this' : 'Something feels off');
  }
  
  scores.finalScore = adjustedScore;
  
  // === ADJUST THRESHOLDS BASED ON MENTAL STATE ===
  const adjustedBullishThreshold = weights.bullishThreshold + mentalModifiers.thresholdModifier;
  const adjustedBearishThreshold = weights.bearishThreshold + (mentalModifiers.thresholdModifier * 0.7);
  
  // === DETERMINE OPINION ===
  let opinion: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  
  if (adjustedScore >= adjustedBullishThreshold) {
    opinion = 'bullish';
    confidence = Math.min(95, 50 + (adjustedScore - adjustedBullishThreshold) * 2);
  } else if (adjustedScore < adjustedBearishThreshold) {
    opinion = 'bearish';
    confidence = Math.min(95, 50 + (adjustedBearishThreshold - adjustedScore) * 2);
  } else {
    opinion = 'neutral';
    confidence = 40 + Math.random() * 20;
  }
  
  // === SPECIAL OVERRIDES ===
  
  // Harpal override: If exit liquidity is bad, he votes bearish
  if (botId === 'sterling' && exitAnalysis) {
    if (!exitAnalysis.canExit || exitAnalysis.liquidityRisk === 'extreme') {
      opinion = 'bearish';
      confidence = 90;
      reasoning.push(exitAnalysis.harpalVerdict);
    } else if (exitAnalysis.liquidityRisk === 'high') {
      if (opinion === 'bullish') {
        opinion = 'neutral';
        confidence *= 0.6;
      }
      reasoning.push(`Exit liquidity concern: ${exitAnalysis.warnings[0] || 'thin LP'}`);
    }
  }
  
  // James override: If narrative is dead, he passes even with good TA
  if (botId === 'chad' && narrative) {
    if (narrative.narrativeType === 'dead' || narrative.narrativeScore < 30) {
      if (opinion === 'bullish') {
        opinion = 'neutral';
        confidence *= 0.5;
      }
      reasoning.push('Narrative is dead, passing regardless of chart');
    } else if (narrative.narrativeType === 'fresh' && narrative.socialScore > 70) {
      // Fresh narrative boosts James' conviction
      confidence = Math.min(95, confidence * 1.2);
      reasoning.push('Fresh narrative with social buzz');
    }
  }
  
  // Oracle override: Uses narrative sentiment differently
  if (botId === 'oracle' && narrative) {
    if (narrative.sentimentOnX === 'very_negative') {
      // Oracle is contrarian
      if (opinion === 'bearish') {
        opinion = 'neutral';
        reasoning.push('Extreme fear can signal opportunity');
      }
    } else if (narrative.sentimentOnX === 'very_positive' && narrative.isBeingRaided) {
      // Too much hype = danger
      if (opinion === 'bullish') {
        opinion = 'neutral';
        confidence *= 0.7;
      }
      reasoning.push('Excessive hype, possible exit liquidity');
    }
  }
  
  // Scam detection override
  if (narrative?.isLikelyScam && scores.scamRiskScore < 30) {
    opinion = 'bearish';
    confidence = 85;
    reasoning.push('Scam indicators detected');
  }
  
  // === POSITION SIZE ===
  let positionSizeMultiplier = mentalModifiers.positionSizeModifier;
  
  // Adjust based on confidence
  if (confidence < 50) {
    positionSizeMultiplier *= 0.5;
  } else if (confidence > 80) {
    positionSizeMultiplier *= 1.2;
  }
  
  // Harpal's exit liquidity adjustment
  if (exitAnalysis && exitAnalysis.recommendedPositionMON < proposedPositionMON) {
    const ratio = exitAnalysis.recommendedPositionMON / proposedPositionMON;
    positionSizeMultiplier = Math.min(positionSizeMultiplier, ratio);
    reasoning.push(`Sizing down to ${exitAnalysis.recommendedPositionMON.toFixed(1)} MON for safe exit`);
  }
  
  // Clamp
  positionSizeMultiplier = Math.max(0.3, Math.min(1.5, positionSizeMultiplier));
  
  // === SHOULD TRADE? ===
  const shouldTrade = opinion === 'bullish' && confidence >= 50;
  
  // === BUILD REASONING ===
  if (scores.adjustments.length > 0) {
    reasoning.push(...scores.adjustments.slice(0, 2));
  }
  
  if (opinion === 'bullish') {
    reasoning.unshift(`Score ${adjustedScore.toFixed(0)} > threshold ${adjustedBullishThreshold.toFixed(0)}`);
  } else if (opinion === 'bearish') {
    reasoning.unshift(`Score ${adjustedScore.toFixed(0)} < threshold ${adjustedBearishThreshold.toFixed(0)}`);
  }
  
  return {
    opinion,
    confidence: Math.round(confidence),
    positionSizeMultiplier: Math.round(positionSizeMultiplier * 100) / 100,
    shouldTrade,
    reasoning: reasoning.slice(0, 4), // Max 4 reasons
    mentalState: mentalModifiers.mentalNote || 'focused',
    scores,
  };
}

// ============================================================
// EXPORT
// ============================================================

export { BOT_WEIGHTS };