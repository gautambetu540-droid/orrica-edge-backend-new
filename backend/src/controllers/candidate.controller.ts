      exists: false,
      candidate: null,
    });
  } catch (err) {
    next(err);
  }
};


export const getCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      search,
      status,
      location,
      skill,
      language,
      source,
      recruiterId,
      sourcingRecruiterId,
      teamLeaderId,
      ownerRecruiterId,
      createdById,
      jobId,
      workMode,
      employmentType,
      walkInStatus,
      walkInOnly,
      walkInDateFrom,
      walkInDateTo,
      followUpDateFrom,
      followUpDateTo,
      followUpPending,
      followUpCategory,
      nextActionType,
      joiningDateFrom,
      joiningDateTo,
      dateFrom,
      dateTo,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;
