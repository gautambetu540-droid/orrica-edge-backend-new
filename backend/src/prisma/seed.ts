import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting Orrica Edge production bootstrap seed...');

  // Only bootstrap the single Super Admin. Never create demo recruiters, clients, jobs, candidates or blogs.
  const email = process.env.DEFAULT_ADMIN_EMAIL || 'admin@orricaedge.com';
  const password = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!password || password.length < 12) {
    throw new Error('DEFAULT_ADMIN_PASSWORD must be set and contain at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      fullName: process.env.DEFAULT_ADMIN_NAME || 'Orrica Edge Super Admin',
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });

  console.log('Super Admin ready:', admin.email);

  // 5. Seed Email Templates (Admin-Controlled Template Engine)
  const defaultTemplates = [
    {
      templateKey: 'APPLICATION_RECEIVED',
      name: 'Candidate Application Received',
      category: 'Candidate',
      subject: 'Application Received: {{job_title}} — Orrica Edge',
      htmlBody: '<h2>Application Received</h2><p>Dear <strong>{{candidate_name}}</strong>,</p><p>Thank you for applying for the position of <strong>{{job_title}}</strong> ({{job_code}}) based in <strong>{{job_location}}</strong>.</p><p>Your application ID is <strong>{{application_id}}</strong>. Our recruitment team will review your profile shortly.</p>',
      plainText: 'Dear {{candidate_name}}, Thank you for applying for {{job_title}}. Application ID: {{application_id}}.',
      variables: ['candidate_name', 'job_title', 'job_code', 'job_location', 'application_id', 'support_email'],
      isActive: true,
      isDefault: true,
    },
    {
      templateKey: 'INTERVIEW_SCHEDULED',
      name: 'Interview Scheduled',
      category: 'Candidate',
      subject: 'Interview Scheduled: {{interview_round}} for {{job_title}} — Orrica Edge',
      htmlBody: '<h2>Interview Invitation</h2><p>Dear <strong>{{candidate_name}}</strong>,</p><p>You are invited for {{interview_round}} on {{interview_date}} at {{interview_time}}.</p><p><a href="{{meeting_link}}" style="background-color:#f97316;color:#ffffff;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Join Video Interview</a></p>',
      plainText: 'Interview for {{job_title}} on {{interview_date}} at {{interview_time}}. Link: {{meeting_link}}',
      variables: ['candidate_name', 'job_title', 'interview_round', 'interview_date', 'interview_time', 'meeting_link'],
      isActive: true,
      isDefault: true,
    },
    {
      templateKey: 'APPLICATION_SHORTLISTED',
      name: 'Application Shortlisted',
      category: 'Candidate',
      subject: 'Great News! Your profile is shortlisted for {{job_title}}',
      htmlBody: '<h2>Profile Shortlisted</h2><p>Dear <strong>{{candidate_name}}</strong>,</p><p>Congratulations! You have passed the screening round for {{job_title}} with {{company_name}}.</p>',
      plainText: 'Congratulations {{candidate_name}}! You are shortlisted for {{job_title}}.',
      variables: ['candidate_name', 'job_title', 'company_name', 'recruiter_name'],
      isActive: true,
      isDefault: true,
    },
    {
      templateKey: 'APPLICATION_REJECTED',
      name: 'Application Not Selected',
      category: 'Candidate',
      subject: 'Update regarding your application for {{job_title}}',
      htmlBody: '<h2>Application Status Update</h2><p>Dear <strong>{{candidate_name}}</strong>,</p><p>Thank you for applying for {{job_title}}. While we cannot move forward with this position, your resume remains active in our talent network for future openings.</p>',
      plainText: 'Dear {{candidate_name}}, update regarding {{job_title}}. Your resume remains in our talent network.',
      variables: ['candidate_name', 'job_title', 'support_email'],
      isActive: true,
      isDefault: true,
    },
  ];

  for (const tpl of defaultTemplates) {
    await prisma.emailTemplate.upsert({
      where: { templateKey: tpl.templateKey },
      update: {},
      create: tpl,
    });
  }

  console.log('✅ Email templates seeded');
  console.log('🎉 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
