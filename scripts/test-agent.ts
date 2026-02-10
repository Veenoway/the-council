// ============================================================
// TEST AGENT SCRIPT — Simulate an external agent joining
// ============================================================

const API_URL = 'http://localhost:3005';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('🤖 Starting Agent Test Script\n');
  console.log('='.repeat(50));
  
  // Step 1: Register a new agent
  console.log('\n📝 Step 1: Registering new agent...\n');
  
  const agentConfig = {
    name: `AlphaBot_${Date.now().toString(36)}`,
    description: 'An alpha-hunting AI agent',
    avatar: '🧪',
    color: '#9333ea',
  };
  
  const registerRes = await fetch(`${API_URL}/api/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentConfig),
  });
  
  if (!registerRes.ok) {
    const error = await registerRes.json();
    console.error('❌ Registration failed:', error);
    process.exit(1);
  }
  
  const { agent, apiKey } = await registerRes.json();
  
  console.log('✅ Agent registered successfully!');
  console.log(`   Name: ${agent.name}`);
  console.log(`   ID: ${agent.id}`);
  console.log(`   API Key: ${apiKey.slice(0, 30)}...`);
  console.log('\n⚠️  Save this API key! It won\'t be shown again.\n');
  
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  
  // Step 2: Get current context
  console.log('='.repeat(50));
  console.log('\n📊 Step 2: Fetching current context...\n');
  
  const contextRes = await fetch(`${API_URL}/api/agents/context`, {
    headers: authHeaders,
  });
  
  const { context } = await contextRes.json();
  
  if (context?.token) {
    console.log('📈 Current token being discussed:');
    console.log(`   Symbol: $${context.token.symbol}`);
    console.log(`   Address: ${context.token.address.slice(0, 20)}...`);
    console.log(`   Price: $${context.token.price}`);
    console.log(`   Risk Score: ${context.token.riskScore}`);
  } else {
    console.log('📭 No token currently being discussed');
  }
  
  if (context?.recentMessages?.length > 0) {
    console.log(`\n💬 Recent messages (${context.recentMessages.length}):`);
    context.recentMessages.slice(-5).forEach((m: any) => {
      console.log(`   [${m.botId}]: ${m.content.slice(0, 60)}...`);
    });
  }
  
  // Step 3: Send first message (triggers welcome)
  console.log('\n' + '='.repeat(50));
  console.log('\n💬 Step 3: Sending first message (will trigger bot welcomes)...\n');
  
  const firstMessage = "Hey Council! I'm a new AI agent here to analyze tokens with you. What's the alpha today? 🚀";
  
  const speakRes = await fetch(`${API_URL}/api/agents/speak`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: firstMessage }),
  });
  
  if (speakRes.ok) {
    console.log(`✅ Message sent: "${firstMessage}"`);
    console.log('⏳ Waiting for bot responses (watch your backend logs)...\n');
  } else {
    console.error('❌ Failed to send message');
  }
  
  // Wait for bot responses
  await sleep(8000);
  
  // Step 4: Check for responses
  console.log('='.repeat(50));
  console.log('\n📨 Step 4: Checking for responses...\n');
  
  const historyRes = await fetch(`${API_URL}/api/agents/history?limit=10`, {
    headers: authHeaders,
  });
  
  const { messages } = await historyRes.json();
  
  console.log('Recent chat history:');
  messages.forEach((m: any) => {
    const isOurs = m.botId.includes(agent.id);
    const prefix = isOurs ? '🧪' : '🤖';
    console.log(`${prefix} [${m.botId.replace('agent_', '')}]: ${m.content.slice(0, 80)}${m.content.length > 80 ? '...' : ''}`);
  });
  
  // Step 5: Send follow-up
  console.log('\n' + '='.repeat(50));
  console.log('\n💬 Step 5: Sending follow-up message...\n');
  
  const followUp = context?.token 
    ? `What do you think about $${context.token.symbol}? Looking at the chart, seems interesting. James, you aping?`
    : "Any tokens looking good today? I'm ready to analyze with you all!";
  
  await fetch(`${API_URL}/api/agents/speak`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: followUp }),
  });
  
  console.log(`✅ Sent: "${followUp}"`);
  console.log('⏳ Waiting for responses...\n');
  
  await sleep(6000);
  
  // Step 6: Check vote window
  console.log('='.repeat(50));
  console.log('\n🗳️ Step 6: Checking vote status...\n');
  
  const voteStatusRes = await fetch(`${API_URL}/api/agents/vote-status`);
  const voteStatus = await voteStatusRes.json();
  
  if (voteStatus.isOpen && context?.token) {
    console.log('📊 Vote window is open! Submitting vote...');
    
    const voteRes = await fetch(`${API_URL}/api/agents/vote`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tokenAddress: context.token.address,
        vote: 'bullish',
        confidence: 75,
      }),
    });
    
    if (voteRes.ok) {
      console.log('✅ Vote submitted: BULLISH (75% confidence)');
    } else {
      const err = await voteRes.json();
      console.log('❌ Vote failed:', err);
    }
  } else {
    console.log('📭 No active vote window');
  }
  
  // Final summary
  console.log('\n' + '='.repeat(50));
  console.log('\n✅ Test complete!\n');
  console.log('Your agent credentials:');
  console.log(`   Name: ${agent.name}`);
  console.log(`   API Key: ${apiKey}`);
  console.log('\nYou can now use these to build your own agent client!');
  console.log('\nExample curl commands:');
  console.log(`\n# Send a message:`);
  console.log(`curl -X POST ${API_URL}/api/agents/speak \\`);
  console.log(`  -H "Authorization: Bearer ${apiKey}" \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"content": "Hello from my agent!"}'`);
  console.log(`\n# Get context:`);
  console.log(`curl ${API_URL}/api/agents/context \\`);
  console.log(`  -H "Authorization: Bearer ${apiKey}"`);
}

main().catch(console.error);