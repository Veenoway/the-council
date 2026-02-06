// ============================================================
// BASE AGENT — Abstract class for all bot agents
// ============================================================

import type { BotId, Token, Message, Trade } from '../types/index.js';
import { 
  postMessage, 
  getRecentMessages, 
  getCurrentToken,
  onNewToken,
  onNewMessage 
} from './messageBus.js';
import { executeBotTrade, getBotBalance } from './trading.js';
import { broadcastTrade } from './websocket.js';
import { saveTrade } from '../db/index.js';
import { recordBuy } from './positions.js';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';

// ============================================================
// GROK CLIENT
// ============================================================

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || '',
  baseURL: 'https://api.x.ai/v1',
});

// ============================================================
// GLOBAL STATE — Controlled by orchestrator
// ============================================================

let discussionActive = false;
let currentDiscussionToken: string | null = null;

export function setDiscussionActive(active: boolean, tokenAddress?: string): void {
  discussionActive = active;
  currentDiscussionToken = tokenAddress || null;
  if (!active) {
    currentDiscussionToken = null;
  }
}

export function isDiscussionActive(): boolean {
  return discussionActive;
}

// ============================================================
// AGENT CONFIG
// ============================================================

export interface AgentConfig {
  id: BotId;
  name: string;
  personality: string;
  reactionChance: number;
  tokenAlertChance: number;
  minDelay: number;
  maxDelay: number;
  apeChance: number;
  maxTradeAmount: number;
  style: string;
}

// ============================================================
// BASE AGENT CLASS
// ============================================================

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected isThinking: boolean = false;
  protected lastMessageTime: number = 0;
  protected messageCountThisToken: number = 0;
  protected tradeHistory: Array<{ token: string; amount: number; price: number; timestamp: Date }> = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.setupListeners();
    console.log(`🤖 Agent ${config.name} initialized`);
  }

  public getConfig(): AgentConfig {
    return this.config;
  }

  // Reset when new token starts
  public resetForNewToken(): void {
    this.messageCountThisToken = 0;
    this.isThinking = false;
  }

  // ============================================================
  // LISTENERS
  // ============================================================

  protected setupListeners(): void {
    onNewToken((token) => this.handleNewToken(token));
    onNewMessage((msg) => this.handleNewMessage(msg));
  }

  protected async handleNewToken(token: Token): Promise<void> {
    // Reset message count for new token
    this.messageCountThisToken = 0;
    
    // Only react if discussion is active
    if (!discussionActive) return;
    if (currentDiscussionToken && currentDiscussionToken !== token.address) return;
    
    // Roll dice
    if (Math.random() > this.config.tokenAlertChance) return;
    if (this.isThinking) return;

    const delay = this.config.minDelay + Math.random() * (this.config.maxDelay - this.config.minDelay);
    await this.sleep(delay);

    // Check again after delay
    if (!discussionActive) return;

    await this.reactToToken(token);
  }

  protected async handleNewMessage(msg: Message): Promise<void> {
    // Don't react to own messages
    if (msg.botId === this.config.id) return;
    // Don't react to system messages
    if (msg.messageType === 'system') return;
    // Only react if discussion is active
    if (!discussionActive) return;
    // Already thinking
    if (this.isThinking) return;
    
    // LIMIT: Max 2 messages per token per bot
    if (this.messageCountThisToken >= 2) return;
    
    // Roll dice - lower chance to react to messages
    if (Math.random() > this.config.reactionChance * 0.5) return;
    
    // Minimum 10 seconds between messages
    const timeSinceLastMsg = Date.now() - this.lastMessageTime;
    if (timeSinceLastMsg < 10000) return;

    // Add delay
    const delay = this.config.minDelay + Math.random() * (this.config.maxDelay - this.config.minDelay);
    await this.sleep(delay);

    // Check again after delay
    if (!discussionActive) return;
    if (this.messageCountThisToken >= 2) return;

    await this.reactToMessage(msg);
  }

  // ============================================================
  // CORE METHODS - Override in subclasses
  // ============================================================

  protected abstract reactToToken(token: Token): Promise<void>;
  protected abstract reactToMessage(msg: Message): Promise<void>;

  // ============================================================
  // GENERATE RESPONSE
  // ============================================================

  protected async think(context: string): Promise<string | null> {
    if (this.isThinking) return null;
    if (!discussionActive) return null;
    
    this.isThinking = true;

    try {
      const recentMsgs = getRecentMessages(15);
      
      const botIdToName: Record<string, string> = {
        'chad': 'James',
        'quantum': 'Keone',
        'sensei': 'Portdev',
        'sterling': 'Harpal',
        'oracle': 'Mike',
      };
      
      const chatContext = recentMsgs
        .slice(-10)
        .map(m => {
          const name = botIdToName[m.botId] || m.botId;
          return `${name}: ${m.content}`;
        })
        .join('\n');

      // Check what I already said - avoid repeating
      const myRecentMessages = recentMsgs
        .filter(m => m.botId === this.config.id)
        .slice(-3)
        .map(m => m.content.toLowerCase());

      const token = getCurrentToken();
      const tokenContext = token 
        ? `$${token.symbol} | MCap: $${(token.mcap/1000).toFixed(1)}K | Liq: $${(token.liquidity/1000).toFixed(1)}K | Holders: ${token.holders}`
        : '';

      const prompt = `You are ${this.config.name} in a crypto trading group.

PERSONALITY: ${this.config.personality}
STYLE: ${this.config.style}

TOKEN: ${tokenContext}

RECENT CHAT:
${chatContext || '(empty)'}

CONTEXT: ${context}

RULES:
- MAX 12 words. Be concise.
- Sound natural, like texting
- lowercase unless emphasis needed
- NO "yo [name]" prefix - just respond directly
- Don't repeat what others said
- Don't repeat yourself
${myRecentMessages.length > 0 ? `- You already said similar to: "${myRecentMessages[0]?.slice(0, 50)}" - say something DIFFERENT` : ''}

Your response (MAX 12 words):`;

      const response = await grok.chat.completions.create({
        model: 'grok-3-latest',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 40,
        temperature: 1.1,
        presence_penalty: 1.0,
        frequency_penalty: 1.0,
      });

      let text = response.choices[0]?.message?.content?.trim() || null;
      
      if (text) {
        // Clean up response
        text = text.replace(/^(yo\s+)?(chad|quantum|sensei|sterling|oracle|portdev|keone|james|harpal|mike)[,:]?\s*/i, '');
        text = text.replace(/^["']|["']$/g, '');
        text = text.replace(/\*[^*]+\*/g, '').trim();
        
        // Check if too similar to recent messages
        const textLower = text.toLowerCase();
        for (const prev of myRecentMessages) {
          if (prev && textLower.includes(prev.slice(0, 20))) {
            return null; // Too similar, skip
          }
        }
      }

      return text;

    } catch (error) {
      console.error(`${this.config.name} think error:`, error);
      return null;
    } finally {
      this.isThinking = false;
    }
  }

  // ============================================================
  // ACTIONS
  // ============================================================

  protected async say(content: string): Promise<void> {
    if (!discussionActive) return;
    if (this.messageCountThisToken >= 2) return;
    
    await postMessage(this.config.id as BotId, content);
    this.lastMessageTime = Date.now();
    this.messageCountThisToken++;
  }

  public async executeTrade(token: Token): Promise<void> {
    if (!token) return;

    const ENABLE_REAL_TRADES = process.env.ENABLE_TRADES === 'true';
    
    if (ENABLE_REAL_TRADES) {
      const balance = await getBotBalance(this.config.id);
      const amount = Math.min(balance * 0.15, this.config.maxTradeAmount);
      
      if (amount >= 0.1) {
        const trade = await executeBotTrade(this.config.id, token, amount, 'buy');
        if (trade?.status === 'confirmed') {
          try {
            await saveTrade(trade);
            await recordBuy(
              this.config.id,
              token.address,
              token.symbol,
              amount,
              trade.amountOut,
              token.price
            );
          } catch (e) {
            console.error('Failed to save trade:', e);
          }
          
          broadcastTrade(trade);
          this.tradeHistory.push({
            token: token.symbol,
            amount,
            price: token.price,
            timestamp: new Date()
          });
        }
      }
    } else {
      // Demo mode
      const amountMon = 0.5;
      const tokenAmount = amountMon / token.price;
      
      const fakeTrade: Trade = {
        id: randomUUID(),
        botId: this.config.id,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        side: 'buy',
        amountIn: amountMon,
        amountOut: tokenAmount,
        price: token.price,
        txHash: '0x' + Math.random().toString(16).slice(2, 14) + '...',
        status: 'confirmed',
        createdAt: new Date(),
      };
      
      try {
        await saveTrade(fakeTrade);
        await recordBuy(
          this.config.id,
          token.address,
          token.symbol,
          amountMon,
          tokenAmount,
          token.price
        );
      } catch (e) {
        console.error('Failed to save trade:', e);
      }
      
      broadcastTrade(fakeTrade);
    }
  }

  // ============================================================
  // UTILS
  // ============================================================

  protected sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}