// ============================================================
// SEED — Initialize bot stats
// ============================================================

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BOTS = [
  { botId: 'sensei', name: 'Sensei' },
  { botId: 'quantum', name: 'Quantum' },
  { botId: 'chad', name: 'Chad' },
  { botId: 'sterling', name: 'Sterling' },
  { botId: 'oracle', name: 'Oracle' },
];

async function main() {
  console.log('🌱 Seeding database...');

  // Create bot stats for each bot
  for (const bot of BOTS) {
    await prisma.botStats.upsert({
      where: { botId: bot.botId },
      update: {},
      create: {
        botId: bot.botId,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnl: 0,
        currentStreak: 0,
        bestStreak: 0,
      },
    });
    console.log(`  ✓ ${bot.name} stats initialized`);
  }

  console.log('✅ Seed complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    // Use process?.exit if process is not globally typed, or just comment it out for linting:
    // process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });