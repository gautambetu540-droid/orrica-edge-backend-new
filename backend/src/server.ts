import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler } from './middlewares/error.middleware';
import { prisma } from './prisma/client';

// Routes
import authRoutes from './routes/auth.routes';
import jobRoutes from './routes/job.routes';
import applicationRoutes from './routes/application.routes';
import blogRoutes from './routes/blog.routes';
import inquiryRoutes from './routes/inquiry.routes';
import candidateRoutes from './routes/candidate.routes';
import recruiterRoutes from './routes/recruiter.routes';
import recruiterApplicationRoutes from './routes/recruiter-application.routes';
import adminPortalRoutes from './routes/admin-portal.routes';
import interviewRoutes from './routes/interview.routes';
import dashboardRoutes from './routes/dashboard.routes';
import seoRoutes from './routes/seo.routes';
import templateRoutes from './routes/template.routes';
import migrationRoutes from './routes/migration.routes';
import universalFormRoutes from './routes/universal-form.routes';
import notificationRoutes from './routes/notification.routes';
import teamLeaderRoutes from './routes/team-leader.routes';
import searchRoutes from './routes/search.routes';
import { ensureDefaultUniversalForm } from './controllers/universal-form.controller';
import swaggerRouter from './swagger/swagger';

const app = express();

// Render runs the service behind a reverse proxy and forwards the client IP.
// Trust the first proxy hop so express-rate-limit can safely use X-Forwarded-For.
app.set('trust proxy', 1);

// Security Middlewares
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cookieParser());
app.use(
  cors({
    origin: (origin, callback) => {
      const isAllowedOrigin =
        config.corsOrigin.includes(origin || '') ||
        (config.nodeEnv !== 'production' && config.corsOrigin.includes('*'));

      if (!origin || isAllowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error('Origin is not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Rate Limiting (Prevent abuse on public endpoints)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: { success: false, message: 'Too many requests from this IP, please try again later.' },
});
app.use('/api/', generalLimiter);

// Body Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static file serving for uploaded resumes
app.use('/uploads', express.static(path.resolve(config.upload.dir)));

// Production Health Check Endpoints
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Orrica Edge ATS API Server',
    environment: config.nodeEnv,
    uptime: process.uptime(),
  });
});

// Swagger API Documentation
app.use('/api/docs', swaggerRouter);

// Register API Routes for both /api/v1 and /api (Recruitment OS architecture)
const registerApiRoutes = (prefix: string) => {
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/jobs`, jobRoutes);
  app.use(`${prefix}/applications`, applicationRoutes);
  app.use(`${prefix}/blogs`, blogRoutes);
  app.use(`${prefix}/inquiries`, inquiryRoutes);
  app.use(`${prefix}/candidates`, candidateRoutes);
  app.use(`${prefix}/team-leader`, teamLeaderRoutes);
  app.use(`${prefix}/tl`, teamLeaderRoutes);
  app.use(`${prefix}/search`, searchRoutes);
  app.use(`${prefix}/recruiters`, recruiterRoutes);
  app.use(`${prefix}/recruiter`, recruiterRoutes);
  app.use(`${prefix}/recruiter-applications`, recruiterApplicationRoutes);
  app.use(`${prefix}/admin`, adminPortalRoutes);
  app.use(`${prefix}/interviews`, interviewRoutes);
  app.use(`${prefix}/dashboard`, dashboardRoutes);
  app.use(`${prefix}/seo`, seoRoutes);
  app.use(`${prefix}/email-templates`, templateRoutes);
  app.use(`${prefix}/admin/migrate`, migrationRoutes);
  app.use(`${prefix}/universal-forms`, universalFormRoutes);
  app.use(`${prefix}/notifications`, notificationRoutes);
};

registerApiRoutes('/api/v1');
registerApiRoutes('/api');

// 404 Route Handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// Centralized Error Handler Middleware
app.use(errorHandler);

// Repair legacy client naming left by earlier DynamoDB migrations.
// This only changes the exact legacy company name and keeps all client IDs/relations intact.
const repairLegacyClientNames = async () => {
  try {
    const result = await prisma.client.updateMany({
      where: { companyName: 'Legacy DynamoDB' },
      data: { companyName: 'Orrica Edge' },
    });

    if (result.count > 0) {
      console.log(`[DATA REPAIR] Renamed ${result.count} legacy client record(s) to Orrica Edge.`);
    }
  } catch (error) {
    console.error('[DATA REPAIR] Legacy client name repair failed:', error);
  }
};

// Ensure critical PostgreSQL columns exist to prevent any "column does not exist" errors
const ensureDatabaseSchema = async () => {
  try {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        CREATE TYPE "ReviewStatus" AS ENUM ('PENDING_TL_REVIEW', 'TL_APPROVED', 'TL_SENT_BACK', 'TL_REJECTED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "users_teamLeaderId_idx" ON "users"("teamLeaderId");`);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE "candidates" 
        ADD COLUMN IF NOT EXISTS "name" TEXT,
        ADD COLUMN IF NOT EXISTS "fatherName" TEXT,
        ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "gender" "Gender",
        ADD COLUMN IF NOT EXISTS "currentLocation" TEXT,
        ADD COLUMN IF NOT EXISTS "preferredLocation" TEXT,
        ADD COLUMN IF NOT EXISTS "totalExperience" DECIMAL(4, 1) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "relevantExperience" DECIMAL(4, 1) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "highestQualification" TEXT,
        ADD COLUMN IF NOT EXISTS "previousCompany" TEXT,
        ADD COLUMN IF NOT EXISTS "noticePeriod" TEXT,
        ADD COLUMN IF NOT EXISTS "currentSalary" DECIMAL(10, 2),
        ADD COLUMN IF NOT EXISTS "expectedSalary" DECIMAL(10, 2),
        ADD COLUMN IF NOT EXISTS "nextActionDate" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "nextActionType" TEXT,
        ADD COLUMN IF NOT EXISTS "nextActionRemarks" TEXT,
        ADD COLUMN IF NOT EXISTS "sourcingRecruiterId" TEXT,
        ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT;
    `);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE "applications" 
        ADD COLUMN IF NOT EXISTS "applicationCode" TEXT,
        ADD COLUMN IF NOT EXISTS "teamLeaderId" TEXT,
        ADD COLUMN IF NOT EXISTS "appliedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'Submitted',
        ADD COLUMN IF NOT EXISTS "reviewStatus" "ReviewStatus" DEFAULT 'PENDING_TL_REVIEW',
        ADD COLUMN IF NOT EXISTS "sendBackReason" TEXT,
        ADD COLUMN IF NOT EXISTS "sendBackRemarks" TEXT;
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "candidate_timelines" (
        "id" TEXT NOT NULL,
        "candidateId" TEXT NOT NULL,
        "applicationId" TEXT,
        "userId" TEXT,
        "userName" TEXT,
        "userRole" TEXT,
        "action" TEXT NOT NULL,
        "previousStatus" TEXT,
        "newStatus" TEXT,
        "remarks" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "candidate_timelines_pkey" PRIMARY KEY ("id")
      );
    `);
    console.log('[SCHEMA] Verified and ensured all PostgreSQL tables and columns exist.');
  } catch (err: any) {
    console.warn('[SCHEMA] Automatic column check warning:', err?.message || err);
  }
};

void ensureDatabaseSchema();
repairLegacyClientNames();
ensureDefaultUniversalForm();

// Graceful Shutdown & Server Startup
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`🚀 Orrica Edge Enterprise ATS Backend Server Started`);
    console.log(`📡 URL: http://localhost:${config.port}`);
    console.log(`📖 Swagger API Docs: http://localhost:${config.port}/api/docs`);
    console.log(`🩺 Health: http://localhost:${config.port}/health`);
    console.log(`=======================================================`);
  });

  const handleShutdown = (signal: string) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Closing HTTP server gracefully...`);
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed cleanly. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

export default app;
