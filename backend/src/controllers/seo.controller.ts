import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';

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
        sameAs: job.client?.website || 'https://orricaedge.com',
        logo: 'https://orricaedge.com/icons/icon-192x192.png',
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
    const minSalary = job.salaryMin ? Number(job.salaryMin) : undefined;
    const maxSalary = job.salaryMax ? Number(job.salaryMax) : undefined;

    if ((minSalary && minSalary > 0) || (maxSalary && maxSalary > 0)) {
      const isAnnual = (minSalary && minSalary >= 100000) || (maxSalary && maxSalary >= 100000);
      schema.baseSalary = {
        '@type': 'MonetaryAmount',
        currency: 'INR',
        value: {
          '@type': 'QuantitativeValue',
          ...(minSalary && minSalary > 0 ? { minValue: minSalary } : {}),
          ...(maxSalary && maxSalary > 0 ? { maxValue: maxSalary } : {}),
          unitText: isAnnual ? 'YEAR' : 'MONTH',
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
