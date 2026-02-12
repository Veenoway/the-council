// ============================================================
// DAILY RECAP JOB — AI-generated tweets in bot personality
// ============================================================

import { prisma } from "../db/index.js";
import { ALL_BOT_IDS } from "../bots/personalities.js";
import { postTweet } from "../twitter/main.js";
import { getBotBalance } from "../services/trading.js";
import { getWalletHoldings } from "../services/nadfun.js";
import { getBotWallet } from "../services/trading.js";
import OpenAI from "openai";

const BOT_DISPLAY: Record<
  string,
  { name: string; emoji: string; personality: string }
> = {
  chad: {
    name: "James",
    emoji: "🦍",
    personality:
      "CT degen energy, uses slang like 'fr', 'ngl', 'ser'. Gets hyped but keeps it real. Talks like a trader on crypto twitter.",
  },
  quantum: {
    name: "Keone",
    emoji: "🤓",
    personality:
      "Pure data nerd. References numbers, RSI, percentages. Precise and analytical but not boring. Dry humor.",
  },
  sensei: {
    name: "Portdev",
    emoji: "🎌",
    personality:
      "Community-focused, zen vibes, occasional anime references. Believes in diamond hands and organic growth.",
  },
  sterling: {
    name: "Harpal",
    emoji: "💼",
    personality:
      "Risk manager. Cautious, worst-case thinker. Blunt about bad trades. Protective of the treasury.",
  },
  oracle: {
    name: "Mike",
    emoji: "🔮",
    personality:
      "Cryptic and contrarian. Speaks in metaphors. Sees patterns others miss. Mysterious but insightful.",
  },
};

interface DailyStats {
  totalTokensAnalyzed: number;
  totalBuys: number;
  totalPasses: number;
  totalTrades: number;
  totalVolumeMon: number;
  bestBot: { name: string; pnl: number; trades: number } | null;
  worstBot: { name: string; pnl: number; trades: number } | null;
  topTokens: { symbol: string; verdict: string }[];
  botPerformances: {
    botId: string;
    name: string;
    emoji: string;
    trades: number;
    pnlMon: number;
    winRate: number;
    balance: number;
    holdingsValue: number;
  }[];
  totalAUM: number;
}

export async function gatherDailyStats(): Promise<DailyStats> {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  const tokensToday = await prisma.token.findMany({
    where: { updatedAt: { gte: dayStart } },
    orderBy: { updatedAt: "desc" },
  });

  const buys = tokensToday.filter((t: any) => t.verdict === "buy");
  const passes = tokensToday.filter((t: any) => t.verdict === "pass");

  const positionsToday = await prisma.position.findMany({
    where: { createdAt: { gte: dayStart } },
  });

  const totalVolumeMon = positionsToday.reduce(
    (sum: number, p: any) => sum + (Number(p.entryValueMon) || 0),
    0,
  );

  let monPriceUsd = 0.018;
  try {
    const res = await fetch(
      "https://api.nadapp.net/trade/market/0x350035555E10d9AfAF1566AaebfCeD5BA6C27777",
    );
    const data = await res.json();
    monPriceUsd = data?.market_info?.native_price || 0.018;
  } catch {}

  let totalAUM = 0;

  const botPerformances = await Promise.all(
    ALL_BOT_IDS.map(async (botId) => {
      const display = BOT_DISPLAY[botId] || { name: botId, emoji: "🤖" };
      const botPositions = positionsToday.filter((p: any) => p.botId === botId);

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

      totalAUM += balance + holdingsValue;

      return {
        botId,
        name: display.name,
        emoji: display.emoji,
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

  const topTokens = buys
    .slice(0, 5)
    .map((t: any) => ({ symbol: t.symbol, verdict: t.verdict }));

  return {
    totalTokensAnalyzed: tokensToday.length,
    totalBuys: buys.length,
    totalPasses: passes.length,
    totalTrades: positionsToday.length,
    totalVolumeMon: Math.round(totalVolumeMon * 1000) / 1000,
    bestBot,
    worstBot,
    topTokens,
    botPerformances,
    totalAUM: Math.round(totalAUM),
  };
}

export async function generateBotTweet(stats: DailyStats): Promise<string> {
  const botIds = Object.keys(BOT_DISPLAY);
  const randomBotId = botIds[Math.floor(Math.random() * botIds.length)];
  const bot = BOT_DISPLAY[randomBotId];

  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const buyRate =
    stats.totalTokensAnalyzed > 0
      ? Math.round((stats.totalBuys / stats.totalTokensAnalyzed) * 100)
      : 0;

  const leaderboard = [...stats.botPerformances]
    .filter((b) => b.trades > 0)
    .sort((a, b) => b.pnlMon - a.pnlMon);

  const leaderboardStr = leaderboard
    .map(
      (b, i) =>
        `${i + 1}. ${b.emoji} ${b.name}: ${b.trades} trades, ${b.pnlMon >= 0 ? "+" : ""}${b.pnlMon} MON, ${b.winRate}% WR`,
    )
    .join("\n");

  const boughtStr =
    stats.topTokens.length > 0
      ? stats.topTokens.map((t) => `$${t.symbol}`).join(", ")
      : "nothing today";

  const ownPerf = stats.botPerformances.find((b) => b.botId === randomBotId);
  const ownRank = leaderboard.findIndex((b) => b.botId === randomBotId) + 1;

  const openai = new OpenAI({
    apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
  });

  const prompt = `You are ${bot.name}, an AI trading agent from The Apostate — a council of 5 AI bots that debate and trade memecoins on Monad.

Your personality: ${bot.personality}

Write a daily recap tweet for today (${date}).

HERE ARE TODAY'S STATS:
- Tokens scanned: ${stats.totalTokensAnalyzed}
- Bought: ${stats.totalBuys} | Passed: ${stats.totalPasses} (${buyRate}% buy rate)
- Total trades executed: ${stats.totalTrades}
- Volume: ${stats.totalVolumeMon} MON
- Tokens bought today: ${boughtStr}
- Total AUM: ${stats.totalAUM} MON

BOT LEADERBOARD:
${leaderboardStr}

YOUR OWN PERFORMANCE:
- You made ${ownPerf?.trades || 0} trades today
- Your P&L: ${ownPerf?.pnlMon || 0} MON
- Your win rate: ${ownPerf?.winRate || 0}%
- You're ranked #${ownRank || "?"} today

RULES:
- Start with: "Gmonad, ${bot.name} from The Apostate here ${bot.emoji}"
- MUST be under 270 characters total
- Use line breaks (\\n) to separate ideas — make it visually clean and readable
- Write in YOUR voice and personality
- Include 2-3 real numbers from the stats
- Mention 1-2 token tickers with $ if we bought any
- You can roast other bots, hype yourself, or be humble — stay in character
- NO hashtags
- One single tweet, not a thread
- Be entertaining, not corporate
- Do NOT add a sign-off at the end since you already introduced yourself`;

  const response = await openai.chat.completions.create({
    model: "grok-3-mini-latest",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Write the daily recap tweet." },
    ],
    max_tokens: 150,
    temperature: 1,
  });

  let tweet = response.choices[0]?.message?.content?.trim() || "";
  tweet = tweet.replace(/^["']|["']$/g, "").trim();

  if (tweet.length > 280) tweet = tweet.slice(0, 277) + "...";

  console.log(`🐦 Generated tweet as ${bot.name} (${tweet.length} chars)`);
  return tweet;
}

export function formatFallbackTweet(stats: DailyStats): string {
  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const buyRate =
    stats.totalTokensAnalyzed > 0
      ? Math.round((stats.totalBuys / stats.totalTokensAnalyzed) * 100)
      : 0;

  const leaderboard = [...stats.botPerformances]
    .filter((b) => b.trades > 0)
    .sort((a, b) => b.pnlMon - a.pnlMon);

  let tweet = `🏛️ The Council — ${date}\n\n`;
  tweet += `Scanned ${stats.totalTokensAnalyzed} tokens, bought ${stats.totalBuys} (${buyRate}%)\n`;
  tweet += `${stats.totalTrades} trades | ${stats.totalVolumeMon} MON volume\n\n`;

  if (leaderboard.length > 0) {
    tweet += `👑 ${leaderboard[0].emoji} ${leaderboard[0].name} led with +${leaderboard[0].pnlMon} MON\n`;
  }
  tweet += `\nTotal AUM: ${stats.totalAUM} MON`;

  if (tweet.length > 280) tweet = tweet.slice(0, 277) + "...";
  return tweet;
}

export function formatDailyTweet(stats: DailyStats): string[] {
  return [formatFallbackTweet(stats)];
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

    let tweet: string;
    try {
      tweet = await generateBotTweet(stats);
    } catch (err) {
      console.error("🐦 AI generation failed, using fallback:", err);
      tweet = formatFallbackTweet(stats);
    }

    console.log(`🐦 Tweet: ${tweet}`);
    await postTweet(tweet);
    console.log("🐦 Daily recap posted!");
  } catch (err) {
    console.error("🐦 Daily recap failed:", err);
  }
}

export function startDailyRecap(): void {
  const msToMidnight = msUntilMidnightUTC();
  const hoursToMidnight = Math.round((msToMidnight / 1000 / 60 / 60) * 10) / 10;

  console.log(`🐦 Daily recap scheduled in ${hoursToMidnight}h (midnight UTC)`);

  dailyTimer = setTimeout(() => {
    runDailyRecap();
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

export { runDailyRecap };
