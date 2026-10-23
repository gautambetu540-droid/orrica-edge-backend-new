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
import { ensureDatabaseSchema } from './scripts/bootstrap-db';
import userRoutes from './routes/user.routes';
import walkInRoutes from './routes/walk-in.routes';
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
        (origin && /\.vercel\.app$/.test(new URL(origin).hostname)) ||
        (config.nodeEnv !== 'production' && config.corsOrigin.includes('*'));

      if (!origin || isAllowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error('Origin is not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-access-token',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    exposedHeaders: ['Authorization'],
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

// Request timeout middleware (30s)
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        message: 'Request timed out waiting for server processing.',
        error: { code: 'GATEWAY_TIMEOUT', message: 'Request processing exceeded 30 seconds.' },
      });
    }
  });
  next();
});

// Production Health Check Endpoints: Liveness vs Deep Database Readiness
app.get(['/health/live', '/api/health/live'], (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Orrica Edge ATS API Server',
    environment: config.nodeEnv,
    uptime: process.uptime(),
  });
});

app.get(['/health', '/api/health', '/health/ready', '/api/health/ready'], async (req, res) => {
  const start = Date.now();
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let dbLatencyMs: number | null = null;
  let dbError: string | null = null;

  try {
    await Promise.race([
      prisma.$queryRawUnsafe('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Database ping timed out')), 3000)),
    ]);
    dbStatus = 'connected';
    dbLatencyMs = Date.now() - start;
  } catch (err: any) {
    dbStatus = 'disconnected';
    dbError = config.nodeEnv === 'production' ? 'Database connection check failed' : err?.message || 'Database error';
  }

  const isHealthy = dbStatus === 'connected';
  const statusCode = isHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: 'Orrica Edge ATS API Server',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    uptime: process.uptime(),
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
      ...(dbError ? { error: dbError } : {}),
    },
  });
});

// Swagger API Documentation
app.use('/api/docs', swaggerRouter);

// Register API Routes for both /api/v1 and /api (Recruitment OS architecture)
const registerApiRoutes = (prefix: string) => {
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/user`, userRoutes);
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/profile`, userRoutes);
  app.use(`${prefix}/settings`, userRoutes);
  app.use(`${prefix}/jobs`, jobRoutes);
  app.use(`${prefix}/applications`, applicationRoutes);
  app.use(`${prefix}/blogs`, blogRoutes);
  app.use(`${prefix}/inquiries`, inquiryRoutes);
  app.use(`${prefix}/candidates`, candidateRoutes);
  app.use(`${prefix}/team-leader`, teamLeaderRoutes);
  app.use(`${prefix}/tl`, teamLeaderRoutes);
  app.use(`${prefix}/approvals`, teamLeaderRoutes);
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
  app.use(`${prefix}/walk-in`, walkInRoutes);
};

registerApiRoutes('/api/v1');
registerApiRoutes('/api');
app.use('/walk-in', walkInRoutes);

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

// Server Startup & Graceful Shutdown
const startServer = async () => {
  try {
    await ensureDatabaseSchema();
    await repairLegacyClientNames();
    await ensureDefaultUniversalForm();
  } catch (err) {
    console.error('[STARTUP] Initialization warning:', err);
  }

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
};

void startServer();

export default app;
