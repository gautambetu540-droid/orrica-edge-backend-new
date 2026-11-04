import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { publishGoogleIndexingUrl } from '../services/googleIndexing.service';

// Generate Google-compliant Schema.org JobPosting JSON-LD
export const getJobPostingJsonLd = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug);

    const job = await prisma.job.findFirst({
      where: {
        AND: [
          { status: 'PUBLISHED' },
          {
            OR: [
              ...(isUuid ? [{ id: slug }] : []),
              { slug },
              { jobCode: slug },
            ],
          },
        ],
      },
      include: {
        client: true,
      },
    });

    if (!job) {
      sendError(res, 'Published job not found', 404);
      return;
    }

    const schema: Record<string, any> = {
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: job.title,
      description: job.contentHtml || job.title,
      identifier: {
        '@type': 'PropertyValue',
        name: 'Orrica Edge',
        value: job.jobCode,
      },
      datePosted: job.publishedAt ? job.publishedAt.toISOString() : job.createdAt.toISOString(),
      employmentType: job.employmentType,
      hiringOrganization: {
        '@type': 'Organization',
        name: job.client?.companyName || 'Orrica Edge Recruitment Solutions',
        sameAs: job.client?.website || 'https://www.orricaedge.com',
        logo: 'https://www.orricaedge.com/icons/icon-192x192.png',
      },
      directApply: true,
    };

    // Only set validThrough if a real closingDate exists in the database
    if (job.closingDate) {
      schema.validThrough = new Date(job.closingDate).toISOString();
    }

    // Configure jobLocation and Remote flags
    if (job.workMode === 'REMOTE') {
      schema.jobLocationType = 'TELECOMMUTE';
      schema.applicantLocationRequirements = {
        '@type': 'Country',
        name: 'India',
      };
    }

    if (job.location) {
      schema.jobLocation = {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: job.location,
          addressCountry: 'IN',
        },
      };
    }

    // Only include baseSalary if real positive values are present
    const rawMin = job.salaryMin ? Number(job.salaryMin) : undefined;
    const rawMax = job.salaryMax ? Number(job.salaryMax) : undefined;

    if ((rawMin && rawMin > 0) || (rawMax && rawMax > 0)) {
      const minInr = rawMin && rawMin > 0 ? (rawMin <= 100 ? rawMin * 100000 : rawMin) : undefined;
      const maxInr = rawMax && rawMax > 0 ? (rawMax <= 100 ? rawMax * 100000 : rawMax) : undefined;

      schema.baseSalary = {
        '@type': 'MonetaryAmount',
        currency: 'INR',
        value: {
          '@type': 'QuantitativeValue',
          ...(minInr ? { minValue: minInr } : {}),
          ...(maxInr ? { maxValue: maxInr } : {}),
          unitText: 'YEAR',
        },
      };
    }

    if (Array.isArray(job.skills) && job.skills.length > 0) {
      schema.skills = job.skills.join(', ');
    }

    sendSuccess(res, { schema });
  } catch (err) {
    next(err);
  }
};

// Batch notify Google Indexing API for all active published jobs
export const indexAllActiveJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const jobs = await prisma.job.findMany({
      where: {
        status: 'PUBLISHED',
        OR: [
          { closingDate: null },
          { closingDate: { gt: new Date() } },
        ],
      },
      select: { slug: true, jobCode: true, id: true, title: true },
    });

    const baseUrl = process.env.FRONTEND_URL || 'https://www.orricaedge.com';
    const results: Array<{ slug: string; url: string; status: string; error?: string }> = [];

    for (const job of jobs) {
      const slug = job.slug || job.jobCode || job.id;
      const url = `${baseUrl.replace(/\/+$/, '')}/jobs/${slug}`;
      try {
        await publishGoogleIndexingUrl(url, 'URL_UPDATED');
        results.push({ slug, url, status: 'submitted' });
      } catch (err: any) {
        results.push({ slug, url, status: 'failed', error: err?.message || 'Submission error' });
      }
    }

    sendSuccess(res, { total: jobs.length, results }, 'Batch Google Indexing processed');
  } catch (err) {
    next(err);
  }
};

// Notify Google Indexing API for a single job by slug or ID
export const indexJobBySlug = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug);

    const job = await prisma.job.findFirst({
      where: {
        AND: [
          { status: 'PUBLISHED' },
          {
            OR: [
              ...(isUuid ? [{ id: slug }] : []),
              { slug },
              { jobCode: slug },
            ],
          },
        ],
      },
    });

    if (!job) {
      sendError(res, 'Active published job not found', 404);
      return;
    }

    const baseUrl = process.env.FRONTEND_URL || 'https://www.orricaedge.com';
    const targetSlug = job.slug || job.jobCode || job.id;
    const url = `${baseUrl.replace(/\/+$/, '')}/jobs/${targetSlug}`;

    await publishGoogleIndexingUrl(url, 'URL_UPDATED');

    sendSuccess(res, { slug: targetSlug, url, status: 'submitted' }, 'Job submitted to Google Indexing API');
  } catch (err) {
    next(err);
  }
};
