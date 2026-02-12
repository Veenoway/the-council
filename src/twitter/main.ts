// ============================================================
// TWITTER SERVICE — Post daily recaps & trade alerts
// ============================================================

import { TwitterApi } from "twitter-api-v2";

// OAuth 1.0a User Context (required for posting)
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY || "",
  appSecret: process.env.TWITTER_API_SECRET || "",
  accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
  accessSecret: process.env.TWITTER_ACCESS_SECRET || "",
});

const rwClient = twitterClient.readWrite;

let isEnabled = false;

export function initTwitter(): boolean {
  if (
    !process.env.TWITTER_API_KEY ||
    !process.env.TWITTER_API_SECRET ||
    !process.env.TWITTER_ACCESS_TOKEN ||
    !process.env.TWITTER_ACCESS_SECRET
  ) {
    console.log("🐦 Twitter: disabled (missing credentials)");
    return false;
  }
  isEnabled = true;
  console.log("🐦 Twitter: enabled");
  return true;
}

export async function postTweet(text: string): Promise<string | null> {
  if (!isEnabled) {
    console.log("🐦 Twitter disabled, would have posted:", text.slice(0, 80));
    return null;
  }

  try {
    text = text.replace(/\\n/g, "\n");
    const { data } = await rwClient.v2.tweet(text);
    console.log(`🐦 Tweet posted: ${data.id}`);
    return data.id;
  } catch (err: any) {
    console.error("🐦 Failed to tweet:", err?.data || err?.message || err);
    return null;
  }
}

export async function postThread(tweets: string[]): Promise<string[]> {
  if (!isEnabled || tweets.length === 0) return [];

  const ids: string[] = [];

  try {
    // First tweet
    const { data: first } = await rwClient.v2.tweet(tweets[0]);
    ids.push(first.id);
    console.log(`🐦 Thread started: ${first.id}`);

    // Reply chain
    for (let i = 1; i < tweets.length; i++) {
      const { data: reply } = await rwClient.v2.reply(
        tweets[i],
        ids[ids.length - 1],
      );
      ids.push(reply.id);
    }

    console.log(`🐦 Thread posted: ${ids.length} tweets`);
    return ids;
  } catch (err: any) {
    console.error(
      "🐦 Failed to post thread:",
      err?.data || err?.message || err,
    );
    return ids;
  }
}
