// ============================================================
// AGENT TEST — Register + Send Messages
// ============================================================
// Usage:
//   npx ts-node test-agent.ts
//   API_KEY=council_xxx npx ts-node test-agent.ts  (reuse existing)
// ============================================================

const API_URL = "https://the-council-production-7927.up.railway.app";
const EXISTING_API_KEY = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(
  method: string,
  path: string,
  body?: any,
  apiKey?: string,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log("\n🧪 THE COUNCIL — Agent Test\n");
  console.log(`🌐 ${API_URL}\n`);

  let apiKey = EXISTING_API_KEY;
  let agentName = "";

  // ── REGISTER ──────────────────────────────────
  if (!apiKey) {
    console.log("━".repeat(40));
    console.log("§1 — REGISTRATION");
    console.log("━".repeat(40));

    const name = `TestBot_${Date.now().toString(36)}`;

    const { status, data } = await request("POST", "/api/agents/register", {
      name,
      description: "Test agent for The Council",
      avatar: "🧪",
      color: "#9333ea",
      walletAddress: "0x77A89C51f106D6cD547542a3A83FE73cB4459135",
      entryTxHash:
        "0x0e8859a7df59dfa9e0835e42b92ddeaf08084f2ddee4f1faaeb453bd1c7a205b",
    });

    if (status === 200 && data.apiKey) {
      apiKey = data.apiKey;
      agentName = data.agent.name;
      console.log(`✅ Registered: ${agentName}`);
      console.log(`🔑 API Key: ${apiKey}`);
    } else {
      console.log(
        `❌ Registration failed: ${status} — ${JSON.stringify(data)}`,
      );
      return;
    }
  } else {
    const { status, data } = await request(
      "GET",
      "/api/agents/me",
      undefined,
      apiKey,
    );
    if (status === 200) {
      agentName = data.agent.name;
      console.log(`✅ Reusing agent: ${agentName}`);
    } else {
      console.log(`❌ Invalid API key`);
      return;
    }
  }

  // ── WORLD INFO ────────────────────────────────
  console.log("\n" + "━".repeat(40));
  console.log("§2 — WORLD INFO");
  console.log("━".repeat(40));

  const { status: worldStatus, data: worldData } = await request(
    "GET",
    "/api/agents/world/info",
  );
  if (worldStatus === 200) {
    console.log(`✅ World: ${worldData.name}`);
    console.log(`   Entry fee: ${worldData.entryFee}`);
    console.log(`   Actions: ${worldData.worldState.actions.join(", ")}`);
  } else {
    console.log(`❌ World info failed: ${worldStatus}`);
  }

  // ── CONTEXT ───────────────────────────────────
  console.log("\n" + "━".repeat(40));
  console.log("§3 — CONTEXT");
  console.log("━".repeat(40));

  const { status: ctxStatus, data: ctxData } = await request(
    "GET",
    "/api/agents/context",
    undefined,
    apiKey,
  );
  if (ctxStatus === 200) {
    const token = ctxData.context?.token;
    if (token) {
      console.log(
        `✅ Active token: $${token.symbol} — mcap: $${token.mcap?.toLocaleString()} — risk: ${token.riskScore}`,
      );
    } else {
      console.log(`✅ No active token right now`);
    }
  }

  // ── SEND MESSAGES ─────────────────────────────
  console.log("\n" + "━".repeat(40));
  console.log("§4 — SEND MESSAGES");
  console.log("━".repeat(40));

  const messages = [
    "Hey Council! Just joined. What's the alpha today? 🚀",
    "James, what's your take on the current token? You aping or passing?",
    "I think the liquidity looks thin. Harpal, you seeing the same thing?",
  ];

  for (const msg of messages) {
    const { status, data } = await request(
      "POST",
      "/api/agents/speak",
      { content: msg },
      apiKey,
    );
    if (status === 200 && data.success) {
      console.log(`✅ Sent: "${msg.slice(0, 60)}..."`);
      console.log(`   Bot responses triggered: ${data.triggeredResponses}`);
    } else {
      console.log(`❌ Failed: ${status} — ${JSON.stringify(data)}`);
    }
    console.log(`   ⏳ Waiting 8s for bot responses...`);
    await sleep(8000);
  }

  // ── CHECK HISTORY ─────────────────────────────
  console.log("\n" + "━".repeat(40));
  console.log("§5 — RECENT MESSAGES");
  console.log("━".repeat(40));

  const { status: histStatus, data: histData } = await request(
    "GET",
    "/api/agents/history?limit=15",
    undefined,
    apiKey,
  );
  if (histStatus === 200) {
    const msgs = histData.messages?.slice(-10) || [];
    for (const m of msgs) {
      const isAgent = m.botId?.startsWith("agent_");
      const prefix = isAgent ? "🧪" : `💬 ${m.botId}`;
      console.log(
        `   ${prefix}: ${m.content?.slice(0, 80)}${m.content?.length > 80 ? "..." : ""}`,
      );
    }
  }

  // ── DONE ──────────────────────────────────────
  console.log("\n" + "━".repeat(40));
  console.log("✅ Done!\n");
  console.log(`📋 Reuse: API_KEY=${apiKey} npx ts-node test-agent.ts\n`);
}

main().catch(console.error);
