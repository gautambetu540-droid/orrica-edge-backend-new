import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import {
  sendContactInquiryEmails,
  sendEmployerRequirementEmails,
  RESPONSE_TIME_TEXT,
} from '../services/formEmail.service';

/**
 * Valid Indian and international phone format:
 * Allows optional +, spaces, hyphens, parentheses, and requires 10 to 15 digits.
 */
const phoneRegex = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{7,16}$/;

/**
 * Count URLs present in free-text fields.
 */
const countUrls = (text?: string | null): number => {
  if (!text) return 0;
  const matches = text.match(/(?:https?:\/\/|www\.)[^\s]+/gi);
  return matches ? matches.length : 0;
};

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

export const contactInquirySchema = z.object({
  fullName: z
    .string({ required_error: 'Full name is required' })
    .trim()
    .min(1, 'Full name is required')
    .max(100, 'Full name cannot exceed 100 characters'),
  email: z
    .string({ required_error: 'Email address is required' })
    .trim()
    .email('Please enter a valid email address')
    .max(254, 'Email address cannot exceed 254 characters'),
  phone: z
    .string({ required_error: 'Phone number is required' })
    .trim()
    .min(10, 'Please enter a valid phone number with at least 10 digits')
    .max(20, 'Phone number cannot exceed 20 characters')
    .refine((val) => phoneRegex.test(val.replace(/\s+/g, '')), {
      message: 'Please enter a valid phone number (e.g., +91 98765 43210)',
    }),
  category: z
    .enum(
      [
        'Employer Hiring Inquiry',
        'Candidate Job Application / Support',
        'Recruiter Network Partnership',
        'General Inquiry / Verification',
      ],
      {
        errorMap: () => ({ message: 'Please select a valid inquiry category' }),
      }
    ),
  subject: z
    .string()
    .trim()
    .max(150, 'Subject cannot exceed 150 characters')
    .optional()
    .nullable(),
  message: z
    .string({ required_error: 'Message is required' })
    .trim()
    .min(1, 'Message is required')
    .max(3000, 'Message cannot exceed 3,000 characters'),
  source: z
    .string()
    .trim()
    .max(50, 'Source tag cannot exceed 50 characters')
    .optional()
    .nullable(),
  formStartedAt: z.union([z.number(), z.string()]).optional().nullable(),
  honeypot: z.string().optional().nullable(),
});

export const employerRequirementSchema = z.object({
  fullName: z
    .string({ required_error: 'Contact name is required' })
    .trim()
    .min(1, 'Contact name is required')
    .max(100, 'Name cannot exceed 100 characters'),
  companyName: z
    .string({ required_error: 'Company name is required' })
    .trim()
    .min(1, 'Company name is required')
    .max(100, 'Company name cannot exceed 100 characters'),
  workEmail: z
    .string({ required_error: 'Work email is required' })
    .trim()
    .email('Please enter a valid work email')
    .max(254, 'Email cannot exceed 254 characters'),
  phone: z
    .string({ required_error: 'Phone number is required' })
    .trim()
    .min(10, 'Please enter a valid phone number with at least 10 digits')
    .max(20, 'Phone number cannot exceed 20 characters')
    .refine((val) => phoneRegex.test(val.replace(/\s+/g, '')), {
      message: 'Please enter a valid phone number (e.g., +91 98765 43210)',
    }),
  jobTitle: z
    .string({ required_error: 'Job title / role is required' })
    .trim()
    .min(1, 'Job title is required')
    .max(100, 'Job title cannot exceed 100 characters'),
  openings: z.coerce
    .number({ invalid_type_error: 'Number of openings must be a number' })
    .int('Number of openings must be an integer')
    .min(1, 'Minimum openings is 1')
    .max(10000, 'Maximum openings is 10,000')
    .default(1),
  location: z
    .string()
    .trim()
    .max(100, 'Location cannot exceed 100 characters')
    .optional()
    .nullable(),
  workMode: z
    .enum(['Hybrid', 'Remote / WFH', 'On-site Office', ''], {
      errorMap: () => ({ message: 'Please select a valid work mode' }),
    })
    .optional()
    .nullable(),
  jobType: z
    .enum(
      [
        'Permanent Full-Time',
        'Fixed-Term / Contract',
        'Internship Program',
        '',
      ],
      {
        errorMap: () => ({ message: 'Please select a valid job type' }),
      }
    )
    .optional()
    .nullable(),
  targetExperience: z
    .string()
    .trim()
    .max(100, 'Experience requirement cannot exceed 100 characters')
    .optional()
    .nullable(),
  additionalDetails: z
    .string()
    .trim()
    .max(3000, 'Additional details cannot exceed 3,000 characters')
    .optional()
    .nullable(),
  source: z
    .string()
    .trim()
    .max(50, 'Source tag cannot exceed 50 characters')
    .optional()
    .nullable(),
  formStartedAt: z.union([z.number(), z.string()]).optional().nullable(),
  honeypot: z.string().optional().nullable(),
});

// ============================================================================
// CONTROLLERS
// ============================================================================

/**
 * Handle POST /api/public/contact-inquiries
 */
export const submitPublicContactInquiry = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 1. Honeypot check (support both 'honeypot' and alternative honeypot fields)
    const rawHoneypot =
      req.body.honeypot || req.body.website || req.body.hp_field;
    if (rawHoneypot && String(rawHoneypot).trim().length > 0) {
      // Silently return success to waste bot resources
      res.status(200).json({
        success: true,
        message: 'Your message has been received.',
      });
      return;
    }

    // 2. Minimum fill-time verification (~2.5 to 3 seconds)
    const formStartedAt = req.body.formStartedAt
      ? Number(req.body.formStartedAt)
      : null;
    if (formStartedAt && Number.isFinite(formStartedAt)) {
      const elapsed = Date.now() - formStartedAt;
      if (elapsed < 2500) {
        res.status(400).json({
          success: false,
          errors: {
            form: 'Form submitted too quickly. Please review your details and submit again.',
          },
        });
        return;
      }
    }

    // 3. Schema validation
    const parsed = contactInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const fieldName = err.path.join('.') || 'form';
        if (!fieldErrors[fieldName]) {
          fieldErrors[fieldName] = err.message;
        }
      });
      res.status(400).json({
        success: false,
        errors: fieldErrors,
      });
      return;
    }

    const data = parsed.data;

    // 4. Excessive link protection in message
    if (countUrls(data.message) > 3) {
      res.status(400).json({
        success: false,
        errors: {
          message: 'Messages with more than 3 links are not permitted.',
        },
      });
      return;
    }

    // 5. Database persistence (Save first with PENDING email status)
    let inquiryRecord: any;
    try {
      inquiryRecord = await prisma.contactInquiry.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          category: data.category,
          subject: data.subject || null,
          message: data.message,
          source: data.source || null,
          emailStatus: 'PENDING',
        },
      });
    } catch (dbErr: any) {
      console.error('[DB SAVE FAILED - CONTACT INQUIRY]:', dbErr.message);
      res.status(500).json({
        success: false,
        message: 'Could not record inquiry. Please try again or contact us directly.',
      });
      return;
    }

    // 6. Email dispatch (Resend notification to sudhanshu@orricaedge.com + visitor auto-reply)
    let emailStatus: 'SENT' | 'FAILED' = 'SENT';
    let emailError: string | null = null;

    try {
      await sendContactInquiryEmails({
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        category: data.category,
        subject: data.subject || undefined,
        message: data.message,
        source: data.source || undefined,
        sourcePageUrl: req.headers.referer || req.headers.origin || undefined,
      });
    } catch (sendErr: any) {
      emailStatus = 'FAILED';
      emailError = sendErr?.message || 'Email delivery failed';
      // Mask email for privacy in logs
      const maskedEmail = data.email.replace(/(.{2})(.*)(?=@)/, '$1***');
      console.error(
        `[FORM EMAIL FAILED] Contact inquiry ${inquiryRecord.id} for ${maskedEmail}:`,
        sendErr?.message
      );
    }

    // 7. Update database record with final email delivery status
    try {
      await prisma.contactInquiry.update({
        where: { id: inquiryRecord.id },
        data: {
          emailStatus,
          emailError,
        },
      });
    } catch (updateErr: any) {
      console.warn('[DB STATUS UPDATE WARNING]:', updateErr.message);
    }

    // 8. Always return clean success to the visitor if DB record succeeded
    res.status(200).json({
      success: true,
      message: `Thank you, ${data.fullName}. We have received your message. Our team will connect with you ${RESPONSE_TIME_TEXT}.`,
      data: {
        id: inquiryRecord.id,
        fullName: data.fullName,
        category: data.category,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Handle POST /api/public/employer-requirements
 */
export const submitPublicEmployerRequirement = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 1. Honeypot check
    const rawHoneypot =
      req.body.honeypot || req.body.website || req.body.hp_field;
    if (rawHoneypot && String(rawHoneypot).trim().length > 0) {
      res.status(200).json({
        success: true,
        message: 'Your requirement has been received.',
      });
      return;
    }

    // 2. Minimum fill-time verification
    const formStartedAt = req.body.formStartedAt
      ? Number(req.body.formStartedAt)
      : null;
    if (formStartedAt && Number.isFinite(formStartedAt)) {
      const elapsed = Date.now() - formStartedAt;
      if (elapsed < 2500) {
        res.status(400).json({
          success: false,
          errors: {
            form: 'Form submitted too quickly. Please review your details and submit again.',
          },
        });
        return;
      }
    }

    // 3. Schema validation
    const parsed = employerRequirementSchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      parsed.error.errors.forEach((err) => {
        const fieldName = err.path.join('.') || 'form';
        if (!fieldErrors[fieldName]) {
          fieldErrors[fieldName] = err.message;
        }
      });
      res.status(400).json({
        success: false,
        errors: fieldErrors,
      });
      return;
    }

    const data = parsed.data;

    // 4. Excessive link protection in additional details
    if (countUrls(data.additionalDetails) > 3) {
      res.status(400).json({
        success: false,
        errors: {
          additionalDetails: 'Submissions with more than 3 links are not permitted.',
        },
      });
      return;
    }

    // 5. Database persistence (Save first with PENDING email status)
    let requirementRecord: any;
    try {
      requirementRecord = await prisma.employerRequirement.create({
        data: {
          fullName: data.fullName,
          companyName: data.companyName,
          workEmail: data.workEmail,
          phone: data.phone,
          jobTitle: data.jobTitle,
          openings: data.openings,
          location: data.location || null,
          workMode: data.workMode || null,
          jobType: data.jobType || null,
          targetExperience: data.targetExperience || null,
          additionalDetails: data.additionalDetails || null,
          source: data.source || null,
          emailStatus: 'PENDING',
        },
      });
    } catch (dbErr: any) {
      console.error('[DB SAVE FAILED - EMPLOYER REQUIREMENT]:', dbErr.message);
      res.status(500).json({
        success: false,
        message: 'Could not record requirement. Please try again or contact us directly.',
      });
      return;
    }

    // 6. Email dispatch (Resend notification to sudhanshu@orricaedge.com + employer auto-reply)
    let emailStatus: 'SENT' | 'FAILED' = 'SENT';
    let emailError: string | null = null;

    try {
      await sendEmployerRequirementEmails({
        fullName: data.fullName,
        companyName: data.companyName,
        workEmail: data.workEmail,
        phone: data.phone,
        jobTitle: data.jobTitle,
        openings: data.openings,
        location: data.location || undefined,
        workMode: data.workMode || undefined,
        jobType: data.jobType || undefined,
        targetExperience: data.targetExperience || undefined,
        additionalDetails: data.additionalDetails || undefined,
        source: data.source || undefined,
        sourcePageUrl: req.headers.referer || req.headers.origin || undefined,
      });
    } catch (sendErr: any) {
      emailStatus = 'FAILED';
      emailError = sendErr?.message || 'Email delivery failed';
      const maskedEmail = data.workEmail.replace(/(.{2})(.*)(?=@)/, '$1***');
      console.error(
        `[FORM EMAIL FAILED] Employer requirement ${requirementRecord.id} for ${maskedEmail}:`,
        sendErr?.message
      );
    }

    // 7. Update database record with final email delivery status
    try {
      await prisma.employerRequirement.update({
        where: { id: requirementRecord.id },
        data: {
          emailStatus,
          emailError,
        },
      });
    } catch (updateErr: any) {
      console.warn('[DB STATUS UPDATE WARNING]:', updateErr.message);
    }

    // 8. Return success response to the employer
    res.status(200).json({
      success: true,
      message: `Thank you, ${data.fullName}. We have received your hiring requirement for ${data.companyName}. An Enterprise Practice Lead will connect with you ${RESPONSE_TIME_TEXT}.`,
      data: {
        id: requirementRecord.id,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
      },
    });
  } catch (err) {
    next(err);
  }
};
