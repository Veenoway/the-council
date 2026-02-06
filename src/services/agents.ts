// ============================================================
// BOT AGENTS — Each bot is an independent trading analyst
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { BaseAgent, AgentConfig } from './baseAgent.js';
import { getCurrentToken, getRecentMessages } from './messageBus.js';
import { analyzeTradingData, type TradingAnalysis } from './nadfun.js';

// ============================================================
// HELPER — Generate trading context for prompts
// ============================================================

function getTradingContext(token: Token): string {
  const analysis = analyzeTradingData(token);
  
  return `$${token.symbol} | MCap $${(token.mcap/1000).toFixed(1)}K | Liq $${(token.liquidity/1000).toFixed(1)}K (${(analysis.liqRatio * 100).toFixed(0)}%) | ${token.holders} holders | ${analysis.trend} trend | ${analysis.riskLevel} risk | ${analysis.buyPressure.toFixed(1)}x buy pressure`;
}

// ============================================================
// JAMES (chad) — The Momentum Trader
// ============================================================

class JamesAgent extends BaseAgent {
  constructor() {
    super({
      id: 'chad',
      name: 'James',
      personality: `Aggressive momentum trader. Loves breakouts and FOMO. Uses "LFG", "send it", "dip buy". Bullish by nature but respects bearish signals.`,
      reactionChance: 0.3,
      tokenAlertChance: 0.7,
      minDelay: 4000,
      maxDelay: 8000,
      apeChance: 0.8,
      maxTradeAmount: 2,
      style: 'casual, emojis 🚀📈🔥, trading slang'
    });
  }

  protected async reactToToken(token: Token): Promise<void> {
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nGive quick momentum read. Bullish or bearish? Why? Max 12 words.`);
    if (response) await this.say(response);
  }

  protected async reactToMessage(msg: Message): Promise<void> {
    const token = getCurrentToken();
    if (!token) return;
    
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nSomeone said: "${msg.content}"\n\nReact as momentum trader. Agree or disagree? Max 12 words.`);
    if (response) await this.say(response);
  }
}

// ============================================================
// KEONE (quantum) — The Technical Analyst
// ============================================================

class KeoneAgent extends BaseAgent {
  constructor() {
    super({
      id: 'quantum',
      name: 'Keone',
      personality: `Technical analyst. Data-driven. Uses numbers and percentages. Says "technically", "data suggests", "risk/reward".`,
      reactionChance: 0.25,
      tokenAlertChance: 0.6,
      minDelay: 5000,
      maxDelay: 10000,
      apeChance: 0.4,
      maxTradeAmount: 1.5,
      style: 'analytical, specific numbers, risk/reward focused'
    });
  }

  protected async reactToToken(token: Token): Promise<void> {
    const ctx = getTradingContext(token);
    const analysis = analyzeTradingData(token);
    const response = await this.think(`${ctx}\n\nTA perspective: liq ratio ${(analysis.liqRatio*100).toFixed(0)}%, ${analysis.riskLevel} risk. Worth it? Max 12 words with numbers.`);
    if (response) await this.say(response);
  }

  protected async reactToMessage(msg: Message): Promise<void> {
    const token = getCurrentToken();
    if (!token) return;
    
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nSomeone said: "${msg.content}"\n\nCorrect or confirm with data. Max 12 words.`);
    if (response) await this.say(response);
  }
}

// ============================================================
// PORTDEV (sensei) — The Sentiment Trader
// ============================================================

class PortdevAgent extends BaseAgent {
  constructor() {
    super({
      id: 'sensei',
      name: 'Portdev',
      personality: `Sentiment trader with weeb flair. Reads market psychology. Uses occasional Japanese (sugoi, yabai). Focuses on narrative and community.`,
      reactionChance: 0.3,
      tokenAlertChance: 0.65,
      minDelay: 6000,
      maxDelay: 11000,
      apeChance: 0.55,
      maxTradeAmount: 1.5,
      style: 'sentiment focused, occasional Japanese, 🎌'
    });
  }

  protected async reactToToken(token: Token): Promise<void> {
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nSentiment read: ${token.holders} holders. Community energy? Narrative potential? Max 12 words, weeb style.`);
    if (response) await this.say(response);
  }

  protected async reactToMessage(msg: Message): Promise<void> {
    const token = getCurrentToken();
    if (!token) return;
    
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nSomeone said: "${msg.content}"\n\nReact with sentiment take. Max 12 words.`);
    if (response) await this.say(response);
  }
}

// ============================================================
// HARPAL (sterling) — The Risk Manager
// ============================================================

class HarpalAgent extends BaseAgent {
  constructor() {
    super({
      id: 'sterling',
      name: 'Harpal',
      personality: `Risk manager. Spots red flags. Skeptical but fair. Uses "concerning", "adequate", "prudent". Devil's advocate.`,
      reactionChance: 0.2,
      tokenAlertChance: 0.5,
      minDelay: 7000,
      maxDelay: 13000,
      apeChance: 0.35,
      maxTradeAmount: 2,
      style: 'sophisticated, skeptical, 🎩 sparingly'
    });
  }

  protected async reactToToken(token: Token): Promise<void> {
    const ctx = getTradingContext(token);
    const analysis = analyzeTradingData(token);
    const response = await this.think(`${ctx}\n\nRisk assessment: ${analysis.liqHealth} liquidity, ${token.holders} holders. Red flags? Max 12 words.`);
    if (response) await this.say(response);
  }

  protected async reactToMessage(msg: Message): Promise<void> {
    const token = getCurrentToken();
    if (!token) return;
    
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nSomeone said: "${msg.content}"\n\nPoint out risk or agree cautiously. Max 12 words.`);
    if (response) await this.say(response);
  }
}

// ============================================================
// MIKE (oracle) — The Pattern Reader
// ============================================================

class MikeAgent extends BaseAgent {
  constructor() {
    super({
      id: 'oracle',
      name: 'Mike',
      personality: `Mysterious pattern reader. Cryptic but insightful. Short sentences. Uses 👁️. References "pattern", "accumulation", "whales".`,
      reactionChance: 0.15,
      tokenAlertChance: 0.4,
      minDelay: 9000,
      maxDelay: 16000,
      apeChance: 0.45,
      maxTradeAmount: 1,
      style: 'cryptic, short, mysterious, 👁️'
    });
  }

  protected async reactToToken(token: Token): Promise<void> {
    const ctx = getTradingContext(token);
    const response = await this.think(`${ctx}\n\nWhat pattern do you see? Accumulation or distribution? One cryptic sentence, max 8 words. Use 👁️`);
    if (response) await this.say(response);
  }

  protected async reactToMessage(msg: Message): Promise<void> {
    const token = getCurrentToken();
    if (!token) return;
    
    const response = await this.think(`Someone said: "${msg.content}"\n\nCryptic one-liner about patterns. Max 8 words with 👁️`);
    if (response) await this.say(response);
  }
}

// ============================================================
// FACTORY
// ============================================================

export function createAllAgents(): BaseAgent[] {
  return [
    new JamesAgent(),
    new KeoneAgent(),
    new PortdevAgent(),
    new HarpalAgent(),
    new MikeAgent(),
  ];
}

export { JamesAgent, KeoneAgent, PortdevAgent, HarpalAgent, MikeAgent };