import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: z.coerce.boolean().default(false),
});

export const getMyNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, 'Authentication required.', 401);
      return;
    }

    const { limit, unreadOnly } = listSchema.parse(req.query);

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId,
          ...(unreadOnly ? { isRead: false } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({
        where: { userId, isRead: false },
      }),
    ]);

    sendSuccess(res, { notifications, unreadCount });
  } catch (err) {
    next(err);
  }
};

export const markNotificationRead = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const id = req.params.id;

    if (!userId) {
      sendError(res, 'Authentication required.', 401);
      return;
    }

    const notification = await prisma.notification.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!notification) {
      sendError(res, 'Notification not found.', 404);
      return;
    }

    await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    sendSuccess(res, { notificationId: id }, 'Notification marked as read.');
  } catch (err) {
    next(err);
  }
};

export const markAllNotificationsRead = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      sendError(res, 'Authentication required.', 401);
      return;
    }

    const result = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    sendSuccess(res, { updatedCount: result.count }, 'All notifications marked as read.');
  } catch (err) {
    next(err);
  }
};
