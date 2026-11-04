import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';

const createClientSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name must be at least 2 characters').max(160),
  companyLogo: z.string().trim().optional(),
  description: z.string().trim().max(2000).optional(),
  industry: z.string().trim().max(100).optional().default('General'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  contactPerson: z.string().trim().optional().default('Corporate HR'),
  contactEmail: z.string().trim().email().optional(),
  contactPhone: z.string().trim().optional().default('+91 99999 99999'),
});

const slugify = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

/**
 * 1. GET /api/v1/clients
 * Returns active clients (or all clients for Super Admin / Admin if ?all=true)
 */
export const getClients = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { all, search } = req.query;
    const userRole = req.user?.role;
    const canSeeAll = (userRole === 'SUPER_ADMIN' || userRole === 'ADMIN') && String(all).toLowerCase() === 'true';

    const where: any = {};
    if (!canSeeAll) {
      where.status = 'ACTIVE';
    }

    if (search && typeof search === 'string' && search.trim()) {
      where.companyName = {
        contains: search.trim(),
        mode: 'insensitive',
      };
    }

    const clients = await prisma.client.findMany({
      where,
      orderBy: { companyName: 'asc' },
      select: {
        id: true,
        companyName: true,
        industry: true,
        status: true,
        notes: true,
        website: true,
        billingDetails: true,
        contactPerson: true,
        contactEmail: true,
        contactPhone: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { jobs: true },
        },
      },
    });

    const formatted = clients.map((c) => {
      const bDetails: any = c.billingDetails || {};
      return {
        id: c.id,
        companyName: c.companyName,
        companyLogo: bDetails.logoUrl || c.website || null,
        description: c.notes || null,
        industry: c.industry || 'General',
        status: c.status,
        contactPerson: c.contactPerson,
        contactEmail: c.contactEmail,
        contactPhone: c.contactPhone,
        activeJobsCount: c._count?.jobs || 0,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    sendSuccess(res, { clients: formatted });
  } catch (err) {
    next(err);
  }
};

/**
 * 2. POST /api/v1/clients
 * Creates a new client/company master record (Super Admin & Admin only)
 */
export const createClient = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createClientSchema.parse(req.body);

    // Duplicate check: ensure no duplicate company entries (Requirement 2 & 4)
    const existing = await prisma.client.findFirst({
      where: {
        companyName: {
          equals: parsed.companyName,
          mode: 'insensitive',
        },
      },
      select: { id: true, companyName: true },
    });

    if (existing) {
      sendError(res, `Company with name "${parsed.companyName}" already exists.`, 409);
      return;
    }

    const defaultEmail = parsed.contactEmail || `contact@${slugify(parsed.companyName) || 'company'}.internal`;

    const client = await prisma.client.create({
      data: {
        companyName: parsed.companyName,
        industry: parsed.industry,
        contactPerson: parsed.contactPerson,
        contactEmail: defaultEmail,
        contactPhone: parsed.contactPhone,
        status: parsed.status as any,
        notes: parsed.description || null,
        billingDetails: parsed.companyLogo ? { logoUrl: parsed.companyLogo } : undefined,
      },
      select: {
        id: true,
        companyName: true,
        industry: true,
        status: true,
        notes: true,
        website: true,
        billingDetails: true,
        contactPerson: true,
        contactEmail: true,
        contactPhone: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const bDetails: any = client.billingDetails || {};
    const formatted = {
      id: client.id,
      companyName: client.companyName,
      companyLogo: bDetails.logoUrl || client.website || null,
      description: client.notes || null,
      industry: client.industry,
      status: client.status,
      contactPerson: client.contactPerson,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    };

    sendSuccess(res, { client: formatted }, 'Company created successfully', 201);
  } catch (err) {
    next(err);
  }
};
