// ============================================================
// TRADING SERVICE — Execute trades for bots
// ============================================================

import { formatEther, parseEther } from 'viem';
import type { BotId, Trade, Token } from '../types/index.js';
import { saveTrade, updateTradeStatus, updateBotStats } from '../db/index.js';
import { broadcastTrade } from './websocket.js';
import { 
  buyToken, 
  sellToken, 
  getWalletBalance, 
  getTokenBalance,
  createBotWalletClient,
  publicClient,
} from './nadfun.js';
import { randomUUID } from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';

// Bot wallets (loaded from env)
interface BotWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

function getBotWallet(botId: BotId): BotWallet | null {
  const prefix = botId.toUpperCase();
  
  // Try bot-specific key first
  let privateKey = process.env[`${prefix}_WALLET_PRIVATE_KEY`] as `0x${string}` | undefined;
  
  // Fallback to shared wallet for testing
  if (!privateKey) {
    privateKey = process.env.SHARED_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  }
  
  if (!privateKey) {
    console.log(`❌ No wallet for ${botId}`);
    return null;
  }
  
  try {
    const account = privateKeyToAccount(privateKey);
    console.log(`✅ ${botId} wallet: ${account.address}`);
    return { address: account.address, privateKey };
  } catch (error) {
    console.error(`❌ Invalid private key for ${botId}`);
    return null;
  }
}

// ============================================================
// BOT TRADING PARAMETERS
// ============================================================

// How much each bot typically trades (in MON)
const BOT_TRADE_SIZES: Record<BotId, { min: number; max: number; avgPercent: number }> = {
  sensei: { min: 0.5, max: 2, avgPercent: 0.1 },      // Conservative
  quantum: { min: 1, max: 3, avgPercent: 0.15 },      // Data-driven, decent size
  chad: { min: 0.5, max: 5, avgPercent: 0.3 },        // YOLO, variable
  sterling: { min: 2, max: 10, avgPercent: 0.2 },     // When he trades, he sizes big
  oracle: { min: 1, max: 5, avgPercent: 0.15 },       // Mysterious but measured
};

// ============================================================
// CALCULATE TRADE SIZE
// ============================================================

export function calculateTradeSize(botId: BotId, balance: number, confidence: number): number {
  const config = BOT_TRADE_SIZES[botId];
  
  // Base size is percentage of balance, scaled by confidence
  let size = balance * config.avgPercent * (confidence / 100);
  
  // Clamp to min/max
  size = Math.max(config.min, Math.min(config.max, size));
  
  // Round to 2 decimals
  return Math.round(size * 100) / 100;
}

// ============================================================
// SHOULD BOT TRADE?
// ============================================================

export function shouldBotTrade(
  botId: BotId,
  riskScore: number,
  sentiment: 'bullish' | 'bearish' | 'neutral',
  confidence: number
): boolean {
  switch (botId) {
    case 'chad':
      // Chad trades almost always if not extremely bearish
      return sentiment !== 'bearish' || Math.random() > 0.7;
    
    case 'quantum':
      // Quantum needs good data
      return confidence > 65 && riskScore < 60 && sentiment !== 'bearish';
    
    case 'sensei':
      // Sensei follows vibes
      return sentiment === 'bullish' && confidence > 50;
    
    case 'sterling':
      // Sterling is very selective
      return riskScore < 40 && confidence > 75 && sentiment === 'bullish';
    
    case 'oracle':
      // Oracle is mysterious - sometimes trades against sentiment
      return Math.random() > 0.6 && riskScore < 50;
    
    default:
      return false;
  }
}

// ============================================================
// GET BOT BALANCE
// ============================================================

export async function getBotBalance(botId: BotId): Promise<number> {
  try {
    const wallet = getBotWallet(botId);
    if (!wallet) return 0;

    const balance = await getWalletBalance(wallet.address);
    return parseFloat(formatEther(balance));
  } catch (error) {
    console.error(`Error getting balance for ${botId}:`, error);
    return 0;
  }
}

// ============================================================
// EXECUTE BOT TRADE
// ============================================================

export async function executeBotTrade(
  botId: BotId,
  token: Token,
  amountMON: number,
  side: 'buy' | 'sell' = 'buy'
): Promise<Trade | null> {
  const wallet = getBotWallet(botId);
  
  if (!wallet) {
    console.error(`No wallet configured for ${botId}`);
    return null;
  }

  // Check balance
  const balance = await getBotBalance(botId);
  console.log("balance",balance);
  if (side === 'buy' && balance < amountMON) {
    console.error(`${botId} has insufficient balance: ${balance} MON`);
    return null;
  }

  // Create pending trade
  const tradeId = randomUUID();
  const trade: Trade = {
    id: tradeId,
    botId,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    side,
    amountIn: amountMON,
    amountOut: 0,
    price: token.price,
    txHash: '',
    status: 'pending',
    createdAt: new Date(),
  };

  // Save pending trade
  await saveTrade(trade);

  // Broadcast pending trade
  broadcastTrade(trade);

  try {
    // Create wallet client
    const walletClient = createBotWalletClient(wallet.privateKey);

    if (side === 'buy') {
      // Execute buy
      const result = await buyToken(
        walletClient,
        token.address as `0x${string}`,
        amountMON.toString()
      );

      if (!result) {
        throw new Error('Buy failed');
      }

      // Update trade with result
      trade.txHash = result.txHash;
      trade.amountOut = parseFloat(formatEther(result.amountOut));
      trade.status = 'confirmed';

    } else {
      // For sell, need to get token balance first
      const tokenBalance = await getTokenBalance(
        token.address as `0x${string}`,
        wallet.address
      );

      const result = await sellToken(
        walletClient,
        token.address as `0x${string}`,
        tokenBalance
      );

      if (!result) {
        throw new Error('Sell failed');
      }

      trade.txHash = result.txHash;
      trade.amountOut = parseFloat(formatEther(result.amountOut));
      trade.status = 'confirmed';
    }

    await updateTradeStatus(trade.txHash, 'confirmed');

    // Broadcast confirmed trade
    broadcastTrade(trade);

    return trade;
  } catch (error) {
    console.error(`Trade failed for ${botId}:`, error);
    
    trade.status = 'failed';
    await updateTradeStatus(trade.id, 'failed');
    
    broadcastTrade(trade);
    
    return null;
  }
}

// ============================================================
// CLOSE POSITION (SELL)
// ============================================================

export async function closeBotPosition(
  botId: BotId,
  token: Token,
  amountTokens?: bigint
): Promise<Trade | null> {
  const wallet = getBotWallet(botId);
  
  if (!wallet) {
    console.error(`No wallet configured for ${botId}`);
    return null;
  }

  // Get token balance if not specified
  const tokenBalance = amountTokens || await getTokenBalance(
    token.address as `0x${string}`,
    wallet.address
  );

  if (tokenBalance === 0n) {
    console.error(`${botId} has no tokens to sell`);
    return null;
  }

  const tradeId = randomUUID();
  const trade: Trade = {
    id: tradeId,
    botId,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    side: 'sell',
    amountIn: parseFloat(formatEther(tokenBalance)),
    amountOut: 0,
    price: token.price,
    txHash: '',
    status: 'pending',
    createdAt: new Date(),
  };

  await saveTrade(trade);
  broadcastTrade(trade);

  try {
    const walletClient = createBotWalletClient(wallet.privateKey);
    
    const result = await sellToken(
      walletClient,
      token.address as `0x${string}`,
      tokenBalance
    );

    if (!result) {
      throw new Error('Sell failed');
    }

    trade.txHash = result.txHash;
    trade.amountOut = parseFloat(formatEther(result.amountOut));
    trade.status = 'confirmed';

    await updateTradeStatus(result.txHash, 'confirmed');
    broadcastTrade(trade);

    return trade;
  } catch (error) {
    console.error(`Sell failed for ${botId}:`, error);
    trade.status = 'failed';
    await updateTradeStatus(trade.id, 'failed');
    broadcastTrade(trade);
    return null;
  }
}

// ============================================================
// TRACK P&L
// ============================================================

export async function calculatePnL(
  entryPrice: number,
  currentPrice: number,
  amount: number
): Promise<{ pnl: number; pnlPercent: number }> {
  const entryValue = entryPrice * amount;
  const currentValue = currentPrice * amount;
  const pnl = currentValue - entryValue;
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

  return { pnl, pnlPercent };
}

// ============================================================
// RECORD TRADE RESULT
// ============================================================

export async function recordTradeResult(
  trade: Trade,
  exitPrice: number
): Promise<void> {
  const pnl = ((exitPrice - trade.price) / trade.price) * 100;
  const isWin = pnl > 0;

  await updateTradeStatus(trade.txHash, 'closed', pnl);
  
  if (!trade.botId.startsWith('human_')) {
    await updateBotStats(trade.botId, isWin, pnl);
  }
}