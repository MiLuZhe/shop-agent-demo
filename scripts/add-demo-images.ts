import { createDatabase } from '../packages/database/src/index.ts';
import { demoProductImages } from '../packages/database/prisma/demo-images.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Demo images are for local development only');
const db = createDatabase();
try {
  const count = await db.$transaction(async (tx) => {
    let changed = 0;
    for (const product of demoProductImages) {
      // Only fill empty demo galleries. Preserve custom pictures, names and all business fields.
      const result = await tx.product.updateMany({
        where: { id: product.id, name: product.name, image_urls: { equals: [] } },
        data: { image_urls: product.imageUrls },
      });
      changed += result.count;
    }
    return changed;
  });
  console.log(`Demo galleries filled: ${count}; existing pictures and business data preserved.`);
} finally { await db.$disconnect(); }
