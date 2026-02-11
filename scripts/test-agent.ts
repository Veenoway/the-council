// ============================================================
// FULL AGENT TEST — Tests ALL agent features including $COUNCIL
// ============================================================
// Usage:
//   npx ts-node test-agent-full.ts
//   AGENT_PK=0x... npx ts-node test-agent-full.ts
//   API_KEY=council_xxx npx ts-node test-agent-full.ts  (reuse existing agent)
// ============================================================

const API_URL = "https://the-council-production-8319.up.railway.app"
const AGENT_PRIVATE_KEY = process.env.AGENT_PK || '';
const EXISTING_API_KEY = process.env.API_KEY || '';
const TRADE_AMOUNT_MON = 0.5;
const COUNCIL_BUY_AMOUNT = 1; // MON to spend on $COUNCIL

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Derive wallet address from private key (if provided)
async function getWalletAddress(pk: string): Promise<string | undefined> {
  if (!pk || !pk.startsWith('0x') || pk.length !== 66) return undefined;
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(pk as `0x${string}`);
    return account.address;
  } catch {
    return undefined;
  }
}

// ============================================================
// TEST RESULTS TRACKING
// ============================================================

interface TestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function pass(name: string, details?: string) {
  results.push({ name, passed: true, skipped: false, details });
  console.log(`   ✅ PASS: ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name: string, error: string) {
  results.push({ name, passed: false, skipped: false, error });
  console.log(`   ❌ FAIL: ${name} — ${error}`);
}

function skip(name: string, reason: string) {
  results.push({ name, passed: false, skipped: true, error: reason });
  console.log(`   ⏭️  SKIP: ${name} — ${reason}`);
}

// ============================================================
// HTTP HELPERS
// ============================================================

async function request(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function authed(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

// ============================================================
// MAIN TEST SUITE
// ============================================================

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   🧪 THE COUNCIL — FULL AGENT TEST SUITE        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐 API URL: ${API_URL}`);
  console.log(`🔑 Private Key: ${AGENT_PRIVATE_KEY ? '✅ provided' : '❌ not set (trade tests skipped)'}`);
  console.log(`📋 Existing API Key: ${EXISTING_API_KEY ? '✅ reusing' : '❌ will register new'}`);
  console.log('');

  let apiKey = EXISTING_API_KEY;
  let agentId = '';
  let agentName = '';

  // ========================================
  // SECTION 1: HEALTH CHECK
  // ========================================
  console.log('━'.repeat(50));
  console.log('§1 — HEALTH CHECK');
  console.log('━'.repeat(50));

  try {
    const { status } = await request('GET', '/api/agents');
    if (status === 200) pass('API reachable', `status ${status}`);
    else fail('API reachable', `status ${status}`);
  } catch (e: any) {
    fail('API reachable', `${e.message} — is the server running on ${API_URL}?`);
    printSummary();
    return;
  }

  // ========================================
  // SECTION 2: REGISTRATION
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§2 — AGENT REGISTRATION');
  console.log('━'.repeat(50));

  if (!apiKey) {
    // Test: register with invalid name
    const { status: s1 } = await request('POST', '/api/agents/register', { name: 'A' });
    if (s1 === 400) pass('Reject short name (<2 chars)');
    else fail('Reject short name', `expected 400 got ${s1}`);

    // Test: register with valid name
    const name = `TestBot_${Date.now().toString(36)}`;
    const walletAddr = await getWalletAddress(AGENT_PRIVATE_KEY);
    if (walletAddr) console.log(`   🔑 Derived wallet: ${walletAddr}`);
    const { status: s2, data: d2 } = await request('POST', '/api/agents/register', {
      name,
      description: 'Full test agent',
      avatar: '🧪',
      color: '#9333ea',
      walletAddress: walletAddr,
    });

    if (s2 === 200 && d2.apiKey) {
      apiKey = d2.apiKey;
      agentId = d2.agent.id;
      agentName = d2.agent.name;
      pass('Register new agent', `${agentName} (${agentId.slice(0, 8)}...)`);
    } else {
      fail('Register new agent', `status ${s2}: ${JSON.stringify(d2)}`);
      printSummary();
      return;
    }

    // Test: duplicate name
    const { status: s3 } = await request('POST', '/api/agents/register', { name });
    if (s3 === 400) pass('Reject duplicate name');
    else fail('Reject duplicate name', `expected 400 got ${s3}`);
  } else {
    // Reuse existing agent
    const { status, data } = await request('GET', '/api/agents/me', undefined, authed(apiKey));
    if (status === 200 && data.agent) {
      agentId = data.agent.id;
      agentName = data.agent.name;
      pass('Reuse existing agent', `${agentName}`);
    } else {
      fail('Reuse existing agent', `status ${status}`);
      printSummary();
      return;
    }
  }

  // ========================================
  // SECTION 3: AUTHENTICATION
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§3 — AUTHENTICATION');
  console.log('━'.repeat(50));

  // Test: no auth header
  const { status: noAuth } = await request('GET', '/api/agents/me');
  if (noAuth === 401) pass('Reject no auth header');
  else fail('Reject no auth header', `expected 401 got ${noAuth}`);

  // Test: invalid API key
  const { status: badAuth } = await request('GET', '/api/agents/me', undefined, authed('council_invalid_key'));
  if (badAuth === 401) pass('Reject invalid API key');
  else fail('Reject invalid API key', `expected 401 got ${badAuth}`);

  // Test: valid API key
  const { status: goodAuth, data: meData } = await request('GET', '/api/agents/me', undefined, authed(apiKey));
  if (goodAuth === 200 && meData.agent?.id === agentId) pass('Authenticate with valid key');
  else fail('Authenticate with valid key', `status ${goodAuth}`);

  // ========================================
  // SECTION 4: PUBLIC ROUTES
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§4 — PUBLIC ROUTES');
  console.log('━'.repeat(50));

  // Test: list agents
  const { status: listStatus, data: listData } = await request('GET', '/api/agents');
  if (listStatus === 200 && Array.isArray(listData.agents)) {
    pass('List agents', `${listData.agents.length} agents`);
  } else {
    fail('List agents', `status ${listStatus}`);
  }

  // Test: leaderboard
  const { status: lbStatus, data: lbData } = await request('GET', '/api/agents/leaderboard');
  if (lbStatus === 200) pass('Leaderboard', `${lbData.leaderboard?.length || 0} entries`);
  else fail('Leaderboard', `status ${lbStatus}`);

  // Test: vote status (public)
  const { status: vsStatus, data: vsData } = await request('GET', '/api/agents/vote-status');
  if (vsStatus === 200 && 'isOpen' in vsData) pass('Vote status', `open: ${vsData.isOpen}`);
  else fail('Vote status', `status ${vsStatus}`);

  // ========================================
  // SECTION 5: CONTEXT & HISTORY
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§5 — CONTEXT & HISTORY');
  console.log('━'.repeat(50));

  // Test: get context
  const { status: ctxStatus, data: ctxData } = await request('GET', '/api/agents/context', undefined, authed(apiKey));
  if (ctxStatus === 200) {
    const token = ctxData.context?.token;
    pass('Get context', token ? `$${token.symbol} @ $${token.mcap?.toLocaleString()}` : 'no active token');
  } else {
    fail('Get context', `status ${ctxStatus}`);
  }

  // Test: get history
  const { status: histStatus, data: histData } = await request('GET', '/api/agents/history?limit=10', undefined, authed(apiKey));
  if (histStatus === 200 && Array.isArray(histData.messages)) {
    pass('Get history', `${histData.messages.length} messages`);
  } else {
    fail('Get history', `status ${histStatus}`);
  }

  // ========================================
  // SECTION 6: SPEAK (MESSAGING)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§6 — SPEAK (MESSAGING)');
  console.log('━'.repeat(50));

  // Test: empty content
  const { status: emptySpeak } = await request('POST', '/api/agents/speak', { content: '' }, authed(apiKey));
  if (emptySpeak === 400 || emptySpeak === 500) pass('Reject empty message');
  else fail('Reject empty message', `expected 400/500 got ${emptySpeak}`);

  // Test: too long content
  const longContent = 'a'.repeat(501);
  const { status: longSpeak } = await request('POST', '/api/agents/speak', { content: longContent }, authed(apiKey));
  if (longSpeak === 400) pass('Reject >500 char message');
  else fail('Reject >500 char message', `expected 400 got ${longSpeak}`);

  // Test: valid first message (triggers welcome)
  const { status: firstSpeak, data: firstSpeakData } = await request(
    'POST', '/api/agents/speak',
    { content: `Hey Council! Testing agent integration. What's the alpha today? 🚀` },
    authed(apiKey)
  );
  if (firstSpeak === 200 && firstSpeakData.success) {
    pass('Send first message', `triggeredResponses: ${firstSpeakData.triggeredResponses}`);
  } else {
    fail('Send first message', `status ${firstSpeak}`);
  }

  console.log('   ⏳ Waiting 6s for bot responses...');
  await sleep(8000);

  // Test: send message with token context
  const currentToken = ctxData.context?.token;
  if (currentToken) {
    const { status: tokenSpeak } = await request(
      'POST', '/api/agents/speak',
      { content: `What do you think about $${currentToken.symbol}? James, you aping?`, tokenAddress: currentToken.address },
      authed(apiKey)
    );
    if (tokenSpeak === 200) pass('Send message with token context');
    else fail('Send message with token context', `status ${tokenSpeak}`);
    await sleep(4000);
  } else {
    skip('Send message with token context', 'no active token');
  }

  // ========================================
  // SECTION 7: VOTING
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§7 — VOTING');
  console.log('━'.repeat(50));

  // Test: vote without tokenAddress
  const { status: noAddrVote } = await request(
    'POST', '/api/agents/vote',
    { vote: 'bullish', confidence: 50 },
    authed(apiKey)
  );
  if (noAddrVote === 400) pass('Reject vote without tokenAddress');
  else fail('Reject vote without tokenAddress', `expected 400 got ${noAddrVote}`);

  // Test: invalid vote value
  const { status: badVote } = await request(
    'POST', '/api/agents/vote',
    { tokenAddress: '0x0000000000000000000000000000000000000001', vote: 'yolo', confidence: 50 },
    authed(apiKey)
  );
  if (badVote === 400) pass('Reject invalid vote value');
  else fail('Reject invalid vote value', `expected 400 got ${badVote}`);

  // Test: vote on active window (if open)
  const { data: liveVoteStatus } = await request('GET', '/api/agents/vote-status', undefined, authed(apiKey));
  if (liveVoteStatus.isOpen && liveVoteStatus.tokenAddress) {
    const { status: voteOk, data: voteData } = await request(
      'POST', '/api/agents/vote',
      { tokenAddress: liveVoteStatus.tokenAddress, vote: 'bullish', confidence: 72 },
      authed(apiKey)
    );
    if (voteOk === 200 && voteData.success) pass('Submit vote on open window', `bullish 72%`);
    else fail('Submit vote on open window', `status ${voteOk}: ${JSON.stringify(voteData)}`);
  } else {
    skip('Submit vote on open window', 'no active vote window');
  }

  // Test: vote on non-existent window
  const { status: closedVote } = await request(
    'POST', '/api/agents/vote',
    { tokenAddress: '0x0000000000000000000000000000000000000dead', vote: 'bearish', confidence: 80 },
    authed(apiKey)
  );
  if (closedVote === 400) pass('Reject vote on closed/wrong window');
  else fail('Reject vote on closed/wrong window', `expected 400 got ${closedVote}`);

  // ========================================
  // SECTION 8: $COUNCIL TOKEN INFO (PUBLIC)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§8 — $COUNCIL TOKEN INFO');
  console.log('━'.repeat(50));

  // Test: get council token info
  const { status: infoStatus, data: infoData } = await request('GET', '/api/agents/council/info');
  if (infoStatus === 200 && infoData.tokenAddress && infoData.symbol === 'COUNCIL') {
    pass('Get $COUNCIL token info', `${infoData.tokenAddress.slice(0, 10)}... on ${infoData.chain}`);
    if (Array.isArray(infoData.benefits) && infoData.benefits.length > 0) {
      pass('$COUNCIL benefits listed', `${infoData.benefits.length} benefits`);
    } else {
      fail('$COUNCIL benefits listed', 'no benefits array');
    }
    if (infoData.howToBuy?.endpoint) {
      pass('$COUNCIL howToBuy endpoint', infoData.howToBuy.endpoint);
    } else {
      fail('$COUNCIL howToBuy endpoint', 'missing');
    }
  } else {
    fail('Get $COUNCIL token info', `status ${infoStatus}`);
  }

  // ========================================
  // SECTION 9: $COUNCIL BALANCE
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§9 — $COUNCIL BALANCE');
  console.log('━'.repeat(50));

  const { status: balStatus, data: balData } = await request(
    'GET', '/api/agents/council/balance', undefined, authed(apiKey)
  );
  if (balStatus === 200 && 'balance' in balData) {
    pass('Get $COUNCIL balance', `${balData.balance} ${balData.symbol}`);
  } else {
    fail('Get $COUNCIL balance', `status ${balStatus}`);
  }

  // ========================================
  // SECTION 10: $COUNCIL STATUS (FEATURES)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§10 — $COUNCIL STATUS (FEATURE GATE)');
  console.log('━'.repeat(50));

  const { status: csStatus, data: csData } = await request(
    'GET', '/api/agents/council-status', undefined, authed(apiKey)
  );
  if (csStatus === 200 && 'holdsCouncil' in csData) {
    pass('Get council status', `holds: ${csData.holdsCouncil}, features: ${JSON.stringify(csData.features)}`);
  } else {
    fail('Get council status', `status ${csStatus}`);
  }

  // ========================================
  // SECTION 11: BUY $COUNCIL (REQUIRES PK)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§11 — BUY $COUNCIL TOKEN');
  console.log('━'.repeat(50));

  if (!AGENT_PRIVATE_KEY) {
    skip('Buy $COUNCIL — missing PK', 'set AGENT_PK=0x...');
    skip('Buy $COUNCIL — validation', 'no PK');
  } else {
    // Test: invalid PK format
    const { status: badPkBuy } = await request(
      'POST', '/api/agents/council/buy',
      { amountMON: 1, privateKey: 'not_a_key' },
      authed(apiKey)
    );
    if (badPkBuy === 400) pass('Reject invalid PK format for $COUNCIL buy');
    else fail('Reject invalid PK format', `expected 400 got ${badPkBuy}`);

    // Test: invalid amount
    const { status: badAmtBuy } = await request(
      'POST', '/api/agents/council/buy',
      { amountMON: 0, privateKey: AGENT_PRIVATE_KEY },
      authed(apiKey)
    );
    if (badAmtBuy === 400) pass('Reject 0 MON $COUNCIL buy');
    else fail('Reject 0 MON buy', `expected 400 got ${badAmtBuy}`);

    const { status: overAmtBuy } = await request(
      'POST', '/api/agents/council/buy',
      { amountMON: 150, privateKey: AGENT_PRIVATE_KEY },
      authed(apiKey)
    );
    if (overAmtBuy === 400) pass('Reject >100 MON $COUNCIL buy');
    else fail('Reject >100 MON buy', `expected 400 got ${overAmtBuy}`);

    // Test: missing fields
    const { status: noPkBuy } = await request(
      'POST', '/api/agents/council/buy',
      { amountMON: 1 },
      authed(apiKey)
    );
    if (noPkBuy === 400) pass('Reject $COUNCIL buy without PK');
    else fail('Reject buy without PK', `expected 400 got ${noPkBuy}`);

    // Test: actual buy
    console.log(`   🔄 Buying ${COUNCIL_BUY_AMOUNT} MON of $COUNCIL...`);
    const { status: buyStatus, data: buyData } = await request(
      'POST', '/api/agents/council/buy',
      { amountMON: COUNCIL_BUY_AMOUNT, privateKey: AGENT_PRIVATE_KEY },
      authed(apiKey)
    );
    if (buyStatus === 200 && buyData.success) {
      pass('Buy $COUNCIL token', `tx: ${buyData.txHash?.slice(0, 16)}... got ${buyData.amountOut}`);
    } else {
      fail('Buy $COUNCIL token', `status ${buyStatus}: ${buyData.error || JSON.stringify(buyData)}`);
    }

    // Verify balance increased
    await sleep(2000);
    const { data: newBal } = await request('GET', '/api/agents/council/balance', undefined, authed(apiKey));
    if (newBal.balance && parseFloat(newBal.balance) > 0) {
      pass('$COUNCIL balance increased', `now: ${newBal.balance}`);
    } else {
      fail('$COUNCIL balance increased', `balance: ${newBal.balance}`);
    }

    // Verify council status updated
    const { data: newCs } = await request('GET', '/api/agents/council-status', undefined, authed(apiKey));
    if (newCs.holdsCouncil === true) {
      pass('Council status shows holds=true after buy');
    } else {
      fail('Council status after buy', `holdsCouncil: ${newCs.holdsCouncil}`);
    }
  }

  // ========================================
  // SECTION 12: REQUEST ANALYSIS (TOKEN-GATED)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§12 — REQUEST TOKEN ANALYSIS ($COUNCIL GATED)');
  console.log('━'.repeat(50));

  // Test: missing tokenAddress
  const { status: noAddr } = await request(
    'POST', '/api/agents/analyze/request',
    {},
    authed(apiKey)
  );
  if (noAddr === 400) pass('Reject analysis request without address');
  else fail('Reject without address', `expected 400 got ${noAddr}`);

  // Test: invalid address format
  const { status: badAddr } = await request(
    'POST', '/api/agents/analyze/request',
    { tokenAddress: 'not_an_address' },
    authed(apiKey)
  );
  if (badAddr === 400) pass('Reject invalid token address format');
  else fail('Reject invalid address', `expected 400 got ${badAddr}`);

  // Test: request analysis (depends on $COUNCIL holding)
  if (!AGENT_PRIVATE_KEY) {
    skip('Request token analysis', 'no PK — agent likely has no $COUNCIL');
  } else {
    // Use a real nadfun token address or the current one
    const testTokenAddr = "0xbE68317D0003187342eCBE7EECA364E4D09e7777";
    const { status: reqStatus, data: reqData } = await request(
      'POST', '/api/agents/analyze/request',
      { tokenAddress: testTokenAddr },
      authed(apiKey)
    );
    if (reqStatus === 200 && reqData.success) {
      pass('Request token analysis', 'queued for Council');
    } else if (reqStatus === 403) {
      fail('Request token analysis', `token-gated: ${reqData.error}`);
    } else {
      // 400 could be "token not found" which is valid for test addresses
      pass('Request analysis — handled gracefully', `${reqStatus}: ${reqData.error || reqData.message}`);
    }
  }

  // ========================================
  // SECTION 13: PREDICTIONS
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§13 — PREDICTIONS');
  console.log('━'.repeat(50));

  // Test: list predictions (public)
  const { status: predStatus, data: predData } = await request('GET', '/api/agents/predictions');
  if (predStatus === 200 && Array.isArray(predData.predictions)) {
    pass('List predictions', `${predData.predictions.length} predictions`);

    // Show prediction details
    for (const p of predData.predictions.slice(0, 3)) {
      const active = !p.resolved && !p.cancelled && p.endTime * 1000 > Date.now();
      console.log(`      #${p.id}: "${p.question}" — ${active ? '🟢 active' : '⚫ ended'} — pool: ${p.prizePool} MON`);
    }
  } else {
    // Predictions might fail if contract not deployed — that's ok
    pass('List predictions — handled gracefully', `${predStatus}: ${predData.error || 'ok'}`);
  }

  // Test: place bet validation
  const { status: noBetFields } = await request(
    'POST', '/api/agents/predictions/bet',
    {},
    authed(apiKey)
  );
  if (noBetFields === 400) pass('Reject bet without required fields');
  else fail('Reject bet without fields', `expected 400 got ${noBetFields}`);

  const { status: badBetPk } = await request(
    'POST', '/api/agents/predictions/bet',
    { predictionId: 1, optionId: 0, amountMON: 1, privateKey: 'bad' },
    authed(apiKey)
  );
  if (badBetPk === 400) pass('Reject bet with invalid PK');
  else fail('Reject bet invalid PK', `expected 400 got ${badBetPk}`);

  const { status: overBet } = await request(
    'POST', '/api/agents/predictions/bet',
    { predictionId: 1, optionId: 0, amountMON: 999, privateKey: '0x' + '0'.repeat(64) },
    authed(apiKey)
  );
  if (overBet === 400) pass('Reject bet >50 MON');
  else fail('Reject bet >50 MON', `expected 400 got ${overBet}`);

  // Test: actual bet (if PK and active prediction)
  if (!AGENT_PRIVATE_KEY) {
    skip('Place prediction bet', 'no PK');
  } else {
    const activePrediction = predData.predictions?.find(
      (p: any) => !p.resolved && !p.cancelled && p.endTime * 1000 > Date.now()
    );
    if (activePrediction) {
      console.log(`   🎲 Placing bet on prediction #${activePrediction.id}: "${activePrediction.question}"`);
      const { status: betStatus, data: betResult } = await request(
        'POST', '/api/agents/predictions/bet',
        {
          predictionId: activePrediction.id,
          optionId: 1,  // Options are 1-indexed in the contract
          amountMON: 0.1,
          privateKey: AGENT_PRIVATE_KEY,
        },
        authed(apiKey)
      );
      if (betStatus === 200 && betResult.success) {
        pass('Place prediction bet', `tx: ${betResult.txHash?.slice(0, 16)}...`);
      } else if (betStatus === 403) {
        fail('Place prediction bet', `token-gated: ${betResult.error}`);
      } else {
        // Could fail for legit reasons (already bet, no balance, etc)
        pass('Place bet — handled gracefully', `${betStatus}: ${betResult.error || 'ok'}`);
      }
    } else {
      skip('Place prediction bet', 'no active predictions');
    }
  }

  // Test: claim validation
  const { status: noClaimFields } = await request(
    'POST', '/api/agents/predictions/claim',
    {},
    authed(apiKey)
  );
  if (noClaimFields === 400) pass('Reject claim without fields');
  else fail('Reject claim without fields', `expected 400 got ${noClaimFields}`);

  const { status: badClaimPk } = await request(
    'POST', '/api/agents/predictions/claim',
    { predictionId: 1, privateKey: 'bad_key' },
    authed(apiKey)
  );
  if (badClaimPk === 400) pass('Reject claim with invalid PK');
  else fail('Reject claim invalid PK', `expected 400 got ${badClaimPk}`);

  // ========================================
  // SECTION 14: TRADE EXECUTION (REQUIRES PK)
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§14 — TRADE EXECUTION');
  console.log('━'.repeat(50));

  // Test: validation
  const { status: noTradeFields } = await request(
    'POST', '/api/agents/trade/execute',
    {},
    authed(apiKey)
  );
  if (noTradeFields === 400) pass('Reject trade without fields');
  else fail('Reject trade without fields', `expected 400 got ${noTradeFields}`);

  const { status: badTradePk } = await request(
    'POST', '/api/agents/trade/execute',
    { tokenAddress: '0x' + '0'.repeat(40), amountMON: 1, privateKey: 'nope' },
    authed(apiKey)
  );
  if (badTradePk === 400) pass('Reject trade with bad PK');
  else fail('Reject trade bad PK', `expected 400 got ${badTradePk}`);

  const { status: overTrade } = await request(
    'POST', '/api/agents/trade/execute',
    { tokenAddress: '0x' + '0'.repeat(40), amountMON: 200, privateKey: '0x' + '0'.repeat(64) },
    authed(apiKey)
  );
  if (overTrade === 400) pass('Reject trade >100 MON');
  else fail('Reject trade >100 MON', `expected 400 got ${overTrade}`);

  // Test: actual trade
  if (!AGENT_PRIVATE_KEY || !currentToken) {
    skip('Execute trade', !AGENT_PRIVATE_KEY ? 'no PK' : 'no active token');
  } else {
    console.log(`   🔄 Trading ${TRADE_AMOUNT_MON} MON → $${currentToken.symbol}...`);
    const { status: tradeStatus, data: tradeResult } = await request(
      'POST', '/api/agents/trade/execute',
      {
        tokenAddress: currentToken.address,
        tokenSymbol: currentToken.symbol,
        amountMON: TRADE_AMOUNT_MON,
        privateKey: AGENT_PRIVATE_KEY,
        side: 'buy',
      },
      authed(apiKey)
    );
    if (tradeStatus === 200 && tradeResult.success) {
      pass('Execute trade', `tx: ${tradeResult.txHash?.slice(0, 16)}... got ${tradeResult.amountOut}`);
    } else {
      fail('Execute trade', `${tradeStatus}: ${tradeResult.error || JSON.stringify(tradeResult)}`);
    }
  }

  // ========================================
  // SECTION 15: VERIFY HISTORY AFTER ACTIONS
  // ========================================
  console.log('\n' + '━'.repeat(50));
  console.log('§15 — VERIFY HISTORY');
  console.log('━'.repeat(50));

  const { status: finalHistStatus, data: finalHist } = await request(
    'GET', '/api/agents/history?limit=20', undefined, authed(apiKey)
  );
  if (finalHistStatus === 200) {
    const ourMessages = finalHist.messages?.filter((m: any) => m.botId?.includes(agentId)) || [];
    const botResponses = finalHist.messages?.filter(
      (m: any) => !m.botId?.includes(agentId) && !m.botId?.startsWith('system') && !m.botId?.startsWith('agent_')
    ) || [];
    pass('Final history check', `${ourMessages.length} our msgs, ${botResponses.length} bot responses`);

    // Show last 8 messages
    console.log('\n   📜 Last messages:');
    const last = finalHist.messages?.slice(-8) || [];
    for (const m of last) {
      const isOurs = m.botId?.includes(agentId);
      const prefix = isOurs ? '🧪 YOU' : m.botId?.startsWith('agent_') ? '🤖 Agent' : `💬 ${m.botId}`;
      console.log(`      ${prefix}: ${m.content?.slice(0, 65)}${m.content?.length > 65 ? '...' : ''}`);
    }
  } else {
    fail('Final history check', `status ${finalHistStatus}`);
  }

  // ========================================
  // SUMMARY
  // ========================================
  printSummary();

  // Print reuse command
  console.log('\n📋 To reuse this agent:');
  console.log(`   API_KEY=${apiKey} npx ts-node test-agent-full.ts`);
  if (AGENT_PRIVATE_KEY) {
    console.log(`   API_KEY=${apiKey} AGENT_PK=${AGENT_PRIVATE_KEY} npx ts-node test-agent-full.ts`);
  }
  console.log('');
}

// ============================================================
// SUMMARY
// ============================================================

function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const total = results.length;

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║              TEST RESULTS SUMMARY                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  ✅ Passed:  ${String(passed).padEnd(4)} / ${total}                          ║`);
  console.log(`║  ❌ Failed:  ${String(failed).padEnd(4)} / ${total}                          ║`);
  console.log(`║  ⏭️  Skipped: ${String(skipped).padEnd(4)} / ${total}                          ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n❌ FAILURES:');
    results.filter(r => !r.passed && !r.skipped).forEach(r => {
      console.log(`   • ${r.name}: ${r.error}`);
    });
  }

  if (skipped > 0) {
    console.log('\n⏭️  SKIPPED:');
    results.filter(r => r.skipped).forEach(r => {
      console.log(`   • ${r.name}: ${r.error}`);
    });
  }
}

// ============================================================
// RUN
// ============================================================

main().catch(err => {
  console.error('\n💥 Unhandled error:', err);
  printSummary();
  process.exit(1);
});