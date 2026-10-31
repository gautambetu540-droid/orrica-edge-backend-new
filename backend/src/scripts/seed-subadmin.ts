import { prisma } from '../prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const seedSubAdmin = async () => {
  const email = (process.env.SUBADMIN_SEED_EMAIL || 'subadmin@orricaedge.com').trim().toLowerCase();
  const password = process.env.SUBADMIN_SEED_PASSWORD || `SubAdmin@${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await prisma.user.findUnique({
    where: { email },
  });

  let user;
  if (existing) {
    user = await prisma.user.update({
      where: { email },
      data: {
        role: 'SUB_ADMIN' as any,
        passwordHash,
        mustSetPassword: true,
        isActive: true,
      },
    });
  } else {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: 'Sub-Admin User',
        role: 'SUB_ADMIN' as any,
        mustSetPassword: true,
        isActive: true,
      },
    });
  }

  console.log('==================================================');
  console.log('✅ SUB-ADMIN SEED COMPLETED SUCCESSFULLY');
  console.log(`User ID:          ${user.id}`);
  console.log(`Email / Login ID: ${user.email}`);
  console.log(`Role:             ${user.role}`);
  console.log(`Temporary Pass:   ${password}`);
  console.log(`Must Set Password: true (Forces password reset on first login)`);
  console.log('==================================================');

  return { user, password };
};

if (require.main === module) {
  seedSubAdmin()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[SEED ERROR]', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
