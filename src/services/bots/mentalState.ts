// ============================================================
// BOT MENTAL STATE — Fatigue, Confidence, Risk Budget
// ============================================================

import type { BotId } from '../../types/index.js';
import { prisma } from '../../db/index.js';

// ============================================================
// TYPES
// ============================================================

export interface BotMentalState {
  botId: BotId;
  
  // Risk Budget - diminue avec les trades, se reset chaque jour
  dailyRiskBudget: number;      // 0-100, démarre à 100
  usedRiskToday: number;        // Combien de risque pris aujourd'hui
  
  // Confidence - basée sur les récents trades
  confidence: number;           // 0-100
  winStreak: number;            // Nombre de wins consécutifs
  lossStreak: number;           // Nombre de losses consécutifs
  
  // Fatigue mentale - augmente avec les trades
  mentalFatigue: number;        // 0-100, augmente avec chaque trade
  tradesThisSession: number;    // Nombre de trades cette session
  
  // Emotional state
  lastTradeResult: 'win' | 'loss' | 'none';
  lastTradePnl: number;
  emotionalBias: number;        // -20 à +20, influence le jugement
  
  // Timestamps
  lastTradeAt: Date | null;
  sessionStartAt: Date;
  lastResetAt: Date;
}

// ============================================================
// STATE STORAGE
// ============================================================

const mentalStates: Map<BotId, BotMentalState> = new Map();

const DEFAULT_STATE: Omit<BotMentalState, 'botId'> = {
  dailyRiskBudget: 100,
  usedRiskToday: 0,
  confidence: 60,
  winStreak: 0,
  lossStreak: 0,
  mentalFatigue: 0,
  tradesThisSession: 0,
  lastTradeResult: 'none',
  lastTradePnl: 0,
  emotionalBias: 0,
  lastTradeAt: null,
  sessionStartAt: new Date(),
  lastResetAt: new Date(),
};

// ============================================================
// INIT & GET STATE
// ============================================================

export function initBotMentalState(botId: BotId): BotMentalState {
  const state: BotMentalState = {
    botId,
    ...DEFAULT_STATE,
    sessionStartAt: new Date(),
    lastResetAt: new Date(),
  };
  mentalStates.set(botId, state);
  return state;
}

export function getBotMentalState(botId: BotId): BotMentalState {
  let state = mentalStates.get(botId);
  if (!state) {
    state = initBotMentalState(botId);
  }
  
  // Check if we need to reset daily budget
  const now = new Date();
  const lastReset = state.lastResetAt;
  if (now.getDate() !== lastReset.getDate()) {
    state.dailyRiskBudget = 100;
    state.usedRiskToday = 0;
    state.mentalFatigue = Math.max(0, state.mentalFatigue - 30); // Partial fatigue recovery overnight
    state.lastResetAt = now;
  }
  
  return state;
}

// ============================================================
// UPDATE STATE AFTER TRADE
// ============================================================

export function recordTradeResult(
  botId: BotId, 
  result: 'win' | 'loss', 
  pnl: number,
  riskTaken: number // 0-100 based on position size relative to budget
): void {
  const state = getBotMentalState(botId);
  
  // Update streaks
  if (result === 'win') {
    state.winStreak++;
    state.lossStreak = 0;
    // Confidence boost (diminishing returns)
    state.confidence = Math.min(95, state.confidence + Math.max(2, 10 - state.winStreak));
  } else {
    state.lossStreak++;
    state.winStreak = 0;
    // Confidence hit (compounds with streak)
    state.confidence = Math.max(20, state.confidence - (5 + state.lossStreak * 2));
  }
  
  // Update risk budget
  state.usedRiskToday += riskTaken;
  state.dailyRiskBudget = Math.max(0, 100 - state.usedRiskToday);
  
  // Update fatigue
  state.tradesThisSession++;
  state.mentalFatigue = Math.min(100, state.mentalFatigue + 5 + (state.tradesThisSession * 2));
  
  // Update emotional bias
  if (result === 'win' && pnl > 0) {
    // After a win, slight overconfidence
    state.emotionalBias = Math.min(20, state.emotionalBias + Math.min(10, pnl * 2));
  } else if (result === 'loss') {
    // After a loss, fear/caution
    state.emotionalBias = Math.max(-20, state.emotionalBias - Math.min(15, Math.abs(pnl) * 3));
  }
  
  // Decay emotional bias over time
  if (state.lastTradeAt) {
    const hoursSinceLastTrade = (Date.now() - state.lastTradeAt.getTime()) / (1000 * 60 * 60);
    state.emotionalBias *= Math.max(0.5, 1 - (hoursSinceLastTrade * 0.1));
  }
  
  state.lastTradeResult = result;
  state.lastTradePnl = pnl;
  state.lastTradeAt = new Date();
  
  mentalStates.set(botId, state);
}

// ============================================================
// CALCULATE MENTAL MODIFIERS
// ============================================================

export interface MentalModifiers {
  thresholdModifier: number;    // Ajuste bullish/bearish threshold
  positionSizeModifier: number; // Multiplie la taille de position (0.5 - 1.5)
  shouldSkip: boolean;          // Le bot devrait-il passer son tour?
  skipReason?: string;
  mentalNote: string;           // Pour le chat - ce que le bot "ressent"
}

export function calculateMentalModifiers(botId: BotId): MentalModifiers {
  const state = getBotMentalState(botId);
  
  let thresholdModifier = 0;
  let positionSizeModifier = 1;
  let shouldSkip = false;
  let skipReason: string | undefined;
  const mentalNotes: string[] = [];
  
  // === FATIGUE CHECK ===
  if (state.mentalFatigue > 80) {
    shouldSkip = true;
    skipReason = 'mental fatigue - need a break';
    mentalNotes.push('exhausted from trading');
  } else if (state.mentalFatigue > 60) {
    thresholdModifier += 10; // Plus conservateur
    positionSizeModifier *= 0.7;
    mentalNotes.push('getting tired');
  } else if (state.mentalFatigue > 40) {
    thresholdModifier += 5;
    mentalNotes.push('slightly fatigued');
  }
  
  // === RISK BUDGET CHECK ===
  if (state.dailyRiskBudget < 10) {
    shouldSkip = true;
    skipReason = 'daily risk budget depleted';
    mentalNotes.push('hit my limit for today');
  } else if (state.dailyRiskBudget < 30) {
    thresholdModifier += 15;
    positionSizeModifier *= 0.5;
    mentalNotes.push('low on risk budget');
  } else if (state.dailyRiskBudget < 50) {
    thresholdModifier += 8;
    positionSizeModifier *= 0.8;
  }
  
  // === LOSS STREAK ===
  if (state.lossStreak >= 3) {
    thresholdModifier += 20; // Beaucoup plus conservateur
    positionSizeModifier *= 0.4;
    mentalNotes.push(`on a ${state.lossStreak} loss streak - being careful`);
  } else if (state.lossStreak >= 2) {
    thresholdModifier += 10;
    positionSizeModifier *= 0.7;
    mentalNotes.push('recent losses weighing on me');
  }
  
  // === WIN STREAK ===
  if (state.winStreak >= 5) {
    // Trop confiant = dangereux
    thresholdModifier -= 5; // Légèrement moins conservateur
    positionSizeModifier *= 1.2;
    mentalNotes.push(`${state.winStreak} wins in a row - feeling good but staying grounded`);
  } else if (state.winStreak >= 3) {
    thresholdModifier -= 3;
    positionSizeModifier *= 1.1;
    mentalNotes.push('on a nice streak');
  }
  
  // === EMOTIONAL BIAS ===
  if (state.emotionalBias > 10) {
    // Trop bullish après gains
    thresholdModifier -= 5;
    mentalNotes.push('feeling optimistic');
  } else if (state.emotionalBias < -10) {
    // Trop bearish après pertes
    thresholdModifier += 8;
    mentalNotes.push('feeling cautious after losses');
  }
  
  // === CONFIDENCE ===
  if (state.confidence < 30) {
    thresholdModifier += 15;
    positionSizeModifier *= 0.5;
    mentalNotes.push('confidence is low');
  } else if (state.confidence > 80) {
    thresholdModifier -= 5;
    positionSizeModifier *= 1.15;
  }
  
  // === RECENT BIG LOSS ===
  if (state.lastTradeResult === 'loss' && state.lastTradePnl < -2) {
    const hoursSince = state.lastTradeAt 
      ? (Date.now() - state.lastTradeAt.getTime()) / (1000 * 60 * 60)
      : 24;
    
    if (hoursSince < 1) {
      thresholdModifier += 15;
      positionSizeModifier *= 0.5;
      mentalNotes.push('still recovering from that last loss');
    }
  }
  
  // Clamp modifiers
  positionSizeModifier = Math.max(0.3, Math.min(1.5, positionSizeModifier));
  
  return {
    thresholdModifier,
    positionSizeModifier,
    shouldSkip,
    skipReason,
    mentalNote: mentalNotes.length > 0 ? mentalNotes[0] : '',
  };
}

// ============================================================
// PERSONALITY-SPECIFIC MENTAL TRAITS
// ============================================================

export function getPersonalityTraits(botId: BotId): {
  baseFatigueResistance: number;  // 0-1, higher = less affected by fatigue
  riskTolerance: number;          // 0-1, higher = takes more risk
  emotionalStability: number;     // 0-1, higher = less affected by wins/losses
  fomoProne: number;              // 0-1, higher = more likely to chase
} {
  const traits: Record<BotId, any> = {
    chad: {
      baseFatigueResistance: 0.8,   // Can trade all day
      riskTolerance: 0.9,           // High risk appetite
      emotionalStability: 0.3,      // Very emotional
      fomoProne: 0.9,               // Major FOMO
    },
    quantum: {
      baseFatigueResistance: 0.6,
      riskTolerance: 0.5,           // Calculated
      emotionalStability: 0.9,      // Very stable
      fomoProne: 0.2,               // Data-driven, not emotional
    },
    sensei: {
      baseFatigueResistance: 0.7,
      riskTolerance: 0.6,
      emotionalStability: 0.8,      // Zen
      fomoProne: 0.3,               // Patient
    },
    sterling: {
      baseFatigueResistance: 0.5,   // Gets tired of taking risk
      riskTolerance: 0.3,           // Very conservative
      emotionalStability: 0.7,
      fomoProne: 0.1,               // Never FOMOs
    },
    oracle: {
      baseFatigueResistance: 0.6,
      riskTolerance: 0.5,
      emotionalStability: 0.6,      // Mysterious
      fomoProne: 0.4,               // Follows the signs
    },
  };
  
  return traits[botId] || traits.quantum;
}

// ============================================================
// APPLY PERSONALITY TO MODIFIERS
// ============================================================

export function applyPersonalityToModifiers(
  botId: BotId, 
  modifiers: MentalModifiers
): MentalModifiers {
  const traits = getPersonalityTraits(botId);
  const state = getBotMentalState(botId);
  
  // Adjust threshold modifier based on personality
  let adjustedThreshold = modifiers.thresholdModifier;
  
  // Risk tolerance affects how much the threshold is raised
  adjustedThreshold *= (1 - traits.riskTolerance * 0.5);
  
  // Emotional stability dampens emotional effects
  if (state.emotionalBias !== 0) {
    const emotionalEffect = state.emotionalBias * (1 - traits.emotionalStability);
    adjustedThreshold -= emotionalEffect * 0.5;
  }
  
  // Fatigue resistance
  if (state.mentalFatigue > 50) {
    const fatigueEffect = (state.mentalFatigue - 50) * (1 - traits.baseFatigueResistance);
    adjustedThreshold += fatigueEffect * 0.2;
  }
  
  // Position size based on risk tolerance
  let adjustedPositionSize = modifiers.positionSizeModifier;
  adjustedPositionSize *= (0.7 + traits.riskTolerance * 0.6);
  
  return {
    ...modifiers,
    thresholdModifier: Math.round(adjustedThreshold),
    positionSizeModifier: Math.max(0.3, Math.min(1.5, adjustedPositionSize)),
  };
}

// ============================================================
// LOAD FROM DB (for persistence)
// ============================================================

export async function loadMentalStatesFromDB(): Promise<void> {
  try {
    const botStats = await prisma.botStats.findMany();
    
    for (const stats of botStats) {
      const botId = stats.botId as BotId;
      const state = getBotMentalState(botId);
      
      // Initialize confidence based on historical win rate
      state.confidence = Math.min(90, Math.max(30, 40 + stats.winRate * 0.5));
      state.winStreak = stats.currentStreak > 0 ? stats.currentStreak : 0;
      state.lossStreak = stats.currentStreak < 0 ? Math.abs(stats.currentStreak) : 0;
      
      mentalStates.set(botId, state);
    }
    
    console.log('✅ Loaded mental states from DB');
  } catch (error) {
    console.error('Failed to load mental states:', error);
  }
}

// ============================================================
// GET STATE SUMMARY FOR CHAT
// ============================================================

export function getMentalStateSummary(botId: BotId): string {
  const state = getBotMentalState(botId);
  const modifiers = calculateMentalModifiers(botId);
  
  const parts: string[] = [];
  
  if (state.winStreak >= 3) parts.push(`${state.winStreak}W streak`);
  if (state.lossStreak >= 2) parts.push(`${state.lossStreak}L streak`);
  if (state.confidence < 40) parts.push('low confidence');
  if (state.confidence > 80) parts.push('high confidence');
  if (state.mentalFatigue > 60) parts.push('fatigued');
  if (state.dailyRiskBudget < 30) parts.push('low risk budget');
  
  return parts.length > 0 ? parts.join(', ') : 'fresh';
}

export { mentalStates };