import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';

const recruiterApplicationSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  location: z.string().min(2),
  experienceYears: z.coerce.number().min(0).max(60).default(0),
  primaryDomain: z.string().max(120).optional(),
  currentCompany: z.string().max(200).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal('')),
  message: z.string().max(5000).optional(),
  resumeUrl: z.string().url().optional().or(z.literal('')),
  resumeFileName: z.string().max(255).optional(),
});

export const submitRecruiterApplication = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = recruiterApplicationSchema.parse(req.body);

    const application = await prisma.recruiterApplication.create({
      data: {
        fullName: data.fullName.trim(),
        email: data.email.trim().toLowerCase(),
        phone: data.phone.trim(),
        location: data.location.trim(),
        experienceYears: data.experienceYears,
        primaryDomain: data.primaryDomain?.trim() || null,
        currentCompany: data.currentCompany?.trim() || null,
        linkedinUrl: data.linkedinUrl?.trim() || null,
        message: data.message?.trim() || null,
        resumeUrl: data.resumeUrl?.trim() || null,
        resumeFileName: data.resumeFileName?.trim() || null,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Recruiter application submitted successfully.',
      data: { application },
    });
  } catch (err) {
    next(err);
  }
};

export const getRecruiterApplications = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { status } = req.query;

    const applications = await prisma.recruiterApplication.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: { applications },
    });
  } catch (err) {
    next(err);
  }
};
