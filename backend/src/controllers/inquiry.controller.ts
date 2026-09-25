import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';

const employerInquirySchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  companyName: z.string().min(2),
  requirements: z.string().min(10),
});

const partnerInquirySchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  requirements: z.string().optional(),
});

const contactInquirySchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  requirements: z.string().min(5),
});

// 1. Submit Employer "Hire Talent" Form
export const submitEmployerInquiry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = employerInquirySchema.parse(req.body);

    const inquiry = await prisma.inquiry.create({
      data: {
        type: 'EMPLOYER_HIRE_TALENT',
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        companyName: data.companyName,
        requirements: data.requirements,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Hiring inquiry submitted successfully! Our enterprise talent advisors will connect within 24 hours.',
      data: { inquiry },
    });
  } catch (err) {
    next(err);
  }
};

// 2. Submit "For Recruiters" Partner Application
export const submitRecruiterPartnerInquiry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = partnerInquirySchema.parse(req.body);

    const inquiry = await prisma.inquiry.create({
      data: {
        type: 'RECRUITER_PARTNER',
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        requirements: data.requirements,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Recruiter partner inquiry received! We will reach out with partnership terms and portal credentials.',
      data: { inquiry },
    });
  } catch (err) {
    next(err);
  }
};

// 3. Submit General Contact Inquiry
export const submitContactInquiry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const data = contactInquirySchema.parse(req.body);

    const inquiry = await prisma.inquiry.create({
      data: {
        type: 'CONTACT_US',
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        requirements: data.requirements,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Message sent! Our support team will get back to you shortly.',
      data: { inquiry },
    });
  } catch (err) {
    next(err);
  }
};

// 4. Get All Inquiries (Admin)
export const getInquiries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { type, status } = req.query;

    const where: any = {};
    if (type) where.type = type as any;
    if (status) where.status = status as any;

    const inquiries = await prisma.inquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: { inquiries } });
  } catch (err) {
    next(err);
  }
};
