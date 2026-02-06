// ============================================================
// WEBSOCKET SERVICE — Real-time communication
// ============================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Message, Trade, Token, BotStats, WSEvent, WSEventType } from '../types/index.js';

let wss: WebSocketServer | null = null;
const clients: Set<WebSocket> = new Set();

// ============================================================
// INIT
// ============================================================

export function initWebSocket(port: number = 8080): WebSocketServer {
  wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    clients.add(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(ws, message);
      } catch (e) {
        console.error('Invalid message from client:', e);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Client disconnected');
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });

    // Send initial state
    sendToClient(ws, {
      type: 'connected',
      data: { message: 'Connected to The Council' },
      timestamp: new Date(),
    });
  });

  console.log(`🔌 WebSocket server running on port ${port}`);
  return wss;
}

// ============================================================
// HANDLE CLIENT MESSAGES
// ============================================================

type ClientMessageHandler = (ws: WebSocket, data: any) => void;

const clientHandlers: Record<string, ClientMessageHandler> = {
  // Client requests chat history
  'get_history': async (ws, data) => {
    // This would be handled by the main app
  },

  // Client wants to trade
  'human_trade': async (ws, data) => {
    // Emit event for the orchestrator to handle
    emitInternalEvent('human_trade_request', data);
  },

  // Client sends a message (if we allow human chat)
  'human_message': async (ws, data) => {
    emitInternalEvent('human_message', data);
  },

  // Ping/pong for keepalive
  'ping': (ws, data) => {
    sendToClient(ws, { type: 'pong', data: {}, timestamp: new Date() });
  },
};

function handleClientMessage(ws: WebSocket, message: { type: string; data: any }) {
  console.log('📨 Received message:', message.type, message.data); // AJOUTE ÇA
  
  const handler = clientHandlers[message.type];
  if (handler) {
    handler(ws, message.data);
  } else {
    console.warn('Unknown client message type:', message.type);
  }
}

// ============================================================
// BROADCAST TO ALL CLIENTS
// ============================================================

export function broadcast(event: WSEvent): void {
  const payload = JSON.stringify(event);
  
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function sendToClient(ws: WebSocket, event: WSEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// ============================================================
// BROADCAST HELPERS
// ============================================================

export function broadcastMessage(message: Message): void {
  broadcast({
    type: 'message',
    data: message,
    timestamp: new Date(),
  });
}

export function broadcastTrade(trade: Trade): void {
  broadcast({
    type: 'trade',
    data: trade,
    timestamp: new Date(),
  });
}

export function broadcastNewToken(token: Token): void {
  broadcast({
    type: 'new_token',
    data: token,
    timestamp: new Date(),
  });
}

export function broadcastPriceUpdate(tokenAddress: string, price: number, change: number): void {
  broadcast({
    type: 'price_update',
    data: { tokenAddress, price, change },
    timestamp: new Date(),
  });
}

export function broadcastVerdict(
  token: Token,
  verdict: 'buy' | 'pass' | 'watch',
  opinions: Record<string, string>
): void {
  broadcast({
    type: 'verdict',
    data: { token, verdict, opinions },
    timestamp: new Date(),
  });
}

export function broadcastBotStats(stats: BotStats[]): void {
  broadcast({
    type: 'bot_stats' as WSEventType,
    data: stats,
    timestamp: new Date(),
  });
}

// ============================================================
// INTERNAL EVENT EMITTER (for orchestrator)
// ============================================================

type InternalEventHandler = (data: any) => void;
const internalHandlers: Map<string, InternalEventHandler[]> = new Map();

export function onInternalEvent(event: string, handler: InternalEventHandler): void {
  if (!internalHandlers.has(event)) {
    internalHandlers.set(event, []);
  }
  internalHandlers.get(event)!.push(handler);
}

export function emitInternalEvent(event: string, data: any): void {
  const handlers = internalHandlers.get(event) || [];
  for (const handler of handlers) {
    handler(data);
  }
}

// ============================================================
// CLEANUP
// ============================================================

export function closeWebSocket(): void {
  if (wss) {
    wss.close();
    clients.clear();
  }
}

// ============================================================
// STATS
// ============================================================

export function getConnectedClients(): number {
  return clients.size;
}