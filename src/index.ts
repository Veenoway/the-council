import 'dotenv/config';
import { initDatabase, closeDatabase } from './db/index.js';
import { initWebSocket, closeWebSocket } from './services/websocket.js';
import { startOrchestrator } from './services/orchestrator.js';
import express from 'express';
import cors from 'cors';
import { getCurrentToken, getRecentMessages } from './services/messageBus.js';

const app = express();
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3005');
const WS_PORT = parseInt(process.env.WS_PORT || '8080');

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/current-token', (req, res) => {
  const token = getCurrentToken();
  const messages = getRecentMessages(50);
  
  res.json({
    token: token || null,
    messages: messages || [],
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   🏛️  THE COUNCIL                                         ║
  ║   ─────────────────────────────────────────────────────   ║
  ║   5 AI Traders. 1 Mission. Infinite Degen Energy.        ║
  ║                                                           ║
  ║   🎌 Sensei    │ Vibes & Community                        ║
  ║   🤓 Quantum   │ Stats & Analysis                         ║
  ║   🦍 Chad      │ Degen Hunter                             ║
  ║   🎩 Sterling  │ Risk & Due Diligence                     ║
  ║   👁️ Oracle    │ The Unknown                              ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  // Check required env vars
  const requiredEnvVars = ['XAI_API_KEY'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.log(`
Create a .env file with:

XAI_API_KEY=your_xai_api_key
DATABASE_URL=postgres://localhost:5432/council
MONAD_RPC_URL=https://rpc.monad.xyz
HTTP_PORT=3001
WS_PORT=8080
DEMO_MODE=true
    `);
    process.exit(1);
  }

  try {
    // Initialize database
    console.log('📦 Initializing database...');
    await initDatabase();

    // Start HTTP server for API
    app.listen(HTTP_PORT, () => {
      console.log(`🌐 HTTP API server running on port ${HTTP_PORT}`);
    });

    // Initialize WebSocket server
    console.log(`🔌 Starting WebSocket server on port ${WS_PORT}...`);
    initWebSocket(WS_PORT);

    // Start the orchestrator (main bot loop)
    console.log('🤖 Starting bot orchestrator...');
    await startOrchestrator();

  } catch (error) {
    console.error('❌ Fatal error:', error);
    await shutdown();
    process.exit(1);
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(): Promise<void> {
  console.log('\n🛑 Shutting down The Council...');
  
  closeWebSocket();
  await closeDatabase();
  
  console.log('👋 Goodbye.');
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

// ============================================================
// RUN
// ============================================================

main().catch(console.error);