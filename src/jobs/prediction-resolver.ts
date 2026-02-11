// ============================================================
// PREDICTIONS RESOLVER — Cron Job for The Council
// ============================================================
// Run every minute: */1 * * * * node predictions-resolver.js
// ============================================================

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains'; // ou ta custom chain
import { prisma } from '../db/index.js';


// Config
const RPC_URL = process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY as `0x${string}`;
const PREDICTIONS_CONTRACT ="0xc73E9673BE659dDDA9335794323336ee02B02f14";



// Clients
const publicClient = createPublicClient({
  chain: monad,
  transport: http(RPC_URL),
});

const account = privateKeyToAccount(PRIVATE_KEY);

const walletClient = createWalletClient({
  account,
  chain: monad,
  transport: http(RPC_URL),
});

// ABI
const PREDICTIONS_ABI = parseAbi([
  'function resolvePrediction(uint256 _predictionId, uint8 _winningOption) external',
  'function predictions(uint256) view returns (uint256 id, address tokenAddress, string question, uint256 endTime, uint256 resolveTime, uint256 prizePool, uint256 totalBets, uint8 numOptions, uint8 winningOption, bool resolved, bool cancelled, address creator)',
  'function predictionCount() view returns (uint256)',
]);

// Types
interface Prediction {
  id: string;
  onchainId: number;
  type: 'PRICE' | 'BOT_ROI' | 'VOLUME' | 'CUSTOM';
  tokenAddress: string;
  targetValue: number | null;
  startValue: number | null;
  endTime: Date;
  resolved: boolean;
  metadata: any;
}

interface BotStats {
  botId: string;
  roi: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  winRate?: number;
  totalTrades?: number;
}

// ============================================================
// MAIN RESOLVER
// ============================================================

export async function resolvePredictions() {
  console.log(`[${new Date().toISOString()}] 🔍 Checking for predictions to resolve...`);

  try {
    // Get predictions that need resolution
    const pendingPredictions = await prisma.prediction.findMany({
      where: {
        resolved: false,
        cancelled: false,
        endTime: {
          lte: new Date(),
        },
      },
    });

    console.log(`Found ${pendingPredictions.length} predictions to resolve`);

    for (const prediction of pendingPredictions) {
      try {
        console.log(`\n📊 Resolving prediction #${prediction.onchainId}: ${prediction.question}`);

        // Determine winner based on prediction type
        const winningOption = await determineWinner(prediction as Prediction);

        if (winningOption === 0) {
          console.log(`⚠️ Could not determine winner for prediction #${prediction.onchainId}`);
          continue;
        }

        console.log(`🏆 Winner: Option ${winningOption}`);

        // Call smart contract to resolve
        const hash = await walletClient.writeContract({
          address: PREDICTIONS_CONTRACT,
          abi: PREDICTIONS_ABI,
          functionName: 'resolvePrediction',
          args: [BigInt(prediction.onchainId), winningOption],
        });

        console.log(`📝 Transaction sent: ${hash}`);

        // Wait for confirmation
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`✅ Resolved in block ${receipt.blockNumber}`);

        // Update database
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            resolved: true,
            winningOption,
            resolvedAt: new Date(),
            resolveTxHash: hash,
          },
        });

        console.log(`💾 Database updated`);

      } catch (error) {
        console.error(`❌ Error resolving prediction #${prediction.onchainId}:`, error);
      }
    }

  } catch (error) {
    console.error('❌ Resolver error:', error);
  }
}

// ============================================================
// WINNER DETERMINATION
// ============================================================

async function determineWinner(prediction: Prediction): Promise<number> {
  switch (prediction.type) {
    case 'PRICE':
      return await resolvePricePrediction(prediction);
    case 'BOT_ROI':
      return await resolveBotROIPrediction(prediction);
    case 'VOLUME':
      return await resolveVolumePrediction(prediction);
    case 'CUSTOM':
      // Custom predictions need manual resolution
      return 0;
    default:
      return 0;
  }
}

/**
 * Resolve price prediction (e.g., "Will $CHOG pump 50%?")
 */
async function resolvePricePrediction(prediction: Prediction): Promise<number> {
  if (!prediction.targetValue || !prediction.tokenAddress) return 0;

  try {
    const response = await fetch(
      `${process.env.NADFUN_API_URL}/token/${prediction.tokenAddress}`
    );
    
    if (!response.ok) return 0;
    
    const data = await response.json();
    const currentPrice = data.price || data.token_info?.price || 0;

    const startPrice = prediction.startValue || prediction.metadata?.startPrice || 0;
    if (startPrice === 0) return 0;

    const priceChange = ((currentPrice - startPrice) / startPrice) * 100;
    const targetChange = ((prediction.targetValue - startPrice) / startPrice) * 100;

    console.log(`  Start: ${startPrice}, Current: ${currentPrice}, Target: ${prediction.targetValue}`);
    console.log(`  Change: ${priceChange.toFixed(2)}%, Target change: ${targetChange.toFixed(2)}%`);

    // Option 1 = YES (reached target), Option 2 = NO
    return priceChange >= targetChange ? 1 : 2;

  } catch (error) {
    console.error('Error fetching price:', error);
    return 0;
  }
}


async function resolveBotROIPrediction(prediction: Prediction): Promise<number> {
  try {
    const response = await fetch(`${process.env.API_URL}/api/bots`);
    if (!response.ok) return 0;

    const data = await response.json();
    const bots: any[] = data.bots || [];

    if (bots.length === 0) return 0;

    // Sort by ROI, then by tiebreakers
    const sorted = [...bots].sort((a, b) => {
      // Primary: ROI
      if (b.roi !== a.roi) return b.roi - a.roi;
      
      // Tiebreaker 1: Total profit
      const profitA = (a.realizedPnl || 0) + (a.unrealizedPnl || 0);
      const profitB = (b.realizedPnl || 0) + (b.unrealizedPnl || 0);
      if (profitB !== profitA) return profitB - profitA;
      
      // Tiebreaker 2: Win rate
      if ((b.winRate || 0) !== (a.winRate || 0)) return (b.winRate || 0) - (a.winRate || 0);
      
      // Tiebreaker 3: Total trades
      return (b.totalTrades || 0) - (a.totalTrades || 0);
    });

    const winner = sorted[0];
    const runnerUp = sorted[1];

    // Check if there's still a perfect tie after all tiebreakers
    const isPerfectTie = runnerUp && 
      winner.roi === runnerUp.roi &&
      ((winner.realizedPnl || 0) + (winner.unrealizedPnl || 0)) === ((runnerUp.realizedPnl || 0) + (runnerUp.unrealizedPnl || 0)) &&
      (winner.winRate || 0) === (runnerUp.winRate || 0) &&
      (winner.totalTrades || 0) === (runnerUp.totalTrades || 0);

    if (isPerfectTie) {
      console.log(`  ⚠️ Perfect tie between ${winner.botId} and ${runnerUp.botId}!`);
      // Store tied bots in metadata for potential split payout
      await prisma.prediction.update({
        where: { id: prediction.id },
        data: {
          metadata: {
            ...prediction.metadata,
            tiedBots: sorted.filter(b => b.roi === winner.roi).map(b => b.botId),
            isTie: true,
          },
        },
      });
    }

    const botToOption: Record<string, number> = {
      'chad': 1,
      'quantum': 2,
      'sensei': 3,
      'sterling': 4,
      'oracle': 5,
    };

    console.log(`  🏆 Winner: ${winner.botId} with ROI: ${winner.roi.toFixed(2)}%`);
    if (runnerUp) {
      console.log(`  🥈 Runner-up: ${runnerUp.botId} with ROI: ${runnerUp.roi.toFixed(2)}%`);
    }

    return botToOption[winner.botId] || 0;

  } catch (error) {
    console.error('Error fetching bot stats:', error);
    return 0;
  }
}

/**
 * Resolve volume prediction
 */
async function resolveVolumePrediction(prediction: Prediction): Promise<number> {
  if (!prediction.targetValue || !prediction.tokenAddress) return 0;

  try {
    const response = await fetch(
      `${process.env.NADFUN_API_URL}/token/${prediction.tokenAddress}`
    );
    
    if (!response.ok) return 0;
    
    const data = await response.json();
    const volume24h = data.volume_24h || 0;

    console.log(`  24h Volume: ${volume24h}, Target: ${prediction.targetValue}`);

    return volume24h >= prediction.targetValue ? 1 : 2;

  } catch (error) {
    console.error('Error fetching volume:', error);
    return 0;
  }
}

// ============================================================
// SYNC ONCHAIN STATE
// ============================================================

export async function syncOnchainPredictions() {
  console.log(`[${new Date().toISOString()}] 🔄 Syncing onchain predictions...`);

  try {
    const count = await publicClient.readContract({
      address: PREDICTIONS_CONTRACT,
      abi: PREDICTIONS_ABI,
      functionName: 'predictionCount',
    });

    console.log(`Total onchain predictions: ${count}`);

    for (let i = 1; i <= Number(count); i++) {
      const onchain = await publicClient.readContract({
        address: PREDICTIONS_CONTRACT,
        abi: PREDICTIONS_ABI,
        functionName: 'predictions',
        args: [BigInt(i)],
      });

      // onchain is a tuple: [id, tokenAddress, question, endTime, resolveTime, prizePool, totalBets, numOptions, winningOption, resolved, cancelled, creator]
      const resolved = onchain[9];
      const winningOption = onchain[8];

      if (resolved) {
        await prisma.prediction.updateMany({
          where: {
            onchainId: i,
            resolved: false,
          },
          data: {
            resolved: true,
            winningOption: Number(winningOption),
          },
        });
      }
    }

  } catch (error) {
    console.error('Sync error:', error);
  }
}

// ============================================================
// START FUNCTION (pour import dans index.ts)
// ============================================================

export async function startPredictionsResolver() {
  console.log('🚀 Predictions Resolver Started');
  console.log(`Contract: ${PREDICTIONS_CONTRACT}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log('');

  // Run immediately
  resolvePredictions();
  syncOnchainPredictions();

  // Then run every minute
  setInterval(async () => {
    await resolvePredictions();
  }, 60 * 1000);

  // Sync every 5 minutes
  setInterval(async () => {
    await syncOnchainPredictions();
  }, 5 * 60 * 1000);
}

// ============================================================
// STANDALONE RUN
// ============================================================

// Si lancé directement: node predictions-resolver.js
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await startPredictionsResolver();
}