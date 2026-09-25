import swaggerUi from 'swagger-ui-express';
import { Router } from 'express';

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Orrica Edge ATS & Recruitment Engine API',
    version: '1.0.0',
    description:
      'Enterprise Recruitment, Candidate ATS, Job Management, and Career Resources REST API for Orrica Edge.',
    contact: {
      name: 'Orrica Edge Engineering Team',
      email: 'no-reply@orricaedge.com',
      url: 'https://orricaedge.com',
    },
  },
  servers: [
    {
      url: '/api/v1',
      description: 'API v1 Base Server',
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  paths: {
    '/auth/register': {
      post: {
        summary: 'Register new user account (Candidate or Recruiter)',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'fullName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 6 },
                  fullName: { type: 'string' },
                  role: { type: 'string', enum: ['CANDIDATE', 'RECRUITER', 'CLIENT'] },
                  phone: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'User registered successfully' },
          409: { description: 'Email already exists' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Authenticate and receive JWT token + Refresh Token',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Authentication successful' },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/jobs': {
      get: {
        summary: 'List and filter published job openings with pagination',
        tags: ['Jobs'],
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'department', in: 'query', schema: { type: 'string' } },
          { name: 'location', in: 'query', schema: { type: 'string' } },
          { name: 'workMode', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
        ],
        responses: {
          200: { description: 'List of jobs' },
        },
      },
      post: {
        summary: 'Create new job requisition (Admin / Recruiter)',
        tags: ['Jobs'],
        security: [{ BearerAuth: [] }],
        responses: {
          201: { description: 'Job created' },
        },
      },
    },
    '/applications/apply': {
      post: {
        summary: 'Submit job application with resume PDF upload & automated ATS matching',
        tags: ['Applications / ATS'],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['jobId', 'fullName', 'email', 'phone', 'location', 'resume'],
                properties: {
                  jobId: { type: 'string', format: 'uuid' },
                  fullName: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  phone: { type: 'string' },
                  location: { type: 'string' },
                  experienceYears: { type: 'number' },
                  skills: { type: 'string', description: 'Comma separated skills' },
                  resume: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Application submitted with ATS score calculated' },
        },
      },
    },
    '/dashboard/stats': {
      get: {
        summary: 'Get Admin / Recruiter Dashboard conversion statistics and metrics',
        tags: ['Analytics & Dashboard'],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'range', in: 'query', schema: { type: 'string', enum: ['today', '7d', '30d', '3m', 'all'] } },
        ],
        responses: {
          200: { description: 'Dashboard metrics' },
        },
      },
    },
  },
};

const swaggerRouter = Router();
swaggerRouter.use('/', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

export default swaggerRouter;
