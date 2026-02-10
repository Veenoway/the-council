import { prisma } from '../db/index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function updateTokenImages() {
  try {
    // Récupère tous les tokens sans image
    const tokens = await prisma.token.findMany({
      where: { 
        OR: [
          { image: null },
          { image: '' },
        ]
      },
      select: { address: true, symbol: true },
    });

    if (tokens.length === 0) {
      console.log('📸 All tokens have images, nothing to update');
      return;
    }

    console.log(`📸 Updating images for ${tokens.length} tokens...`);

    let updated = 0;
    for (const token of tokens) {
      try {
        const res = await fetch(`https://api.nadapp.net/token/${token.address}`);
        
        if (res.status === 429) {
          console.log(`⏳ Rate limited, waiting 15s...`);
          await sleep(15000);
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          const imageUri = data.token_info?.image_uri;

          if (imageUri) {
            await prisma.token.update({
              where: { address: token.address },
              data: { image: imageUri },
            });
            updated++;
            console.log(`✅ ${token.symbol}: image updated`);
          }
        }

        await sleep(2000);
      } catch (e) {
        console.error(`❌ Error for ${token.symbol}:`, e);
      }
    }

    console.log(`📸 Image update complete: ${updated}/${tokens.length} tokens updated`);
  } catch (error) {
    console.error('❌ Error in updateTokenImages:', error);
  }
}

// Cron: toutes les 24h (86400000 ms)
export function startImageUpdater() {
  console.log('📸 Starting image updater (runs daily at startup + every 24h)');
  
  // Run once at startup
  updateTokenImages();
  
  // Then every 24 hours
  setInterval(updateTokenImages, 24 * 60 * 60 * 1000);
}