import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler } from './middlewares/error.middleware';

// Routes
import authRoutes from './routes/auth.routes';
import jobRoutes from './routes/job.routes';
import applicationRoutes from './routes/application.routes';
import blogRoutes from './routes/blog.routes';
import inquiryRoutes from './routes/inquiry.routes';
import candidateRoutes from './routes/candidate.routes';
import interviewRoutes from './routes/interview.routes';
import dashboardRoutes from './routes/dashboard.routes';
import seoRoutes from './routes/seo.routes';
import templateRoutes from './routes/template.routes';
import swaggerRouter from './swagger/swagger';

const app = express();

// Security Middlewares
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cookieParser());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.corsOrigin.includes(origin) || config.corsOrigin.includes('*')) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive for local development
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

// API v1 Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/jobs', jobRoutes);
app.use('/api/v1/applications', applicationRoutes);
app.use('/api/v1/blogs', blogRoutes);
app.use('/api/v1/inquiries', inquiryRoutes);
app.use('/api/v1/candidates', candidateRoutes);
app.use('/api/v1/interviews', interviewRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/seo', seoRoutes);
app.use('/api/v1/email-templates', templateRoutes);

// 404 Route Handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// Centralized Error Handler Middleware
app.use(errorHandler);

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
