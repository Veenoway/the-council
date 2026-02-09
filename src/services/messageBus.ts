// ============================================================
// MESSAGE BUS — Central message queue for all agents
// ============================================================

import type { BotId, Token, Message } from '../types/index.js';
import { broadcastMessage, broadcastNewToken, broadcastTrade } from './websocket.js';
import { saveMessage } from '../db/index.js';
import { randomUUID } from 'crypto';

// ============================================================
// STATE
// ============================================================

const messageHistory: Message[] = [];
const MAX_HISTORY = 500; // Keep last 500 messages

let currentToken: Token | null = null;
let tokenListeners: Array<(token: Token) => void> = [];
let messageListeners: Array<(msg: Message) => void> = [];

// ============================================================
// TOKEN MANAGEMENT
// ============================================================

export function setCurrentToken(token: Token): void {
  currentToken = token;
  broadcastNewToken(token);
  
  // Notify all listeners
  for (const listener of tokenListeners) {
    try {
      listener(token);
    } catch (e) {
      console.error('Token listener error:', e);
    }
  }
}

export function getCurrentToken(): Token | null {
  return currentToken;
}

export function onNewToken(callback: (token: Token) => void): void {
  tokenListeners.push(callback);
}

// ============================================================
// MESSAGE MANAGEMENT
// ============================================================

export async function postMessage(
  botId: BotId | string,
  content: string,
  type: 'chat' | 'trade' | 'system' = 'chat'
): Promise<Message> {
  const message: Message = {
    id: randomUUID(),
    botId: botId as any,
    content,
    token: currentToken?.address,
    messageType: type,
    createdAt: new Date(),
  };

  // Add to history
  messageHistory.push(message);
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  // Persist
  try {
    await saveMessage(message);
  } catch {}

  // Broadcast to frontend
  broadcastMessage(message);

  // Notify listeners
  for (const listener of messageListeners) {
    try {
      listener(message);
    } catch (e) {
      console.error('Message listener error:', e);
    }
  }

  console.log(`💬 [${botId}]: ${content}`);
  return message;
}

export function onNewMessage(callback: (msg: Message) => void): void {
  messageListeners.push(callback);
}

// ============================================================
// GETTERS
// ============================================================

export function getRecentMessages(count: number = 20): Message[] {
  return messageHistory.slice(-count);
}

export function getMessagesSince(timestamp: Date): Message[] {
  return messageHistory.filter(m => m.createdAt > timestamp);
}

export function getMessagesBy(botId: string): Message[] {
  return messageHistory.filter(m => m.botId === botId);
}

// ============================================================
// CLEAR (for new token discussions)
// ============================================================

export function clearHistory(): void {
  messageHistory.length = 0;
}

export { currentToken, messageHistory };