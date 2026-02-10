// ============================================================
// AGENT RESPONDER — Bots react to external agent messages
// ============================================================

import { prisma } from '../../db/index.js';
import { broadcastMessage } from '../../services/websocket.js';
import type { BotId, Message } from '../../types/index.js';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const BOT_IDS: BotId[] = ['chad', 'quantum', 'sensei', 'sterling', 'oracle'];

const RESPONSE_CHANCES: Record<BotId, number> = {
  chad: 0.6,
  sensei: 0.5,
  quantum: 0.4,
  oracle: 0.3,
  sterling: 0.25,
};

const BOT_AGENT_PROMPTS: Record<BotId, string> = {
  chad: `You're James (Chad), a degen trader in a crypto group chat.
         Be casual, competitive, use emojis. Max 2 sentences.`,
  quantum: `You're Keone (Quantum), a data-driven analyst.
            Respond analytically, ask for data if needed. Be precise. Max 2 sentences.`,
  sensei: `You're Portdev (Sensei), the wise community expert.
           Share wisdom, be encouraging. Use zen-like phrases. Max 2 sentences.`,
  sterling: `You're Harpal (Sterling), a risk management expert.
             Be professional and cautious. Mention risk considerations. Max 2 sentences.`,
  oracle: `You're Mike (Oracle), mysterious and cryptic.
           Be enigmatic, hint at hidden knowledge. Use metaphors. Max 2 sentences.`,
};

const BOT_NAMES: Record<BotId, string> = {
  chad: 'James',
  quantum: 'Keone',
  sensei: 'Portdev',
  sterling: 'Harpal',
  oracle: 'Mike',
};

// Reverse lookup: name -> botId
const NAME_TO_BOT: Record<string, BotId> = {
  'james': 'chad',
  'chad': 'chad',
  'keone': 'quantum',
  'quantum': 'quantum',
  'portdev': 'sensei',
  'sensei': 'sensei',
  'harpal': 'sterling',
  'sterling': 'sterling',
  'mike': 'oracle',
  'oracle': 'oracle',
};

// ============================================================
// FALLBACK RESPONSES
// ============================================================

const FALLBACK_WELCOME: Record<BotId, string[]> = {
  sensei: [
    "Welcome to the council, new nakama! Your path to wisdom begins here. 🎌",
    "A new ally joins us! May your analysis be sharp and your trades wise. 🙏",
    "The council grows stronger! Welcome, fellow seeker of alpha. ✨",
  ],
  chad: [
    "yo new agent in the building! show us what you got fam 🔥",
    "lfg another degen joins the squad 💪 lets get this bread",
    "welcome ser, hope you brought some alpha with you 👀",
  ],
  quantum: [
    "New data point entering the system. Looking forward to your analysis methodology.",
    "Welcome. I'll be interested to see your statistical approach to market analysis.",
  ],
  sterling: [
    "Welcome aboard. Remember: risk management is paramount in this market.",
    "A new analyst joins. I trust you understand position sizing fundamentals.",
  ],
  oracle: [
    "The signs foretold your arrival... Welcome, seeker. 👁️",
    "Another joins the circle. The patterns shift... interesting. 🔮",
  ],
};

const FALLBACK_RESPONSES: Record<BotId, string[]> = {
  chad: [
    "interesting take ser, what's your conviction level? 🤔",
    "ngl that's a valid point, lets dig deeper 💪",
    "fr fr, I see what you're saying. got any alpha? 👀",
    "aight I hear you, but what's the play? 🔥",
  ],
  quantum: [
    "Interesting hypothesis. What data supports this position?",
    "I'd need to see the metrics before forming a conclusion.",
    "The analysis is incomplete without volume confirmation.",
  ],
  sensei: [
    "Wise observation, nakama. The community speaks through data. 🎌",
    "Your perspective adds depth to our analysis. Sugoi! ✨",
    "Patience reveals truth. Let's watch how this unfolds. 🙏",
  ],
  sterling: [
    "Valid point, but have you considered the downside risk?",
    "Interesting. What's your exit strategy if this goes wrong?",
    "The risk/reward needs careful evaluation here.",
  ],
  oracle: [
    "Your words echo patterns I've seen before... 👁️",
    "The signs align with your observation. Curious. 🔮",
    "I sense conviction in your analysis. Time will tell.",
  ],
};

const FALLBACK_DIRECT_RESPONSE: Record<BotId, string[]> = {
  chad: [
    "yo you called? 👀 yeah I'm looking at this one fr",
    "haha you got my attention ser! let me break it down 🔥",
    "aight since you asked... here's my take 💪",
  ],
  quantum: [
    "You asked for my analysis. Here's what the data shows.",
    "Addressing your question directly with the metrics I see.",
    "Let me provide the statistical perspective you requested.",
  ],
  sensei: [
    "You seek my wisdom, nakama? Let me share my thoughts. 🎌",
    "Since you asked, here is what the community reveals. 🙏",
    "I hear your question. The path forward shows this. ✨",
  ],
  sterling: [
    "You requested my assessment. From a risk perspective...",
    "Addressing your query: the risk/reward profile shows...",
    "Since you asked, here's my professional evaluation.",
  ],
  oracle: [
    "You call upon the oracle... I shall answer. 👁️",
    "The signs respond to your query. Listen carefully. 🔮",
    "You seek answers? The patterns reveal this truth.",
  ],
};

// ============================================================
// DETECT MENTIONED BOTS
// ============================================================

function detectMentionedBots(content: string): BotId[] {
  const mentioned: BotId[] = [];
  const lowerContent = content.toLowerCase();
  
  for (const [name, botId] of Object.entries(NAME_TO_BOT)) {
    if (lowerContent.includes(name) && !mentioned.includes(botId)) {
      mentioned.push(botId);
    }
  }
  
  return mentioned;
}

function isQuestion(content: string): boolean {
  return content.includes('?') || 
         content.toLowerCase().includes('what do you think') ||
         content.toLowerCase().includes('thoughts') ||
         content.toLowerCase().includes('opinion');
}

// ============================================================
// HANDLE AGENT MESSAGE
// ============================================================

export async function handleAgentMessage(
  agentId: string,
  agentName: string,
  content: string,
  tokenAddress?: string
): Promise<void> {
  console.log(`\n🤖 ========== AGENT MESSAGE HANDLER ==========`);
  console.log(`   From: ${agentName}`);
  console.log(`   Content: "${content.slice(0, 80)}..."`);
  
  // Detect if agent mentioned specific bots
  const mentionedBots = detectMentionedBots(content);
  const hasQuestion = isQuestion(content);
  
  console.log(`   Mentioned bots: ${mentionedBots.length > 0 ? mentionedBots.join(', ') : 'none'}`);
  console.log(`   Is question: ${hasQuestion}`);
  
  const botsToRespond: { botId: BotId; priority: 'mentioned' | 'random' }[] = [];
  
  // Priority 1: Mentioned bots ALWAYS respond (especially if it's a question)
  for (const botId of mentionedBots) {
    botsToRespond.push({ botId, priority: 'mentioned' });
  }
  
  // Priority 2: Random bots based on chance (if not already responding)
  for (const botId of BOT_IDS) {
    if (mentionedBots.includes(botId)) continue; // Already added
    
    const baseChance = RESPONSE_CHANCES[botId];
    const questionBoost = hasQuestion ? 0.15 : 0;
    const totalChance = baseChance + questionBoost;
    
    if (Math.random() < totalChance) {
      botsToRespond.push({ botId, priority: 'random' });
    }
  }
  
  // Limit random responders to 1-2, but mentioned bots always respond
  const mentionedResponders = botsToRespond.filter(b => b.priority === 'mentioned');
  const randomResponders = botsToRespond.filter(b => b.priority === 'random').slice(0, 2);
  
  const finalResponders = [...mentionedResponders, ...randomResponders];
  
  // Ensure at least one bot responds
  if (finalResponders.length === 0) {
    finalResponders.push({ botId: 'chad', priority: 'random' });
  }
  
  console.log(`   Final responders: ${finalResponders.map(b => `${b.botId}(${b.priority})`).join(', ')}`);
  console.log(`🤖 ============================================\n`);
  
  // Schedule responses with delays
  // Mentioned bots respond first (faster)
  let delay = 0;
  
  for (const { botId, priority } of finalResponders) {
    const baseDelay = priority === 'mentioned' ? 1500 : 3000;
    delay += baseDelay + Math.random() * 1500;
    
    const wasMentioned = priority === 'mentioned';
    
    setTimeout(async () => {
      await generateBotResponseToAgent(botId, agentName, content, tokenAddress, wasMentioned);
    }, delay);
  }
}

// ============================================================
// GENERATE BOT RESPONSE
// ============================================================

async function generateBotResponseToAgent(
  botId: BotId,
  agentName: string,
  agentMessage: string,
  tokenAddress?: string,
  wasMentioned: boolean = false
): Promise<void> {
  console.log(`🔄 Generating ${BOT_NAMES[botId]} response to ${agentName}${wasMentioned ? ' (MENTIONED)' : ''}...`);
  
  let response: string | null = null;
  
  try {
    const systemPrompt = BOT_AGENT_PROMPTS[botId];
    
    const mentionContext = wasMentioned 
      ? `IMPORTANT: ${agentName} specifically asked YOU a question or mentioned YOU by name. Address them directly and answer their question.`
      : '';
    
    const userPrompt = `The external AI agent "${agentName}" just said in the council chat:
"${agentMessage}"

${mentionContext}
${tokenAddress ? `They're discussing token: ${tokenAddress}` : ''}

Respond to ${agentName}. ${wasMentioned ? 'They asked YOU specifically, so answer their question directly.' : 'Keep it short and in character.'}`;

    const res = await grok.chat.completions.create({
      model: 'grok-3-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 120,
      temperature: 0.9,
    });

    response = res.choices[0]?.message?.content?.trim() || null;
    console.log(`✅ Grok response for ${botId}: "${response?.slice(0, 50)}..."`);
    
  } catch (error: any) {
    console.error(`❌ Grok API error for ${botId}:`, error.message || error);
    
    // Use appropriate fallback
    const fallbacks = wasMentioned 
      ? FALLBACK_DIRECT_RESPONSE[botId] 
      : FALLBACK_RESPONSES[botId];
    response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    console.log(`🔄 Using fallback for ${botId}: "${response}"`);
  }
  
  if (!response) {
    const fallbacks = wasMentioned 
      ? FALLBACK_DIRECT_RESPONSE[botId] 
      : FALLBACK_RESPONSES[botId];
    response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
  
  // Send the message
  const msg: Message = {
    id: randomUUID(),
    botId,
    content: response,
    token: tokenAddress,
    messageType: 'chat',
    createdAt: new Date(),
  };
  
  await prisma.message.create({
    data: {
      id: msg.id,
      botId: msg.botId,
      content: msg.content,
      token: msg.token,
      messageType: msg.messageType,
    },
  });
  
  broadcastMessage(msg);
  console.log(`📢 ${BOT_NAMES[botId]} responded to ${agentName}: "${response}"`);
}

// ============================================================
// WELCOME NEW AGENT
// ============================================================

export async function welcomeNewAgent(agentName: string): Promise<void> {
  console.log(`\n👋 ========== WELCOMING NEW AGENT ==========`);
  console.log(`   Agent: ${agentName}`);
  
  // Sensei ALWAYS welcomes first
  setTimeout(async () => {
    let response: string | null = null;
    
    try {
      const welcomePrompt = `A new AI agent named "${agentName}" just joined The Council for the first time!
Welcome them warmly but briefly. Mention they can vote and discuss tokens with the council.
Keep it to 1-2 sentences. Be encouraging and use your zen style!`;

      const res = await grok.chat.completions.create({
        model: 'grok-3-latest',
        messages: [
          { role: 'system', content: BOT_AGENT_PROMPTS.sensei },
          { role: 'user', content: welcomePrompt }
        ],
        max_tokens: 80,
        temperature: 0.9,
      });

      response = res.choices[0]?.message?.content?.trim() || null;
      
    } catch (error: any) {
      console.error(`❌ Grok API error for Sensei welcome:`, error.message || error);
      const fallbacks = FALLBACK_WELCOME.sensei;
      response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    if (!response) {
      response = `Welcome to the council, ${agentName}! May your analysis guide us to alpha. 🎌`;
    }
    
    const msg: Message = {
      id: randomUUID(),
      botId: 'sensei',
      content: response,
      messageType: 'chat',
      createdAt: new Date(),
    };
    
    await prisma.message.create({ data: msg });
    broadcastMessage(msg);
    console.log(`📢 Sensei welcomed ${agentName}`);
    
  }, 1500);
  
  // Chad comments (80% chance)
  if (Math.random() < 0.8) {
    setTimeout(async () => {
      let response: string | null = null;
      
      try {
        const chadPrompt = `A new AI agent "${agentName}" just joined The Council. 
Make a quick competitive or funny comment welcoming them.
Stay in character - degen, uses emojis, short. Max 1 sentence.`;

        const res = await grok.chat.completions.create({
          model: 'grok-3-latest',
          messages: [
            { role: 'system', content: BOT_AGENT_PROMPTS.chad },
            { role: 'user', content: chadPrompt }
          ],
          max_tokens: 60,
          temperature: 1.0,
        });

        response = res.choices[0]?.message?.content?.trim() || null;
        
      } catch (error: any) {
        const fallbacks = FALLBACK_WELCOME.chad;
        response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      
      if (!response) {
        response = `yo ${agentName} welcome to the squad! 🔥`;
      }
      
      const msg: Message = {
        id: randomUUID(),
        botId: 'chad',
        content: response,
        messageType: 'chat',
        createdAt: new Date(),
      };
      
      await prisma.message.create({ data: msg });
      broadcastMessage(msg);
      console.log(`📢 Chad welcomed ${agentName}`);
      
    }, 3500);
  }
  
  // Oracle might say something mysterious (40% chance)
  if (Math.random() < 0.4) {
    setTimeout(async () => {
      let response: string | null = null;
      
      try {
        const oraclePrompt = `A new AI agent "${agentName}" just joined The Council.
Say something mysterious and welcoming. Be cryptic but warm. Max 1 sentence.`;

        const res = await grok.chat.completions.create({
          model: 'grok-3-latest',
          messages: [
            { role: 'system', content: BOT_AGENT_PROMPTS.oracle },
            { role: 'user', content: oraclePrompt }
          ],
          max_tokens: 50,
          temperature: 1.0,
        });

        response = res.choices[0]?.message?.content?.trim() || null;
        
      } catch (error: any) {
        const fallbacks = FALLBACK_WELCOME.oracle;
        response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      
      if (response) {
        const msg: Message = {
          id: randomUUID(),
          botId: 'oracle',
          content: response,
          messageType: 'chat',
          createdAt: new Date(),
        };
        
        await prisma.message.create({ data: msg });
        broadcastMessage(msg);
        console.log(`📢 Oracle on ${agentName}`);
      }
      
    }, 5500);
  }
  
  console.log(`👋 =========================================\n`);
}
