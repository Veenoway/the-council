// jobs/price-updater.ts
import { prisma } from '../db/index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function updateTokenPrices() {
  try {
    // Récupère tous les tokens des positions ouvertes
    const openPositions = await prisma.position.findMany({
      where: { isOpen: true },
      select: { tokenAddress: true },
      distinct: ['tokenAddress'],
    });

    const uniqueAddresses = [...new Set(openPositions.map(p => p.tokenAddress.toLowerCase()))];
    
    console.log(`📊 Updating prices for ${uniqueAddresses.length} tokens...`);

    let updated = 0;
    for (const addr of uniqueAddresses) {
      try {
        await sleep(1500); // Éviter rate limit
        
        const res = await fetch(`https://api.nadapp.net/trade/market/${addr}`);
        if (res.status === 429) {
          console.log(`⏳ Rate limited, waiting 5s...`);
          await sleep(5000);
          continue;
        }
        
        if (res.ok) {
          const data = await res.json();
          const priceUsd = parseFloat(data.market_info?.price_usd || '0');
          
          if (priceUsd > 0) {
            await prisma.token.update({
              where: { address: addr },
              data: { price: priceUsd },
            });
            updated++;
            process.stdout.write(`\r✅ Updated ${updated}/${uniqueAddresses.length} prices`);
          }
        }
      } catch (e) {
        // Token might not exist in DB, skip
      }
    }
    
    console.log(`\n✅ Price update complete: ${updated} tokens updated`);
  } catch (error) {
    console.error('❌ Error updating prices:', error);
  }
}

// Lance toutes les 2 minutes
export function startPriceUpdater() {
  console.log('📈 Starting price updater (every 2 min)...');
  updateTokenPrices(); // Run once immediately
  setInterval(updateTokenPrices, 2 * 60 * 1000);
}