// ============================================================
// NARRATIVE ANALYSIS — Real Twitter/X search via Grok
// ============================================================

import OpenAI from "openai";
import type { Token } from "../../types/index.js";

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

// ============================================================
// TYPES
// ============================================================

export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
  description?: string;
}

// Cache pour éviter les fetches multiples du même token
const tokenSocialsCache = new Map<
  string,
  { data: TokenSocials | null; timestamp: number }
>();
const CACHE_TTL = 60_000; // 1 minute cache

export interface NarrativeAnalysis {
  narrativeScore: number;
  narrativeType: "fresh" | "trending" | "tired" | "dead" | "unknown";
  narrativeReason: string;

  socialScore: number;
  hasActiveCommunity: boolean;
  isBeingRaided: boolean;
  mentionCount: "none" | "few" | "moderate" | "viral";
  sentimentOnX:
    | "very_negative"
    | "negative"
    | "neutral"
    | "positive"
    | "very_positive";

  redFlags: string[];
  isLikelyScam: boolean;
  scamIndicators: string[];

  notableTraders: string[];
  influencerMentions: boolean;

  narrativeTiming: "too_early" | "early" | "peak" | "late" | "dead";

  // Summaries for each bot
  summaryForChad: string;
  summaryForKeone: string;
  summaryForPortdev: string;
  summaryForHarpal: string;
  summaryForMike: string;

  // Raw data from search
  recentTweets: string[];
  topAccounts: string[];

  // Token's official socials
  officialTwitter?: string;
  officialTwitterActive: boolean;

  shouldTrade: boolean;
  confidence: number;
}

// ============================================================
// FETCH TOKEN SOCIALS FROM NAD.FUN API (with cache)
// ============================================================

async function fetchTokenSocials(
  tokenAddress: string,
): Promise<TokenSocials | null> {
  // Check cache first
  const cached = tokenSocialsCache.get(tokenAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(
      `📋 Using cached token socials for ${tokenAddress.slice(0, 10)}...`,
    );
    return cached.data;
  }

  try {
    console.log(
      `📡 Fetching token info from nad.fun: ${tokenAddress.slice(0, 10)}...`,
    );
    const response = await fetch(`https://api.nad.fun/token/${tokenAddress}`);
    if (!response.ok) {
      console.log(`   ❌ API returned ${response.status}`);
      tokenSocialsCache.set(tokenAddress, {
        data: null,
        timestamp: Date.now(),
      });
      return null;
    }

    const dataBuffer = await response.json();
    const data = dataBuffer.token_info || dataBuffer;

    // Try multiple possible paths for Twitter
    const twitter =
      data.twitter ||
      data.socials?.twitter ||
      data.social?.twitter ||
      data.links?.twitter ||
      data.metadata?.twitter ||
      null;

    const telegram =
      data.telegram ||
      data.socials?.telegram ||
      data.social?.telegram ||
      data.links?.telegram ||
      null;

    const website =
      data.website ||
      data.socials?.website ||
      data.social?.website ||
      data.links?.website ||
      data.url ||
      null;

    const discord =
      data.discord ||
      data.socials?.discord ||
      data.social?.discord ||
      data.links?.discord ||
      null;

    const description =
      data.description || data.metadata?.description || data.bio || null;

    console.log(`   🐦 Twitter found: ${twitter || "None"}`);

    const result = { twitter, telegram, website, discord, description };

    // Cache the result
    tokenSocialsCache.set(tokenAddress, {
      data: result,
      timestamp: Date.now(),
    });

    return result;
  } catch (error) {
    console.error("Failed to fetch token socials:", error);
    tokenSocialsCache.set(tokenAddress, { data: null, timestamp: Date.now() });
    return null;
  }
}

// ============================================================
// CHECK OFFICIAL TWITTER ACCOUNT
// ============================================================

async function checkOfficialTwitter(twitterHandle: string): Promise<{
  isActive: boolean;
  recentActivity: string;
  followerEstimate: string;
  redFlags: string[];
}> {
  try {
    // Clean the handle
    const handle = twitterHandle
      .replace("https://twitter.com/", "")
      .replace("https://x.com/", "")
      .replace("@", "");

    const response = await grok.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        {
          role: "system",
          content: `You have real-time Twitter/X access. Analyze this account thoroughly.`,
        },
        {
          role: "user",
          content: `Analyze the Twitter account @${handle}:

1. Is the account active? (posted in last 7 days?)
2. What are they posting about recently?
3. Approximate follower count?
4. Any red flags? (fake followers, bot-like behavior, copied content, suspicious patterns)
5. Does it look like a legitimate project or potential scam?

Be specific and factual.`,
        },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || "";

    const isActive =
      !content.toLowerCase().includes("not active") &&
      !content.toLowerCase().includes("no recent") &&
      !content.toLowerCase().includes("inactive");

    const redFlags: string[] = [];
    if (content.toLowerCase().includes("fake follower"))
      redFlags.push("Fake followers suspected");
    if (content.toLowerCase().includes("bot"))
      redFlags.push("Bot-like behavior");
    if (content.toLowerCase().includes("scam"))
      redFlags.push("Scam indicators");
    if (content.toLowerCase().includes("copied"))
      redFlags.push("Copied content");
    if (content.toLowerCase().includes("suspicious"))
      redFlags.push("Suspicious activity");

    // Extract follower estimate
    const followerMatch = content.match(/(\d+[kKmM]?)\s*followers?/i);
    const followerEstimate = followerMatch ? followerMatch[1] : "unknown";

    return {
      isActive,
      recentActivity: content.slice(0, 200),
      followerEstimate,
      redFlags,
    };
  } catch (error) {
    console.error("Failed to check official Twitter:", error);
    return {
      isActive: false,
      recentActivity: "Check failed",
      followerEstimate: "unknown",
      redFlags: [],
    };
  }
}

// ============================================================
// SEARCH TWITTER FOR TOKEN MENTIONS
// ============================================================

async function searchTwitterMentions(
  symbol: string,
  name: string,
  officialHandle?: string,
): Promise<string> {
  try {
    let searchContext = `Search Twitter/X for mentions of $${symbol} (${name}) memecoin.`;

    if (officialHandle) {
      const handle = officialHandle
        .replace("https://twitter.com/", "")
        .replace("https://x.com/", "")
        .replace("@", "");
      searchContext += `\nThe official account is @${handle} - also check who's interacting with them.`;
    }

    const response = await grok.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        {
          role: "system",
          content: `You have access to real-time Twitter/X data. Search and analyze tweets about the given topic.
Return raw findings - actual tweet content, usernames, engagement metrics.
Be specific and factual. If you find nothing, say so.`,
        },
        {
          role: "user",
          content: `${searchContext}

Return:
1. Recent tweets mentioning $${symbol} (last 24h) - quote actual tweets
2. Who's talking about it (usernames, follower counts if notable)
3. General sentiment (bullish/bearish/neutral)
4. Any red flags or concerns (coordinated shilling, bots, etc)
5. Notable traders or influencers mentioning it
6. Is there a raid/shill campaign happening?`,
        },
      ],
      max_tokens: 600,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || "No results found";
  } catch (error) {
    console.error("Twitter search failed:", error);
    return "Search failed";
  }
}

// ============================================================
// ANALYZE TOKEN NARRATIVE
// ============================================================

export async function analyzeNarrative(
  token: Token,
): Promise<NarrativeAnalysis | null> {
  try {
    console.log(`🔍 Analyzing narrative for $${token.symbol}...`);

    // Step 1: Fetch token socials from nad.fun API
    const socials = await fetchTokenSocials(token.address);
    console.log(
      `📋 Token socials: ${socials?.twitter ? socials.twitter : "No Twitter found"}`,
    );

    // Step 2: Check official Twitter if exists
    let officialTwitterData: {
      isActive: boolean;
      recentActivity: string;
      followerEstimate: string;
      redFlags: string[];
    } | null = null;

    if (socials?.twitter) {
      console.log(`🐦 Checking official Twitter: ${socials.twitter}`);
      officialTwitterData = await checkOfficialTwitter(socials.twitter);
      console.log(
        `   Active: ${officialTwitterData.isActive}, Followers: ${officialTwitterData.followerEstimate}`,
      );
    }

    // Step 3: Search for mentions on Twitter
    console.log(`🔎 Searching Twitter for $${token.symbol} mentions...`);
    const twitterMentions = await searchTwitterMentions(
      token.symbol,
      token.name,
      socials?.twitter,
    );

    // Step 4: Analyze everything together
    const analysisPrompt = `Analyze this memecoin's social presence:

TOKEN: $${token.symbol} (${token.name})
- Price: $${token.price}
- Market Cap: $${token.mcap.toLocaleString()}
- Holders: ${token.holders.toLocaleString()}
- Liquidity: $${token.liquidity.toLocaleString()}

${socials?.description ? `DESCRIPTION: ${socials.description}` : ""}

OFFICIAL TWITTER: ${socials?.twitter || "None"}
${
  officialTwitterData
    ? `- Active: ${officialTwitterData.isActive}
- Followers: ${officialTwitterData.followerEstimate}
- Recent activity: ${officialTwitterData.recentActivity}
- Red flags: ${officialTwitterData.redFlags.length > 0 ? officialTwitterData.redFlags.join(", ") : "None"}`
    : ""
}

OTHER SOCIALS:
- Telegram: ${socials?.telegram || "None"}
- Website: ${socials?.website || "None"}
- Discord: ${socials?.discord || "None"}

TWITTER MENTIONS/BUZZ:
${twitterMentions}

Based on ALL this data, respond in this EXACT JSON format (no markdown):
{
  "narrativeScore": <0-100>,
  "narrativeType": "<fresh|trending|tired|dead|unknown>",
  "narrativeReason": "<15 words max explaining why>",
  "socialScore": <0-100>,
  "hasActiveCommunity": <true|false>,
  "isBeingRaided": <true|false>,
  "mentionCount": "<none|few|moderate|viral>",
  "sentimentOnX": "<very_negative|negative|neutral|positive|very_positive>",
  "redFlags": ["<flag1>", "<flag2>"],
  "isLikelyScam": <true|false>,
  "scamIndicators": ["<indicator1>"],
  "notableTraders": ["<@username1>"],
  "influencerMentions": <true|false>,
  "narrativeTiming": "<too_early|early|peak|late|dead>",
  "recentTweets": ["<actual tweet text 1>", "<actual tweet text 2>"],
  "topAccounts": ["<@account1>", "<@account2>"],
  "officialTwitter": "${socials?.twitter || ""}",
  "officialTwitterActive": ${officialTwitterData?.isActive || false},
  "summaryForChad": "<degen take, 12 words max, use slang>",
  "summaryForKeone": "<analytical take, 12 words max>",
  "summaryForPortdev": "<community take, 12 words max>",
  "summaryForHarpal": "<risk take, 12 words max>",
  "summaryForMike": "<cryptic take, 12 words max>",
  "shouldTrade": <true|false>,
  "confidence": <0-100>
}

SCORING GUIDELINES:
- No Twitter = narrativeScore < 30
- Inactive official Twitter = -20 points
- Active official Twitter with engagement = +20 points
- No mentions from others = socialScore < 25
- Coordinated shilling/raid = isBeingRaided true, -15 points
- Red flags from official account = isLikelyScam consideration
- Fresh narrative with organic buzz = narrativeType "fresh", +bonus`;

    const response = await grok.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        {
          role: "system",
          content: "You are a crypto analyst. Respond ONLY with valid JSON.",
        },
        { role: "user", content: analysisPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.5,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const cleaned = content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const analysis = JSON.parse(cleaned) as NarrativeAnalysis;

    // Add official twitter data if not in response
    if (socials?.twitter && !analysis.officialTwitter) {
      analysis.officialTwitter = socials.twitter;
    }
    if (officialTwitterData && analysis.officialTwitterActive === undefined) {
      analysis.officialTwitterActive = officialTwitterData.isActive;
    }

    console.log(
      `✅ Narrative analysis complete: ${analysis.narrativeType} (${analysis.narrativeScore}/100)`,
    );
    if (analysis.officialTwitter) {
      console.log(
        `   Official Twitter: ${analysis.officialTwitter} (Active: ${analysis.officialTwitterActive})`,
      );
    }

    return analysis;
  } catch (error) {
    console.error("Narrative analysis failed:", error);
    return null;
  }
}

// ============================================================
// QUICK COMMUNITY CHECK
// ============================================================

export async function quickCommunityCheck(
  symbol: string,
  name: string,
): Promise<{
  hasActivity: boolean;
  sentiment: string;
  summary: string;
}> {
  try {
    const response = await grok.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        {
          role: "system",
          content:
            "You have real-time Twitter access. Give a quick assessment.",
        },
        {
          role: "user",
          content: `Quick check: Is there any Twitter activity for $${symbol} (${name}) memecoin in the last 24 hours?
          
Answer in 1-2 sentences: Is there activity? What's the vibe?`,
        },
      ],
      max_tokens: 100,
      temperature: 0.5,
    });

    const content = response.choices[0]?.message?.content || "Unable to check";
    const hasActivity =
      !content.toLowerCase().includes("no activity") &&
      !content.toLowerCase().includes("no mention") &&
      !content.toLowerCase().includes("nothing found");

    let sentiment = "neutral";
    if (content.toLowerCase().match(/positive|bullish|excited|hype/))
      sentiment = "positive";
    if (content.toLowerCase().match(/negative|bearish|scam|warning/))
      sentiment = "negative";

    return { hasActivity, sentiment, summary: content };
  } catch (error) {
    return {
      hasActivity: false,
      sentiment: "unknown",
      summary: "Check failed",
    };
  }
}

// ============================================================
// CHECK FOR KNOWN TRADERS
// ============================================================

export async function checkKnownTraders(symbol: string): Promise<{
  knownTraders: string[];
  influencerMentions: boolean;
  whaleAlert: boolean;
}> {
  try {
    const response = await grok.chat.completions.create({
      model: "grok-3-mini-latest",
      messages: [
        {
          role: "system",
          content:
            "You have real-time Twitter access. Check for notable crypto traders.",
        },
        {
          role: "user",
          content: `Are any known crypto traders or influencers talking about $${symbol}?
          
Check for:
- Large CT accounts (>10K followers)
- Known memecoin traders
- Whale wallets posting

List any notable accounts mentioning it, or say "none found".`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || "";

    // Extract @usernames
    const usernameMatches = content.match(/@\w+/g) || [];
    const knownTraders = [...new Set(usernameMatches)].slice(0, 5);

    const influencerMentions =
      content
        .toLowerCase()
        .match(/influencer|large account|big account|popular|famous/) !== null;
    const whaleAlert =
      content.toLowerCase().match(/whale|large wallet|big buyer/) !== null;

    return { knownTraders, influencerMentions, whaleAlert };
  } catch (error) {
    return { knownTraders: [], influencerMentions: false, whaleAlert: false };
  }
}

// ============================================================
// FULL SOCIAL CONTEXT — Single fetch, no redundant calls
// ============================================================

export async function getFullSocialContext(token: Token): Promise<{
  narrative: NarrativeAnalysis | null;
  communityCheck: { hasActivity: boolean; sentiment: string; summary: string };
  knownTraders: {
    knownTraders: string[];
    influencerMentions: boolean;
    whaleAlert: boolean;
  };
  overallSocialScore: number;
  tradingRecommendation:
    | "strong_avoid"
    | "avoid"
    | "neutral"
    | "consider"
    | "strong_consider";
}> {
  console.log(`🌐 Getting full social context for $${token.symbol}...`);

  // Single comprehensive analysis - no parallel calls to avoid rate limits
  const narrative = await analyzeNarrative(token);

  // Extract community check from narrative (already fetched)
  const communityCheck = {
    hasActivity: narrative?.hasActiveCommunity || false,
    sentiment: narrative?.sentimentOnX || "neutral",
    summary: narrative?.narrativeReason || "No data",
  };

  // Extract known traders from narrative (already fetched)
  const knownTraders = {
    knownTraders: narrative?.notableTraders || [],
    influencerMentions: narrative?.influencerMentions || false,
    whaleAlert: (narrative?.notableTraders?.length || 0) > 2,
  };

  // Calculate overall score
  let overallScore = 40; // Base score

  if (narrative) {
    overallScore =
      narrative.narrativeScore * 0.5 +
      narrative.socialScore * 0.3 +
      narrative.confidence * 0.2;

    // Penalties
    if (narrative.isLikelyScam) overallScore *= 0.2;
    if (narrative.isBeingRaided) overallScore *= 0.8;
    if (narrative.narrativeType === "dead") overallScore *= 0.5;

    // Bonuses
    if (narrative.narrativeType === "fresh") overallScore *= 1.2;
    if (narrative.influencerMentions) overallScore *= 1.1;
    if (knownTraders.whaleAlert) overallScore *= 1.15;
  }

  if (communityCheck.hasActivity && communityCheck.sentiment === "positive") {
    overallScore *= 1.1;
  }

  overallScore = Math.min(100, Math.max(0, overallScore));

  // Determine recommendation
  let tradingRecommendation:
    | "strong_avoid"
    | "avoid"
    | "neutral"
    | "consider"
    | "strong_consider";

  if (narrative?.isLikelyScam || overallScore < 20) {
    tradingRecommendation = "strong_avoid";
  } else if (overallScore < 35) {
    tradingRecommendation = "avoid";
  } else if (overallScore < 50) {
    tradingRecommendation = "neutral";
  } else if (overallScore < 70) {
    tradingRecommendation = "consider";
  } else {
    tradingRecommendation = "strong_consider";
  }

  console.log(
    `📊 Social score: ${overallScore.toFixed(0)}/100 → ${tradingRecommendation}`,
  );

  return {
    narrative,
    communityCheck,
    knownTraders,
    overallSocialScore: Math.round(overallScore),
    tradingRecommendation,
  };
}

export default {
  analyzeNarrative,
  quickCommunityCheck,
  checkKnownTraders,
  getFullSocialContext,
};
