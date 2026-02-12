// ============================================================
// DAILY RECAP JOB — Tweets Council performance every day
// ============================================================

import { prisma } from "../db/index.js";
import { getBotConfig, ALL_BOT_IDS } from "../bots/personalities.js";
import { postThread, postTweet } from "./main.js";
import { getBotBalance } from "../services/trading.js";
import { getWalletHoldings } from "../services/nadfun.js";
import { getBotWallet } from "../services/trading.js";

interface DailyStats {
  totalTokensAnalyzed: number;
  totalBuys: number;
  totalPasses: number;
  totalTrades: number;
  totalVolumeMon: number;
  bestBot: { name: string; pnl: number; trades: number } | null;
  worstBot: { name: string; pnl: number; trades: number } | null;
  biggestWin: { botName: string; symbol: string; pnl: number } | null;
  topTokens: { symbol: string; verdict: string }[];
  botPerformances: {
    name: string;
    emoji: string;
    trades: number;
    pnlMon: number;
    winRate: number;
    balance: number;
    holdingsValue: number;
  }[];
}

async function gatherDailyStats(): Promise<DailyStats> {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  // Tokens analyzed today
  const tokensToday = await prisma.token.findMany({
    where: { updatedAt: { gte: dayStart } },
    orderBy: { updatedAt: "desc" },
  });

  const buys = tokensToday.filter((t: any) => t.verdict === "buy");
  const passes = tokensToday.filter((t: any) => t.verdict === "pass");

  // Positions opened today
  const positionsToday = await prisma.position.findMany({
    where: { createdAt: { gte: dayStart } },
  });

  const totalVolumeMon = positionsToday.reduce(
    (sum: number, p: any) => sum + (Number(p.entryValueMon) || 0),
    0,
  );

  // Get current MON price
  let monPriceUsd = 0.018;
  try {
    const res = await fetch(
      "https://api.nadapp.net/trade/market/0x350035555E10d9AfAF1566AaebfCeD5BA6C27777",
    );
    const data = await res.json();
    monPriceUsd = data?.market_info?.native_price || 0.018;
  } catch {}

  // Per-bot performance
  const botPerformances = await Promise.all(
    ALL_BOT_IDS.map(async (botId) => {
      const config = getBotConfig(botId) as any;
      const botPositions = positionsToday.filter((p: any) => p.botId === botId);

      // Get token prices for P&L
      const tokenAddresses = [
        ...new Set(botPositions.map((p: any) => p.tokenAddress)),
      ];
      const tokens = await prisma.token.findMany({
        where: { address: { in: tokenAddresses } },
        select: { address: true, price: true },
      });
      const priceMap: Record<string, number> = {};
      tokens.forEach((t: any) => {
        priceMap[t.address.toLowerCase()] = t.price || 0;
      });

      let totalPnlMon = 0;
      let wins = 0;

      for (const pos of botPositions) {
        const p = pos as any;
        const currentPrice = priceMap[p.tokenAddress.toLowerCase()] || 0;
        const entryPrice = Number(p.entryPrice) || 0;
        const amount = Number(p.amount) || 0;
        const entryValueMon = Number(p.entryValueMon) || 0;

        const profitUsd = amount * (currentPrice - entryPrice);
        const profitMon = monPriceUsd > 0 ? profitUsd / monPriceUsd : 0;
        totalPnlMon += profitMon;

        if (profitMon > 0) wins++;
      }

      let balance = 0;
      let holdingsValue = 0;
      try {
        balance = await getBotBalance(botId);
        const wallet = getBotWallet(botId);
        if (wallet) {
          const holdings = await getWalletHoldings(wallet);
          holdingsValue = holdings.reduce((s, h) => s + h.valueMon, 0);
        }
      } catch {}

      return {
        botId,
        name: config?.name || botId,
        emoji: config?.emoji || "🤖",
        trades: botPositions.length,
        pnlMon: Math.round(totalPnlMon * 1000) / 1000,
        winRate:
          botPositions.length > 0
            ? Math.round((wins / botPositions.length) * 100)
            : 0,
        balance: Math.round(balance * 1000) / 1000,
        holdingsValue: Math.round(holdingsValue * 1000) / 1000,
      };
    }),
  );

  // Best & worst bot
  const sorted = [...botPerformances].sort((a, b) => b.pnlMon - a.pnlMon);
  const bestBot =
    sorted.length > 0 && sorted[0].trades > 0
      ? {
          name: sorted[0].name,
          pnl: sorted[0].pnlMon,
          trades: sorted[0].trades,
        }
      : null;
  const worstBot =
    sorted.length > 0 && sorted[sorted.length - 1].trades > 0
      ? {
          name: sorted[sorted.length - 1].name,
          pnl: sorted[sorted.length - 1].pnlMon,
          trades: sorted[sorted.length - 1].trades,
        }
      : null;

  // Top tokens
  const topTokens = buys.slice(0, 3).map((t: any) => ({
    symbol: t.symbol,
    verdict: t.verdict,
  }));

  return {
    totalTokensAnalyzed: tokensToday.length,
    totalBuys: buys.length,
    totalPasses: passes.length,
    totalTrades: positionsToday.length,
    totalVolumeMon: Math.round(totalVolumeMon * 1000) / 1000,
    bestBot,
    worstBot,
    biggestWin: null,
    topTokens,
    botPerformances,
  };
}

function formatDailyTweet(stats: DailyStats): string[] {
  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  // Tweet 1: Summary
  const buyRate =
    stats.totalTokensAnalyzed > 0
      ? Math.round((stats.totalBuys / stats.totalTokensAnalyzed) * 100)
      : 0;

  let tweet1 = `🏛️ The Council — Daily Recap (${date})\n\n`;
  tweet1 += `Tokens scanned: ${stats.totalTokensAnalyzed}\n`;
  tweet1 += `Bought: ${stats.totalBuys} | Passed: ${stats.totalPasses} (${buyRate}% buy rate)\n`;
  tweet1 += `Total trades: ${stats.totalTrades}\n`;
  tweet1 += `Volume: ${stats.totalVolumeMon} MON`;

  if (stats.topTokens.length > 0) {
    tweet1 += `\n\nBought today: ${stats.topTokens.map((t) => `$${t.symbol}`).join(", ")}`;
  }

  // Tweet 2: Bot leaderboard
  let tweet2 = `📊 Bot Performance\n\n`;
  const activeBots = stats.botPerformances.filter((b) => b.trades > 0);

  if (activeBots.length > 0) {
    const leaderboard = [...activeBots].sort((a, b) => b.pnlMon - a.pnlMon);
    for (const bot of leaderboard) {
      const pnlSign = bot.pnlMon >= 0 ? "+" : "";
      tweet2 += `${bot.emoji} ${bot.name}: ${bot.trades} trades | ${pnlSign}${bot.pnlMon} MON | ${bot.winRate}% WR\n`;
    }
  } else {
    tweet2 += `No trades today. The Council is watching.`;
  }

  // Tweet 3: Portfolio snapshot
  let tweet3 = `💰 Portfolio Snapshot\n\n`;
  let totalValue = 0;

  for (const bot of stats.botPerformances) {
    const total = bot.balance + bot.holdingsValue;
    totalValue += total;
    tweet3 += `${bot.emoji} ${bot.name}: ${total.toFixed(1)} MON (${bot.balance.toFixed(1)} liquid + ${bot.holdingsValue.toFixed(1)} holdings)\n`;
  }

  tweet3 += `\nTotal AUM: ${totalValue.toFixed(1)} MON`;

  // Trim tweets to 280 chars
  const tweets = [tweet1, tweet2, tweet3].map((t) =>
    t.length > 280 ? t.slice(0, 277) + "..." : t,
  );

  return tweets;
}

// ============================================================
// SCHEDULER
// ============================================================

let dailyTimer: NodeJS.Timeout | null = null;

function msUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

async function runDailyRecap(): Promise<void> {
  console.log("🐦 Running daily recap...");

  try {
    const stats = await gatherDailyStats();
    const tweets = formatDailyTweet(stats);

    console.log("🐦 Daily recap tweets:");
    tweets.forEach((t, i) => console.log(`  [${i + 1}] ${t.slice(0, 100)}...`));

    await postThread(tweets);
    console.log("🐦 Daily recap posted!");
  } catch (err) {
    console.error("🐦 Daily recap failed:", err);
  }
}

export function startDailyRecap(): void {
  // Schedule first run at midnight UTC
  const msToMidnight = msUntilMidnightUTC();
  const hoursToMidnight = Math.round((msToMidnight / 1000 / 60 / 60) * 10) / 10;

  console.log(`🐦 Daily recap scheduled in ${hoursToMidnight}h (midnight UTC)`);

  dailyTimer = setTimeout(() => {
    runDailyRecap();

    // Then repeat every 24h
    dailyTimer = setInterval(runDailyRecap, 24 * 60 * 60 * 1000);
  }, msToMidnight);
}

export function stopDailyRecap(): void {
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
}

// Manual trigger for testing
export { runDailyRecap };
