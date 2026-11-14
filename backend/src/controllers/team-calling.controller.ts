import { Request, Response } from 'express';
import { fetchTeamCallingSummary } from '../services/team-calling.service';

/**
 * GET /api/v1/admin/team-calling/summary
 * Query parameters:
 *  - from: string (YYYY-MM-DD or ISO)
 *  - to: string (YYYY-MM-DD or ISO)
 *  - location: string (e.g. 'all', 'Indore', 'Noida')
 *  - recruiterIds: comma-separated list of recruiter user IDs
 */
export async function getTeamCallingSummary(req: Request, res: Response) {
  try {
    const { from, to, location, recruiterIds } = req.query;

    const summary = await fetchTeamCallingSummary({
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      location: location ? String(location) : undefined,
      recruiterIds: recruiterIds ? String(recruiterIds) : undefined,
    });

    return res.status(200).json({
      success: true,
      message: 'Team calling summary aggregated successfully.',
      data: summary,
    });
  } catch (error: any) {
    console.error('Error fetching team calling summary:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to aggregate team calling summary.',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error?.message,
      },
    });
  }
}

