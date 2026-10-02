import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { uploadResumeFile } from '../services/storage.service';
import { sendSuccess, sendError } from '../utils/response';
import { createNotification } from '../services/notification.service';

const universalFormBodySchema = z.object({
  name: z.string().min(2).max(120).optional(),
  slug: z.string().max(120).optional(),
  description: z.string().max(5000).optional().nullable(),
  fields: z.array(z.record(z.any())).min(1).optional(),
  successMessage: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
});

const defaultFields = [
  { key: 'fullName', label: 'Full Name', type: 'text', required: true, placeholder: 'Enter your full name' },
  { key: 'email', label: 'Email Address', type: 'email', required: true, placeholder: 'Enter your email address' },
  { key: 'phone', label: 'Phone Number', type: 'tel', required: true, placeholder: 'Enter your phone number' },
  { key: 'location', label: 'Current Location', type: 'text', required: true, placeholder: 'City, State' },
  { key: 'education', label: 'Highest Qualification', type: 'text', required: false },
  { key: 'experienceYears', label: 'Experience (Years)', type: 'number', required: false },
  { key: 'currentCompany', label: 'Current Company', type: 'text', required: false },
  { key: 'currentDesignation', label: 'Current Designation', type: 'text', required: false },
  { key: 'currentCtc', label: 'Current CTC', type: 'number', required: false },
  { key: 'expectedCtc', label: 'Expected CTC', type: 'number', required: false },
  { key: 'noticePeriodDays', label: 'Notice Period (Days)', type: 'number', required: false },
  { key: 'skills', label: 'Skills', type: 'text', required: false, placeholder: 'JavaScript, Excel, Customer Support' },
  { key: 'languages', label: 'Languages', type: 'text', required: false, placeholder: 'English, Hindi' },
  { key: 'resume', label: 'Resume', type: 'file', required: true },
];

const normalizeSlug = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'candidates-form';
};

const getUniqueSlug = async (requestedSlug: string, excludeId?: string): Promise<string> => {
  const base = normalizeSlug(requestedSlug);
  let candidate = base;
  let counter = 2;

  while (true) {
    const existing = await prisma.universalForm.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });

    if (!existing || existing.id === excludeId) {
      return candidate;
    }

    candidate = `${base}-${counter}`;
    counter += 1;
  }
};

const getDigits = (value: unknown): string => String(value ?? '').replace(/\D/g, '');

const getLast10Digits = (value: unknown): string => {
  const digits = getDigits(value);
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Treat non-JSON strings as comma-separated values.
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean);
};

const resolveRecruiterRef = async (value: unknown) => {
  const ref = String(value ?? '').trim();
  if (!ref) return null;

  const recruiter = await prisma.user.findFirst({
    where: {
      role: 'RECRUITER',
      isActive: true,
      OR: [
        { recruiterId: ref },
        { id: ref },
      ],
    },
    select: {
      id: true,
      recruiterId: true,
      fullName: true,
      recruiterType: true,
    },
  });

  return recruiter || null;
};

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const buildNextCandidateCode = async (): Promise<string> => {
  const lastCandidate = await prisma.candidate.findFirst({
    orderBy: { candidateCode: 'desc' },
    select: { candidateCode: true },
  });

  const current = lastCandidate?.candidateCode
    ? Number(lastCandidate.candidateCode.replace('OE-CAND-', ''))
    : 0;

  return `OE-CAND-${String((Number.isFinite(current) ? current : 0) + 1).padStart(4, '0')}`;
};

const validateConfiguredFields = (fields: Array<Record<string, unknown>>): string | null => {
  const seen = new Set<string>();

  for (const field of fields) {
    const key = String(field.key ?? '').trim();
    const label = String(field.label ?? '').trim();

    if (!key || !label) {
      return 'Every Universal Form field must contain a key and label.';
    }

    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
      return `Invalid field key: ${key}`;
    }

    if (seen.has(key)) {
      return `Duplicate field key: ${key}`;
    }

    seen.add(key);
  }

  return null;
};

export const ensureDefaultUniversalForm = async (): Promise<void> => {
  try {
    const existing = await prisma.universalForm.findUnique({
      where: { slug: 'candidates-form' },
      select: { id: true },
    });

    if (!existing) {
      await prisma.universalForm.create({
        data: {
          name: 'Candidates Form',
          slug: 'candidates-form',
          description: 'General candidate registration form.',
          fields: defaultFields,
          successMessage: 'Thank you. Your candidate profile has been submitted successfully.',
          isActive: true,
        },
      });
      console.log('[UNIVERSAL FORM] Default candidates-form created.');
    }
  } catch (error) {
    console.error('[UNIVERSAL FORM] Default form initialization failed:', error);
  }
};

export const getUniversalForms = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const forms = await prisma.universalForm.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { submissions: true } },
      },
    });

    sendSuccess(res, {
      forms: forms.map((form) => ({
        id: form.id,
        name: form.name,
        slug: form.slug,
        description: form.description,
        fields: form.fields,
        successMessage: form.successMessage,
        isActive: form.isActive,
        createdById: form.createdById,
        createdAt: form.createdAt,
        updatedAt: form.updatedAt,
        submissionCount: form._count.submissions,
        publicPath: `/candidates-form/${form.slug}`,
      })),
    });
  } catch (err) {
    next(err);
  }
};

export const getUniversalFormById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const form = await prisma.universalForm.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { submissions: true } } },
    });

    if (!form) {
      sendError(res, 'Universal Form not found', 404);
      return;
    }

    sendSuccess(res, {
      form: {
        ...form,
        submissionCount: form._count.submissions,
        publicPath: `/candidates-form/${form.slug}`,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const createUniversalForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = universalFormBodySchema.parse(req.body);
    const fields = data.fields ?? defaultFields;
    const fieldError = validateConfiguredFields(fields);

    if (fieldError) {
      sendError(res, fieldError, 400);
      return;
    }

    const slug = await getUniqueSlug(data.slug || 'candidates-form');

    const form = await prisma.universalForm.create({
      data: {
        name: data.name || 'Candidates Form',
        slug,
        description: data.description ?? null,
        fields,
        successMessage: data.successMessage ?? 'Thank you. Your candidate profile has been submitted successfully.',
        isActive: data.isActive ?? true,
        createdById: req.user?.userId || null,
      },
    });

    sendSuccess(
      res,
      {
        form: {
          ...form,
          publicPath: `/candidates-form/${form.slug}`,
          submissionCount: 0,
        },
      },
      'Universal Form created successfully',
      201
    );
  } catch (err) {
    next(err);
  }
};

export const updateUniversalForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = universalFormBodySchema.parse(req.body);

    const existing = await prisma.universalForm.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      sendError(res, 'Universal Form not found', 404);
      return;
    }

    const fields = data.fields ?? existing.fields;
    if (!Array.isArray(fields)) {
      sendError(res, 'Form fields must be an array', 400);
      return;
    }

    const fieldError = validateConfiguredFields(fields as Array<Record<string, unknown>>);
    if (fieldError) {
      sendError(res, fieldError, 400);
      return;
    }

    const slug = data.slug ? await getUniqueSlug(data.slug, existing.id) : existing.slug;

    const updated = await prisma.universalForm.update({
      where: { id: existing.id },
      data: {
        name: data.name ?? existing.name,
        slug,
        description: data.description === undefined ? existing.description : data.description,
        fields,
        successMessage:
          data.successMessage === undefined ? existing.successMessage : data.successMessage,
        isActive: data.isActive ?? existing.isActive,
      },
    });

    const count = await prisma.universalFormSubmission.count({
      where: { formId: updated.id },
    });

    sendSuccess(res, {
      form: {
        ...updated,
        publicPath: `/candidates-form/${updated.slug}`,
        submissionCount: count,
      },
    }, 'Universal Form updated successfully');
  } catch (err) {
    next(err);
  }
};

export const deleteUniversalForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const existing = await prisma.universalForm.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, slug: true },
    });

    if (!existing) {
      sendError(res, 'Universal Form not found', 404);
      return;
    }

    const updated = await prisma.universalForm.update({
      where: { id: existing.id },
      data: { isActive: false },
    });

    sendSuccess(res, {
      form: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        isActive: updated.isActive,
        publicPath: `/candidates-form/${updated.slug}`,
      },
    }, 'Universal Form deactivated successfully');
  } catch (err) {
    next(err);
  }
};

export const getPublicUniversalForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const slug = normalizeSlug(req.params.slug);

    const form = await prisma.universalForm.findFirst({
      where: {
        slug,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        fields: true,
        successMessage: true,
      },
    });

    if (!form) {
      sendError(res, 'Candidate form not found or inactive', 404);
      return;
    }

    sendSuccess(res, {
      form: {
        ...form,
        publicPath: `/candidates-form/${form.slug}`,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const submitPublicUniversalForm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const slug = normalizeSlug(req.params.slug);

    const form = await prisma.universalForm.findFirst({
      where: { slug, isActive: true },
    });

    if (!form) {
      sendError(res, 'Candidate form not found or inactive', 404);
      return;
    }

    const body = req.body || {};
    const recruiter = await resolveRecruiterRef(body.recruiterRef || body.recruiterId);
    const jobId = String(body.jobId || '').trim() || null;

    if ((body.recruiterRef || body.recruiterId) && !recruiter) {
      sendError(res, 'The recruiter link is invalid or the recruiter account is inactive.', 400);
      return;
    }

    let targetJob: { id: string; title: string; status: string } | null = null;
    if (jobId) {
      targetJob = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, title: true, status: true },
      });

      if (!targetJob) {
        sendError(res, 'The selected job is no longer available.', 404);
        return;
      }

      if (String(targetJob.status).toUpperCase() !== 'PUBLISHED') {
        sendError(res, 'The selected job is not currently open for submissions.', 400);
        return;
      }
    }

    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const location = String(body.location || '').trim();

    if (!fullName || !email || !phone || !location) {
      sendError(res, 'Full name, email, phone number and current location are required.', 400);
      return;
    }

    const emailCheck = z.string().email().safeParse(email);
    if (!emailCheck.success) {
      sendError(res, 'Please provide a valid email address.', 400);
      return;
    }

    const phoneDigits = getLast10Digits(phone);
    if (phoneDigits.length < 10) {
      sendError(res, 'Please provide a valid 10-digit phone number.', 400);
      return;
    }

    const configuredFields = Array.isArray(form.fields) ? (form.fields as Array<Record<string, unknown>>) : [];
    for (const field of configuredFields) {
      if (!field.required) continue;

      const key = String(field.key || '').trim();
      if (key === 'resume') {
        if (!req.file) {
          sendError(res, 'Resume is required.', 400);
          return;
        }
        continue;
      }

      const value = body[key];
      if (value === undefined || value === null || String(value).trim() === '') {
        sendError(res, `${String(field.label || key)} is required.`, 400);
        return;
      }
    }

    if (!req.file) {
      const candidateByEmail = await prisma.candidate.findUnique({
        where: { email },
        select: { resumeUrl: true },
      });
      if (!candidateByEmail) {
        sendError(res, 'Resume file is required (PDF or DOC/DOCX up to 5MB).', 400);
        return;
      }
    }

    const uploadResult = req.file
      ? await uploadResumeFile(req.file, fullName)
      : null;

    const candidateData = {
      fullName,
      phone: phoneDigits,
      location,
      education: String(body.education || '').trim() || undefined,
      experienceYears: parseOptionalNumber(body.experienceYears) ?? 0,
      currentCompany: String(body.currentCompany || '').trim() || undefined,
      currentDesignation: String(body.currentDesignation || '').trim() || undefined,
      currentCtc: parseOptionalNumber(body.currentCtc),
      expectedCtc: parseOptionalNumber(body.expectedCtc),
      noticePeriodDays: parseOptionalNumber(body.noticePeriodDays),
      skills: parseList(body.skills),
      languages: parseList(body.languages).length ? parseList(body.languages) : ['English'],
      source: String(body.source || '').trim() || `Universal Form: ${form.slug}`,
      tags: parseList(body.tags),
      notes: String(body.notes || '').trim() || undefined,
      feedback: String(body.feedback || '').trim() || undefined,
      dateOfJoin: parseDate(body.dateOfJoin),
    };

    const result = await prisma.$transaction(async (tx) => {
      const existingByEmail = await tx.candidate.findUnique({
        where: { email },
      });

      const existingByPhone = existingByEmail
        ? null
        : await tx.candidate.findFirst({
            where: { phone: { endsWith: phoneDigits } },
          });

      const existing = existingByEmail || existingByPhone;

      let candidate;
      if (existing) {
        candidate = await tx.candidate.update({
          where: { id: existing.id },
          data: {
            ...candidateData,
            email: existing.email,
            resumeUrl: uploadResult?.fileUrl || existing.resumeUrl,
          },
        });
      } else {
        const candidateCode = await buildNextCandidateCode();

        candidate = await tx.candidate.create({
          data: {
            candidateCode,
            email,
            resumeUrl: uploadResult?.fileUrl || '',
            ...candidateData,
            ownerRecruiterId: recruiter?.id || null,
            createdById: recruiter?.id || null,
            status: recruiter ? 'SCREENING' : 'NEW',
          },
        });
      }

      let application = null;

      if (targetJob) {
        const existingApplication = await tx.application.findUnique({
          where: {
            jobId_candidateId: {
              jobId: targetJob.id,
              candidateId: candidate.id,
            },
          },
          select: { id: true },
        });

        if (!existingApplication) {
          application = await tx.application.create({
            data: {
              candidateId: candidate.id,
              jobId: targetJob.id,
              recruiterId: recruiter?.id || null,
              stage: 'APPLIED',
              timeline: [{
                stage: 'APPLIED',
                at: new Date().toISOString(),
                by: recruiter?.id || 'PUBLIC_FORM',
              }],
            },
          });
        } else {
          application = existingApplication;
        }
      }

      const activity = await tx.candidateActivity.create({
        data: {
          candidateId: candidate.id,
          userId: recruiter?.id || null,
          recruiterId: recruiter?.id || null,
          applicationId: application?.id || null,
          jobId: targetJob?.id || null,
          action: 'PUBLIC_FORM_SUBMITTED',
          notes: String(body.feedback || body.notes || '').trim() || null,
          metadata: {
            formSlug: form.slug,
            recruiterRef: recruiter?.recruiterId || null,
            jobTitle: targetJob?.title || null,
            source: 'UNIVERSAL_PUBLIC_FORM',
          },
        },
      });

      const submission = await tx.universalFormSubmission.create({
        data: {
          formId: form.id,
          candidateId: candidate.id,
          payload: {
            ...body,
            recruiterRef: recruiter?.recruiterId || body.recruiterRef || null,
            jobId: targetJob?.id || null,
            resumeFileName: uploadResult?.key || req.file?.originalname || null,
          },
          resumeUrl: uploadResult?.fileUrl || null,
          resumeFileName: req.file?.originalname || null,
        },
      });

      return { candidate, submission, application, activity };
    });

    if (recruiter) {
      await createNotification({
        userId: recruiter.id,
        title: 'New candidate received',
        message: `${result.candidate.fullName} submitted their profile through your candidate link${targetJob ? ` for ${targetJob.title}` : ''}.`,
        type: 'CANDIDATE_ADDED',
        link: '/recruiter/candidates',
      });
    }

    sendSuccess(
      res,
      {
        candidateId: result.candidate.id,
        candidateCode: result.candidate.candidateCode,
        submissionId: result.submission.id,
        applicationId: result.application?.id || null,
        recruiter: recruiter
          ? {
              id: recruiter.id,
              recruiterId: recruiter.recruiterId,
              name: recruiter.fullName,
              recruiterType: recruiter.recruiterType,
            }
          : null,
        job: targetJob
          ? { id: targetJob.id, title: targetJob.title }
          : null,
        formSlug: form.slug,
      },
      form.successMessage || 'Your candidate profile has been submitted successfully.',
      201
    );
  } catch (err: any) {
    if (err?.code === 'P2002') {
      sendError(res, 'A candidate with these details already exists. Please verify your email and phone number.', 409);
      return;
    }
    next(err);
  }
};

export const getUniversalFormSubmissions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, Number.parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const form = await prisma.universalForm.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!form) {
      sendError(res, 'Universal Form not found', 404);
      return;
    }

    const [total, submissions] = await Promise.all([
      prisma.universalFormSubmission.count({ where: { formId: form.id } }),
      prisma.universalFormSubmission.findMany({
        where: { formId: form.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
    ]);

    sendSuccess(res, {
      submissions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};
