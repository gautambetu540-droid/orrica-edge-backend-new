import { prisma } from '../prisma/client';

export type NotificationInput = {
  userId: string;
  title: string;
  message: string;
  type?: string;
  link?: string;
};

export const createNotification = async (input: NotificationInput) => {
  return prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      message: input.message,
      type: input.type || 'INFO',
      link: input.link || null,
    },
  });
};

export const createNotifications = async (items: NotificationInput[]) => {
  if (!items.length) return [];
  return prisma.$transaction(
    items.map((item) =>
      prisma.notification.create({
        data: {
          userId: item.userId,
          title: item.title,
          message: item.message,
          type: item.type || 'INFO',
          link: item.link || null,
        },
      })
    )
  );
};
