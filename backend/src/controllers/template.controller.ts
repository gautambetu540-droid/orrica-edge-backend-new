import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import {
  DEFAULT_TEMPLATES,
  compileEmailTemplate,
  interpolateVariables,
  wrapHtmlEmail,
} from '../services/templateEngine.service';
import { dispatchEmail } from '../services/email.service';
import { cache } from '../utils/cache';
import { sendSuccess, sendError } from '../utils/response';
import { logAudit } from '../services/audit.service';

const updateTemplateSchema = z.object({
  name: z.string().min(2).optional(),
  subject: z.string().min(2).optional(),
  htmlBody: z.string().min(5).optional(),
  plainText: z.string().optional(),
  isActive: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
});

// 1. Get All Templates (Seeds from DEFAULT_TEMPLATES if DB is empty)
export const getEmailTemplates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category, search } = req.query;

    let templates = await prisma.emailTemplate.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    // Auto-seed defaults into DB if empty
    if (templates.length === 0) {
      const defaultList = Object.values(DEFAULT_TEMPLATES);
      await prisma.emailTemplate.createMany({
        data: defaultList.map((dt) => ({
          templateKey: dt.templateKey,
          name: dt.name,
          category: dt.category,
          subject: dt.subject,
          htmlBody: dt.htmlBody,
          plainText: dt.plainText,
          variables: dt.variables,
          isActive: true,
          isDefault: true,
        })),
        skipDuplicates: true,
      });

      templates = await prisma.emailTemplate.findMany({
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
    }

    // Filter in-memory if query params passed
    let filtered = templates;
    if (category && category !== 'All') {
      filtered = filtered.filter((t) => t.category.toLowerCase() === (category as string).toLowerCase());
    }
    if (search) {
      const q = (search as string).toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.templateKey.toLowerCase().includes(q) ||
          t.subject.toLowerCase().includes(q)
      );
    }

    sendSuccess(res, { templates: filtered });
  } catch (err) {
    next(err);
  }
};

// 2. Get Single Template by Key or ID
export const getEmailTemplateByKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key } = req.params;

    let template = await prisma.emailTemplate.findFirst({
      where: { OR: [{ templateKey: key }, { id: key }] },
    });

    if (!template && DEFAULT_TEMPLATES[key]) {
      const dt = DEFAULT_TEMPLATES[key];
      template = await prisma.emailTemplate.create({
        data: {
          templateKey: dt.templateKey,
          name: dt.name,
          category: dt.category,
          subject: dt.subject,
          htmlBody: dt.htmlBody,
          plainText: dt.plainText,
          variables: dt.variables,
          isActive: true,
          isDefault: true,
        },
      });
    }

    if (!template) {
      sendError(res, 'Email template not found', 404);
      return;
    }

    sendSuccess(res, { template });
  } catch (err) {
    next(err);
  }
};

// 3. Update Email Template (Immediately activates live for subsequent emails)
export const updateEmailTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const data = updateTemplateSchema.parse(req.body);

    const existing = await prisma.emailTemplate.findFirst({
      where: { OR: [{ id }, { templateKey: id }] },
    });

    if (!existing) {
      sendError(res, 'Template not found', 404);
      return;
    }

    const updated = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        ...data,
        updatedBy: req.user?.email || 'Admin',
      },
    });

    // Invalidate template in cache so NEXT email uses this new content immediately!
    cache.del(`email_tpl:${existing.templateKey}`);

    await logAudit({
      req,
      action: 'UPDATE_EMAIL_TEMPLATE',
      module: 'TEMPLATES',
      entity: 'EmailTemplate',
      entityId: existing.id,
      oldValue: { subject: existing.subject },
      newValue: { subject: updated.subject },
    });

    sendSuccess(res, { template: updated }, 'Email template updated successfully. Live emails will now use this version.');
  } catch (err) {
    next(err);
  }
};

// 4. Reset Template to Default
export const resetEmailTemplateToDefault = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    const existing = await prisma.emailTemplate.findFirst({
      where: { OR: [{ id }, { templateKey: id }] },
    });

    if (!existing) {
      sendError(res, 'Template not found', 404);
      return;
    }

    const defaultTpl = DEFAULT_TEMPLATES[existing.templateKey];
    if (!defaultTpl) {
      sendError(res, 'No default system template found for this key', 400);
      return;
    }

    const reset = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        name: defaultTpl.name,
        subject: defaultTpl.subject,
        htmlBody: defaultTpl.htmlBody,
        plainText: defaultTpl.plainText,
        variables: defaultTpl.variables,
        isActive: true,
        updatedBy: req.user?.email || 'Admin',
      },
    });

    cache.del(`email_tpl:${existing.templateKey}`);

    sendSuccess(res, { template: reset }, 'Template reset to original default configuration.');
  } catch (err) {
    next(err);
  }
};

// 5. Live Preview Template with Sample Tokens
export const previewEmailTemplate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { htmlBody, subject, sampleVariables } = req.body;

    const dummyVars: Record<string, string> = {
      candidate_name: 'Rahul Sharma',
      candidate_email: 'rahul.sharma@example.com',
      job_title: 'International Customer Support Associate',
      job_code: 'OE-2026-001',
      job_location: 'Gurugram, Haryana',
      company_name: 'Concentrix Global',
      application_id: 'OE-APP-98214',
      interview_round: 'HR & Speech Modulation Round',
      interview_date: 'Mon, 28 Sep 2026',
      interview_time: '11:30 AM IST',
      interviewer_name: 'Pooja Verma (Lead Recruiter)',
      meeting_link: 'https://meet.google.com/oe-demo-interview',
      recruiter_name: 'Pooja Verma',
      client_name: 'Mr. Kapoor',
      dashboard_url: 'https://orricaedge.com',
      support_email: 'no-reply@orricaedge.com',
      ...(sampleVariables || {}),
    };

    const previewSubject = interpolateVariables(subject || '', dummyVars);
    const content = interpolateVariables(htmlBody || '', dummyVars);
    const previewHtml = wrapHtmlEmail(content);

    sendSuccess(res, {
      subject: previewSubject,
      html: previewHtml,
    });
  } catch (err) {
    next(err);
  }
};

// 6. Send Test Email
export const sendTestEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { templateKey, recipientEmail, customVariables } = req.body;

    if (!recipientEmail) {
      sendError(res, 'Recipient email is required for test dispatch', 400);
      return;
    }

    const testVars: Record<string, string> = {
      candidate_name: 'Test Candidate',
      candidate_email: recipientEmail,
      job_title: 'Customer Operations Specialist (TEST MODE)',
      job_code: 'OE-TEST-2026',
      job_location: 'Gurugram, Haryana',
      application_id: 'APP-TEST-001',
      interview_round: 'HR Screening (TEST)',
      interview_date: new Date().toLocaleDateString(),
      interview_time: '12:00 PM',
      interviewer_name: 'Orrica Test Lead',
      meeting_link: 'https://orricaedge.com',
      ...(customVariables || {}),
    };

    // Dispatch asynchronously
    dispatchEmail(templateKey || 'APPLICATION_RECEIVED', recipientEmail, testVars);

    sendSuccess(res, { recipient: recipientEmail }, `Test email dispatched to ${recipientEmail} via Resend`);
  } catch (err) {
    next(err);
  }
};

// 7. Get Email Logs (Audit trail)
export const getEmailLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { page = '1', limit = '25', recipient, status } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (recipient) where.recipient = { contains: recipient as string, mode: 'insensitive' };
    if (status) where.status = status as any;

    const [total, logs] = await Promise.all([
      prisma.emailLog.count({ where }),
      prisma.emailLog.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    sendSuccess(res, {
      logs,
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
