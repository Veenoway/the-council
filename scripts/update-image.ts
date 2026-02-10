// scripts/update-token-images.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function updateTokenImages() {
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

  console.log(`📸 Updating images for ${tokens.length} tokens...`);

  let updated = 0;
  for (const token of tokens) {
    try {
      console.log(`📸 Fetching image for ${token.symbol}...`);
      
      const res = await fetch(`https://api.nadapp.net/token/${token.address}`);
      
      if (res.status === 429) {
        console.log(`⏳ Rate limited, waiting 15s...`);
        await sleep(15000);
        // Retry this token
        const retryRes = await fetch(`https://api.nadapp.net/token/${token.address}`);
        if (!retryRes.ok) continue;
        const retryData = await retryRes.json();
        const retryImageUri = retryData.token_info?.image_uri;
        console.log("retryImageUri =====>", retryImageUri);
        if (retryImageUri) {
          await prisma.token.update({
            where: { address: token.address },
            data: { image: retryImageUri },
          });
          updated++;
          console.log(`✅ ${token.symbol}: ${retryImageUri.slice(0, 50)}...`);
        }
        await sleep(2000);
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        const imageUri = data.token_info?.image_uri;
        console.log("data =====>", data);
        console.log("imageUri =====>", imageUri);
        console.log(`   Response for ${token.symbol}:`, imageUri ? 'found image' : 'no image');

        if (imageUri) {
          await prisma.token.update({
            where: { address: token.address },
            data: { image: imageUri },
          });
          updated++;
          console.log(`✅ ${token.symbol}: ${imageUri.slice(0, 50)}...`);
        } else {
          console.log(`⚠️ ${token.symbol}: No image in response`);
        }
      } else {
        console.log(`❌ ${token.symbol}: HTTP ${res.status}`);
      }

      await sleep(6000); // 2s entre chaque requête
    } catch (e) {
      console.error(`❌ Error for ${token.symbol}:`, e);
    }
  }

  console.log(`\n✅ Done! Updated ${updated}/${tokens.length} tokens`);
  await prisma.$disconnect();
}

updateTokenImages();