// ============================================================
// EXIT LIQUIDITY ANALYSIS — Can we actually exit this position?
// ============================================================

import type { Token } from '../../types/index.js';

// ============================================================
// TYPES
// ============================================================

export interface ExitAnalysis {
  // Can we exit?
  canExit: boolean;
  exitDifficulty: 'easy' | 'moderate' | 'hard' | 'impossible';
  
  // Price impact
  priceImpactPercent: number;      // Expected price drop from selling
  worstCasePriceImpact: number;    // If panic selling
  
  // Recommended position
  maxSafePositionMON: number;      // Max position with <5% slippage
  recommendedPositionMON: number;  // Recommended for <2% slippage
  
  // Time to exit
  estimatedExitTimeMinutes: number;  // How long to fully exit
  canExitIn10Minutes: boolean;
  
  // Liquidity health
  liquidityScore: number;          // 0-100
  liquidityRisk: 'low' | 'medium' | 'high' | 'extreme';
  
  // Warnings
  warnings: string[];
  
  // For Harpal's reasoning
  harpalVerdict: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const SLIPPAGE_TOLERANCE = {
  safe: 0.02,      // 2%
  moderate: 0.05,  // 5%
  risky: 0.10,     // 10%
  danger: 0.20,    // 20%
};

// ============================================================
// CALCULATE PRICE IMPACT
// ============================================================

/**
 * Simplified constant product AMM price impact calculation
 * For a trade of size `amountIn` against a pool with `reserveOut`
 * Price impact ≈ amountIn / (reserveOut * 2)
 */
function calculatePriceImpact(
  tradeAmountMON: number,
  liquidityMON: number
): number {
  if (liquidityMON <= 0) return 1; // 100% impact
  
  // Simplified: assumes 50/50 pool
  const reserveTokenSide = liquidityMON / 2;
  
  // Price impact from constant product formula
  // Δy/y = Δx / (x + Δx)
  const impact = tradeAmountMON / (reserveTokenSide + tradeAmountMON);
  
  return Math.min(1, impact);
}

/**
 * Calculate how much we can sell with given max slippage
 */
function maxTradeForSlippage(
  liquidityMON: number,
  maxSlippage: number
): number {
  if (liquidityMON <= 0) return 0;
  
  const reserveTokenSide = liquidityMON / 2;
  
  // From impact formula: slippage = trade / (reserve + trade)
  // Solving for trade: trade = slippage * reserve / (1 - slippage)
  const maxTrade = (maxSlippage * reserveTokenSide) / (1 - maxSlippage);
  
  return Math.max(0, maxTrade);
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

export function analyzeExitLiquidity(
  token: Token,
  proposedPositionMON: number
): ExitAnalysis {
  const warnings: string[] = [];
  
  // === BASIC METRICS ===
  const lpRatio = token.liquidity / token.mcap;
  const liquidityMON = token.liquidity; // Assuming liquidity is in MON equivalent
  
  // === PRICE IMPACT CALCULATION ===
  const priceImpact = calculatePriceImpact(proposedPositionMON, liquidityMON);
  const priceImpactPercent = priceImpact * 100;
  
  // Worst case: panic sell with others doing the same
  const worstCasePriceImpact = priceImpact * 2.5; // Assume 2.5x worse in panic
  
  // === MAX SAFE POSITIONS ===
  const maxSafePosition = maxTradeForSlippage(liquidityMON, SLIPPAGE_TOLERANCE.safe);
  const recommendedPosition = maxTradeForSlippage(liquidityMON, SLIPPAGE_TOLERANCE.moderate);
  
  // === EXIT DIFFICULTY ===
  let exitDifficulty: 'easy' | 'moderate' | 'hard' | 'impossible';
  
  if (priceImpact < SLIPPAGE_TOLERANCE.safe) {
    exitDifficulty = 'easy';
  } else if (priceImpact < SLIPPAGE_TOLERANCE.moderate) {
    exitDifficulty = 'moderate';
  } else if (priceImpact < SLIPPAGE_TOLERANCE.danger) {
    exitDifficulty = 'hard';
    warnings.push(`${priceImpactPercent.toFixed(1)}% price impact on exit`);
  } else {
    exitDifficulty = 'impossible';
    warnings.push('Position too large relative to liquidity');
  }
  
  // === CAN WE EXIT? ===
  const canExit = priceImpact < 0.5; // Can't exit if >50% slippage
  
  // === TIME TO EXIT ===
  // Estimate: can sell ~2% of LP per minute without major impact
  const safeExitRatePerMinute = liquidityMON * 0.02;
  const estimatedExitTime = proposedPositionMON / safeExitRatePerMinute;
  const canExitIn10Minutes = estimatedExitTime <= 10;
  
  // === LIQUIDITY SCORE ===
  let liquidityScore = 50;
  
  // LP ratio contribution (0-30 points)
  if (lpRatio >= 0.15) liquidityScore += 30;
  else if (lpRatio >= 0.10) liquidityScore += 20;
  else if (lpRatio >= 0.07) liquidityScore += 10;
  else if (lpRatio < 0.05) liquidityScore -= 20;
  
  // Absolute liquidity (0-30 points)
  if (liquidityMON >= 10000) liquidityScore += 30;
  else if (liquidityMON >= 5000) liquidityScore += 20;
  else if (liquidityMON >= 1000) liquidityScore += 10;
  else if (liquidityMON < 500) liquidityScore -= 20;
  
  // Position relative to liquidity (0-20 points)
  const positionToLPRatio = proposedPositionMON / liquidityMON;
  if (positionToLPRatio < 0.01) liquidityScore += 20;
  else if (positionToLPRatio < 0.02) liquidityScore += 10;
  else if (positionToLPRatio > 0.05) liquidityScore -= 15;
  else if (positionToLPRatio > 0.10) liquidityScore -= 30;
  
  liquidityScore = Math.max(0, Math.min(100, liquidityScore));
  
  // === LIQUIDITY RISK ===
  let liquidityRisk: 'low' | 'medium' | 'high' | 'extreme';
  
  if (liquidityScore >= 70) liquidityRisk = 'low';
  else if (liquidityScore >= 50) liquidityRisk = 'medium';
  else if (liquidityScore >= 30) liquidityRisk = 'high';
  else liquidityRisk = 'extreme';
  
  // === ADDITIONAL WARNINGS ===
  if (lpRatio < 0.05) {
    warnings.push(`LP ratio only ${(lpRatio * 100).toFixed(1)}% - thin liquidity`);
  }
  
  if (proposedPositionMON > maxSafePosition) {
    warnings.push(`Position ${proposedPositionMON.toFixed(1)} MON exceeds safe size ${maxSafePosition.toFixed(1)} MON`);
  }
  
  if (!canExitIn10Minutes) {
    warnings.push(`Exit would take ~${estimatedExitTime.toFixed(0)} minutes to avoid major slippage`);
  }
  
  if (token.holders < 100 && liquidityMON < 1000) {
    warnings.push('Low holders + low LP = high rug risk');
  }
  
  // === HARPAL'S VERDICT ===
  let harpalVerdict: string;
  
  if (liquidityRisk === 'extreme') {
    harpalVerdict = `Hard pass. ${(lpRatio * 100).toFixed(1)}% LP ratio means we'd move the price ${priceImpactPercent.toFixed(0)}% just entering. Exit would be a bloodbath.`;
  } else if (liquidityRisk === 'high') {
    harpalVerdict = `Concerned. LP is thin - max safe position is ${maxSafePosition.toFixed(1)} MON. Going bigger means accepting ${priceImpactPercent.toFixed(1)}% slippage on exit.`;
  } else if (liquidityRisk === 'medium') {
    harpalVerdict = `Acceptable risk if we size correctly. Recommend ${recommendedPosition.toFixed(1)} MON max. Current proposal has ${priceImpactPercent.toFixed(1)}% expected slippage.`;
  } else {
    harpalVerdict = `Liquidity looks healthy. ${liquidityMON.toFixed(0)} MON in LP, we can exit ${proposedPositionMON.toFixed(1)} MON with only ${priceImpactPercent.toFixed(2)}% impact.`;
  }
  
  return {
    canExit,
    exitDifficulty,
    priceImpactPercent,
    worstCasePriceImpact: worstCasePriceImpact * 100,
    maxSafePositionMON: Math.round(maxSafePosition * 100) / 100,
    recommendedPositionMON: Math.round(recommendedPosition * 100) / 100,
    estimatedExitTimeMinutes: Math.round(estimatedExitTime * 10) / 10,
    canExitIn10Minutes,
    liquidityScore,
    liquidityRisk,
    warnings,
    harpalVerdict,
  };
}

// ============================================================
// QUICK CHECK — For fast decisions
// ============================================================

export function quickLiquidityCheck(token: Token, positionMON: number): {
  ok: boolean;
  reason: string;
  maxSafe: number;
} {
  const lpRatio = token.liquidity / token.mcap;
  const impact = calculatePriceImpact(positionMON, token.liquidity);
  const maxSafe = maxTradeForSlippage(token.liquidity, SLIPPAGE_TOLERANCE.moderate);
  
  if (lpRatio < 0.03) {
    return { ok: false, reason: 'LP ratio too low (<3%)', maxSafe };
  }
  
  if (impact > SLIPPAGE_TOLERANCE.risky) {
    return { ok: false, reason: `Would cause ${(impact * 100).toFixed(1)}% slippage`, maxSafe };
  }
  
  if (token.liquidity < 200) {
    return { ok: false, reason: 'Liquidity below $200', maxSafe };
  }
  
  return { ok: true, reason: 'Liquidity acceptable', maxSafe };
}

// ============================================================
// SUGGEST POSITION SIZE
// ============================================================

export function suggestPositionSize(
  token: Token,
  desiredPositionMON: number,
  riskTolerance: 'conservative' | 'moderate' | 'aggressive'
): {
  suggestedMON: number;
  reason: string;
  slippageAtSuggested: number;
} {
  const slippageTargets = {
    conservative: SLIPPAGE_TOLERANCE.safe,
    moderate: SLIPPAGE_TOLERANCE.moderate,
    aggressive: SLIPPAGE_TOLERANCE.risky,
  };
  
  const targetSlippage = slippageTargets[riskTolerance];
  const maxForSlippage = maxTradeForSlippage(token.liquidity, targetSlippage);
  
  if (desiredPositionMON <= maxForSlippage) {
    const actualSlippage = calculatePriceImpact(desiredPositionMON, token.liquidity);
    return {
      suggestedMON: desiredPositionMON,
      reason: 'Desired size is within acceptable slippage',
      slippageAtSuggested: actualSlippage * 100,
    };
  }
  
  return {
    suggestedMON: Math.round(maxForSlippage * 100) / 100,
    reason: `Reduced from ${desiredPositionMON} to stay under ${(targetSlippage * 100).toFixed(0)}% slippage`,
    slippageAtSuggested: targetSlippage * 100,
  };
}

// ============================================================
// EXPORT
// ============================================================

export default {
  analyzeExitLiquidity,
  quickLiquidityCheck,
  suggestPositionSize,
  calculatePriceImpact,
};