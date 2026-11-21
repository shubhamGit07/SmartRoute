
import { prisma } from './db.js';

async function main(): Promise<void> {
  console.log('======================================');
  console.log('       SmartRoute Seed Process');
  console.log('======================================');

  console.log('Seed execution completed.');
  console.log('Automatic demo data generation is disabled.');
  console.log('No users, riders, or orders were created.');
  console.log('======================================');
}

main()
  .catch((error: unknown) => {
    console.error('SmartRoute seed process failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
