import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';

// Generate Google-compliant Schema.org JobPosting JSON-LD
export const getJobPostingJsonLd = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;

    const job = await prisma.job.findFirst({
      where: { OR: [{ slug }, { id: slug }] },
      include: { client: true },
    });

    if (!job) {
      sendError(res, 'Job not found', 404);
      return;
    }

    const schema = {
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: job.title,
      description: job.contentHtml,
      identifier: {
        '@type': 'PropertyValue',
        name: 'Orrica Edge',
        value: job.jobCode,
      },
      datePosted: job.publishedAt ? job.publishedAt.toISOString() : job.createdAt.toISOString(),
      validThrough: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      employmentType: job.employmentType,
      hiringOrganization: {
        '@type': 'Organization',
        name: job.client.companyName || 'Orrica Edge Recruitment Solutions',
        sameAs: job.client.website || 'https://orricaedge.com',
        logo: 'https://orricaedge.com/logo.png',
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: job.location,
          addressRegion: 'Haryana',
          addressCountry: 'IN',
        },
      },
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'INR',
        value: {
          '@type': 'QuantitativeValue',
          minValue: job.salaryMin ? Number(job.salaryMin) : 300000,
          maxValue: job.salaryMax ? Number(job.salaryMax) : 480000,
          unitText: 'YEAR',
        },
      },
      skills: job.skills.join(', '),
    };

    sendSuccess(res, { schema });
  } catch (err) {
    next(err);
  }
};
