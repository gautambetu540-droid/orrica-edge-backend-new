import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Orrica Edge database seed...');

  // 1. Seed Users (Admin & Recruiter)
  const salt = await bcrypt.genSalt(10);
  const adminPassword = await bcrypt.hash('Admin@12345', salt);
  const recruiterPassword = await bcrypt.hash('Recruiter@12345', salt);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@orricaedge.com' },
    update: {},
    create: {
      email: 'admin@orricaedge.com',
      passwordHash: adminPassword,
      fullName: 'Sudhanshu Sharma',
      role: 'SUPER_ADMIN',
      phone: '+91 9876543210',
    },
  });

  const recruiter = await prisma.user.upsert({
    where: { email: 'recruiter@orricaedge.com' },
    update: {},
    create: {
      email: 'recruiter@orricaedge.com',
      passwordHash: recruiterPassword,
      fullName: 'Pooja Verma',
      role: 'RECRUITER',
      phone: '+91 9876543211',
    },
  });

  console.log('✅ Users seeded:', { admin: admin.email, recruiter: recruiter.email });

  // 2. Seed Corporate Clients
  const client1 = await prisma.client.create({
    data: {
      companyName: 'Concentrix Global Services',
      industry: 'BPO / Customer Experience',
      contactPerson: 'Rahul Kapoor',
      contactEmail: 'rahul.k@concentrix.com',
      contactPhone: '+91 9811223344',
      website: 'https://concentrix.com',
    },
  });

  const client2 = await prisma.client.create({
    data: {
      companyName: 'Teleperformance Enterprises',
      industry: 'Customer Lifecycle Management',
      contactPerson: 'Anjali Nair',
      contactEmail: 'anjali.n@teleperformance.com',
      contactPhone: '+91 9822334455',
      website: 'https://teleperformance.com',
    },
  });

  console.log('✅ Clients seeded');

  // 3. Seed Standard Jobs
  await prisma.job.createMany({
    data: [
      {
        jobCode: 'OE-2026-001',
        title: 'Customer Support Associate (Voice Process)',
        slug: 'customer-support-associate-voice-process-oe-2026-001',
        clientId: client1.id,
        department: 'Customer Operations',
        category: 'Customer Support',
        location: 'Gurugram, Haryana',
        workMode: 'WORK_FROM_OFFICE',
        employmentType: 'FULL_TIME',
        experienceMin: 0,
        experienceMax: 2,
        salaryMin: 300000,
        salaryMax: 420000,
        salaryText: '₹25,000 - ₹35,000 / month',
        vacancies: 15,
        skills: ['Active Listening', 'Fluent English', 'Customer Handling', 'CRM Navigation'],
        contentHtml: '<h2>Job Summary</h2><p>Hiring enthusiastic customer support executives for leading international BPO mandate. Day and rotational shifts available with two-way cab facility.</p>',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdById: admin.id,
      },
      {
        jobCode: 'OE-2026-002',
        title: 'International Chat & Email Executive (Non-Voice)',
        slug: 'international-chat-email-executive-non-voice-oe-2026-002',
        clientId: client2.id,
        department: 'Digital Support',
        category: 'Non-Voice / Back Office',
        location: 'Noida, Uttar Pradesh',
        workMode: 'HYBRID',
        employmentType: 'FULL_TIME',
        experienceMin: 1,
        experienceMax: 3,
        salaryMin: 350000,
        salaryMax: 500000,
        salaryText: '₹30,000 - ₹42,000 / month',
        vacancies: 8,
        skills: ['Typing Speed > 40 WPM', 'Written Communication', 'Ticketing Systems', 'Zendesk'],
        contentHtml: '<h2>Job Summary</h2><p>Seeking detail-oriented Chat and Email representatives for global customer queries. Fast-track promotion cycles and comprehensive medical cover.</p>',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        createdById: admin.id,
      },
    ],
  });

  console.log('✅ Jobs seeded');

  // 4. Seed Career Resources (Blogs)
  await prisma.blogPost.createMany({
    data: [
      {
        title: 'How to Prepare for an International Customer Support Interview in 2026',
        slug: 'international-customer-support-interview-preparation',
        category: 'Interview Preparation',
        excerpt:
          'A practical guide to preparing for international customer support interviews, including communication skills, voice modulation, customer scenarios, assessments, CRM knowledge and shift readiness.',
        contentMarkdown: `## Introduction\nInternational customer support roles require clear diction, empathetic listening, and composure under pressure.\n\n## Core Evaluation Criteria\n1. Active Listening and comprehension\n2. Neutral accent & clear pronunciation\n3. De-escalation tactics\n\n## Conclusion\nThorough preparation transforms nervous candidates into confident professionals.`,
        featuredImage: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=1200&q=80',
        authorName: 'Orrica Edge Editorial Team',
        authorRole: 'Career & Recruitment Insights',
        readingTime: '10–12 min read',
        isFeatured: true,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
      {
        title: 'Salary Negotiation in India: Complete Guide for Job Seekers in 2026',
        slug: 'salary-negotiation-india-job-switch',
        category: 'Salary & Compensation',
        excerpt:
          'Understand CTC, fixed and variable pay, bonuses, salary expectations, competing offers and practical strategies for negotiating compensation professionally.',
        contentMarkdown: `## Understanding CTC vs In-Hand Salary\nMany candidates make the mistake of focusing solely on the gross CTC without factoring in deductions.\n\n## Professional Negotiation Scripts\nAlways anchor your expectations with benchmark data from verified recruiters.\n\n## Conclusion\nNegotiating respectfully establishes your market value and commands mutual respect.`,
        featuredImage: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=1200&q=80',
        authorName: 'Orrica Edge Compensation Research',
        authorRole: 'Talent & Salary Benchmarking Team',
        readingTime: '10–12 min read',
        isFeatured: false,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    ],
  });

  console.log('✅ Blog posts seeded');

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
