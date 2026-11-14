import { Request, Response, NextFunction } from 'express';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { prisma } from '../prisma/client';
import { sendSuccess, sendError } from '../utils/response';
import { normalizeIndianPhone } from '../utils/phone';
import { generateCandidateCodesBatch } from '../utils/codeGenerators';
import { logCandidateTimeline } from '../services/timeline.service';
import { logAudit } from '../services/audit.service';

/**
 * Clean and sanitize string against CSV/Formula injection
 */
const sanitizeCellValue = (val: any): string => {
  if (val === null || val === undefined) return '';
  let str = String(val).trim();
  if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
    str = "'" + str;
  }
  return str;
};

/**
 * Canonical 27 Universal Headers for Candidate Bulk Import
 */
export const CANONICAL_BULK_IMPORT_HEADERS = [
  'Full Name',
  'Phone',
  'Email',
  'Father Name',
  'Date of Birth (YYYY-MM-DD)',
  'Gender (Male/Female/Other)',
  'Current Location',
  'Preferred Location',
  'Total Experience (Years)',
  'Relevant Experience (Years)',
  'Highest Qualification',
  'Education',
  'Current Company',
  'Current Designation',
  'Previous Company',
  'Notice Period',
  'Notice Period Days',
  'Current Monthly Salary',
  'Expected Monthly Salary',
  'Current CTC',
  'Expected CTC',
  'Skills (comma-separated)',
  'Languages (comma-separated)',
  'Resume URL',
  'Source',
  'Tags (comma-separated)',
  'Notes',
] as const;

/**
 * Normalizes 10-digit Indian phone number and guards against scientific notation corruption
 */
export const normalizePhoneNumber = (raw: any): { phone: string; isValid: boolean; error?: string } => {
  if (!raw) return { phone: '', isValid: false, error: 'Phone number is required.' };
  const rawStr = String(raw).trim();
  const normalized = normalizeIndianPhone(raw);
  if (normalized) {
    return { phone: normalized, isValid: true };
  }
  return {
    phone: rawStr,
    isValid: false,
    error: `Invalid phone number '${rawStr}'. Must be a valid 10-digit Indian mobile number.`,
  };
};

/**
 * Parses and validates Date of Birth (YYYY-MM-DD or Excel serial, past date, age 18+)
 */
export const parseDateOfBirth = (val: any): { date: Date | null; error?: string } => {
  if (!val) return { date: null };
  const str = String(val).trim();
  if (!str) return { date: null };

  let date: Date | null = null;

  // Check for Excel serial number (typically 10000 - 60000)
  const numVal = Number(str);
  if (!isNaN(numVal) && numVal > 1000 && numVal < 100000) {
    const utcDays = numVal - 25569;
    const utcValue = utcDays * 86400 * 1000;
    date = new Date(utcValue);
  } else if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(str)) {
    // DD-MM-YYYY format
    const parts = str.split(/[-/.]/);
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    date = new Date(Date.UTC(year, month, day));
  } else if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(str)) {
    // YYYY-MM-DD format
    const parts = str.split(/[-/.]/);
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    date = new Date(Date.UTC(year, month, day));
  } else {
    date = new Date(str);
  }

  if (!date || isNaN(date.getTime())) {
    return { date: null, error: `Invalid Date of Birth format '${str}'. Use YYYY-MM-DD.` };
  }

  const now = new Date();
  if (date > now) {
    return { date: null, error: 'Date of Birth cannot be in the future.' };
  }

  // Age 18+ verification
  const ageYears = (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 18) {
    return { date: null, error: 'Candidate must be at least 18 years old.' };
  }

  return { date };
};

/**
 * Normalizes Gender (case-insensitive Male/Female/Other, accepts M/F/O variants)
 */
export const parseGender = (val: any): { gender: 'MALE' | 'FEMALE' | 'OTHER' | null; error?: string } => {
  if (!val) return { gender: null };
  const raw = String(val).trim().toUpperCase();
  if (!raw) return { gender: null };

  if (['MALE', 'M', 'MAN'].includes(raw)) return { gender: 'MALE' };
  if (['FEMALE', 'F', 'WOMAN'].includes(raw)) return { gender: 'FEMALE' };
  if (['OTHER', 'O', 'NON-BINARY'].includes(raw)) return { gender: 'OTHER' };

  return {
    gender: null,
    error: `Invalid Gender '${val}'. Allowed values: Male, Female, Other.`,
  };
};

/**
 * Download standard Excel (.xlsx) or CSV import template with true Excel data validation dropdown
 * GET /api/v1/candidates/template/download
 */
export const downloadCandidateImportTemplate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const isCsv = req.query.format === 'csv';

    const sampleRowData = {
      'Full Name': 'Aarav Sharma (Example Row - DO NOT EDIT)',
      'Phone': '9876543210',
      'Email': 'aarav.sharma@example.com',
      'Father Name': 'Rajesh Sharma',
      'Date of Birth (YYYY-MM-DD)': '1996-05-15',
      'Gender (Male/Female/Other)': 'Male',
      'Current Location': 'Bengaluru, Karnataka',
      'Preferred Location': 'Bengaluru, Hyderabad',
      'Total Experience (Years)': '4.5',
      'Relevant Experience (Years)': '3.5',
      'Highest Qualification': 'B.Tech in Computer Science',
      'Education': 'B.Tech',
      'Current Company': 'Infosys Ltd',
      'Current Designation': 'Senior Software Engineer',
      'Previous Company': 'TCS',
      'Notice Period': '30 Days',
      'Notice Period Days': '30',
      'Current Monthly Salary': '65000',
      'Expected Monthly Salary': '85000',
      'Current CTC': '780000',
      'Expected CTC': '1020000',
      'Skills (comma-separated)': 'React, TypeScript, Node.js',
      'Languages (comma-separated)': 'English, Hindi',
      'Resume URL': 'https://example.com/resumes/aarav.pdf',
      'Source': 'Bulk Import',
      'Tags (comma-separated)': 'Frontend, Immediate Joiner',
      'Notes': 'Cleared technical round with strong coding assessment.',
    };

    if (isCsv) {
      const headers = [...CANONICAL_BULK_IMPORT_HEADERS];
      const row = headers.map(h => `"${(sampleRowData as any)[h] || ''}"`);
      const csvContent = [headers.join(','), row.join(',')].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Orrica_Edge_Candidate_Import_Template.csv"');
      res.send(csvContent);
      return;
    }

    // Build real Excel (.xlsx) using ExcelJS
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Orrica Edge LLP ATS';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Sheet 1: Candidates
    const candidatesSheet = workbook.addWorksheet('Candidates', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    candidatesSheet.columns = [
      { header: 'Full Name', key: 'fullName', width: 26 },
      { header: 'Phone', key: 'phone', width: 18, style: { numFmt: '@' } }, // Phone column as Text
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Father Name', key: 'fatherName', width: 22 },
      { header: 'Date of Birth (YYYY-MM-DD)', key: 'dateOfBirth', width: 26 },
      { header: 'Gender (Male/Female/Other)', key: 'gender', width: 26 },
      { header: 'Current Location', key: 'currentLocation', width: 24 },
      { header: 'Preferred Location', key: 'preferredLocation', width: 24 },
      { header: 'Total Experience (Years)', key: 'totalExperience', width: 24 },
      { header: 'Relevant Experience (Years)', key: 'relevantExperience', width: 24 },
      { header: 'Highest Qualification', key: 'highestQualification', width: 24 },
      { header: 'Education', key: 'education', width: 22 },
      { header: 'Current Company', key: 'currentCompany', width: 24 },
      { header: 'Current Designation', key: 'currentDesignation', width: 24 },
      { header: 'Previous Company', key: 'previousCompany', width: 24 },
      { header: 'Notice Period', key: 'noticePeriod', width: 20 },
      { header: 'Notice Period Days', key: 'noticePeriodDays', width: 20 },
      { header: 'Current Monthly Salary', key: 'currentSalary', width: 22 },
      { header: 'Expected Monthly Salary', key: 'expectedSalary', width: 22 },
      { header: 'Current CTC', key: 'currentCtc', width: 20 },
      { header: 'Expected CTC', key: 'expectedCtc', width: 20 },
      { header: 'Skills (comma-separated)', key: 'skills', width: 32 },
      { header: 'Languages (comma-separated)', key: 'languages', width: 26 },
      { header: 'Resume URL', key: 'resumeUrl', width: 34 },
      { header: 'Source', key: 'source', width: 20 },
      { header: 'Tags (comma-separated)', key: 'tags', width: 26 },
      { header: 'Notes', key: 'notes', width: 38 },
    ];

    // Style Header Row (Bold, Slate Background, White Text)
    const headerRow = candidatesSheet.getRow(1);
    headerRow.height = 28;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add Clearly Marked Example Row (Row 2)
    const exampleRow = candidatesSheet.addRow({
      fullName: 'Aarav Sharma (Example Row - DO NOT EDIT)',
      phone: '9876543210',
      email: 'aarav.sharma@example.com',
      fatherName: 'Rajesh Sharma',
      dateOfBirth: '1996-05-15',
      gender: 'Male',
      currentLocation: 'Bengaluru, Karnataka',
      preferredLocation: 'Bengaluru, Hyderabad',
      totalExperience: '4.5',
      relevantExperience: '3.5',
      highestQualification: 'B.Tech in Computer Science',
      education: 'B.Tech',
      currentCompany: 'Infosys Ltd',
      currentDesignation: 'Senior Software Engineer',
      previousCompany: 'TCS',
      noticePeriod: '30 Days',
      noticePeriodDays: '30',
      currentSalary: '65000',
      expectedSalary: '85000',
      currentCtc: '780000',
      expectedCtc: '1020000',
      skills: 'React, TypeScript, Node.js',
      languages: 'English, Hindi',
      resumeUrl: 'https://example.com/resumes/aarav.pdf',
      source: 'Bulk Import',
      tags: 'Frontend, Immediate Joiner',
      notes: 'Cleared technical round with strong coding assessment.',
    });
    exampleRow.font = { italic: true, color: { argb: 'FF475569' } };

    // Gender column Data Validation Dropdown for rows 2 to 5000 (Column F is index 6)
    (candidatesSheet as any).dataValidations.add('F2:F5000', {
      type: 'list',
      allowBlank: true,
      formulae: ['"Male,Female,Other"'],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Invalid Gender',
      error: 'Please select Male, Female, or Other from the dropdown list.',
      showInputMessage: true,
      promptTitle: 'Gender Dropdown',
      prompt: 'Select Gender: Male, Female, or Other',
    });

    // DOB column input message hint (Column E is index 5)
    (candidatesSheet as any).dataValidations.add('E2:E5000', {
      type: 'custom',
      allowBlank: true,
      formulae: ['ISNUMBER(E2)'],
      showInputMessage: true,
      promptTitle: 'DOB Format (YYYY-MM-DD)',
      prompt: 'Enter date in ISO format YYYY-MM-DD (e.g. 1996-05-15). Age must be 18+.',
    });

    // Sheet 2: Instructions
    const instructionsSheet = workbook.addWorksheet('Instructions');
    instructionsSheet.columns = [
      { header: 'Column Name', key: 'column', width: 28 },
      { header: 'Mandatory?', key: 'required', width: 16 },
      { header: 'Allowed Format / Values', key: 'format', width: 40 },
      { header: 'Example', key: 'example', width: 35 },
      { header: 'Important Instructions', key: 'notes', width: 50 },
    ];

    const instHeaderRow = instructionsSheet.getRow(1);
    instHeaderRow.height = 26;
    instHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    instHeaderRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' },
    };

    const instructionsData = [
      { column: 'Full Name', required: 'YES', format: 'Text (up to 150 chars)', example: 'Aarav Sharma', notes: 'Required field. Candidate legal name.' },
      { column: 'Phone', required: 'YES', format: '10-digit Indian Mobile', example: '9876543210', notes: 'Must start with 6, 7, 8, or 9. Formatted as Text.' },
      { column: 'Email', required: 'Optional', format: 'Valid Email address', example: 'aarav@example.com', notes: 'Lowercased automatically. Deduplicated if present.' },
      { column: 'Father Name', required: 'Optional', format: 'Text', example: 'Rajesh Sharma', notes: 'Father or Guardian name.' },
      { column: 'Date of Birth (YYYY-MM-DD)', required: 'Optional', format: 'ISO YYYY-MM-DD', example: '1996-05-15', notes: 'Must be a past date. Age must be at least 18.' },
      { column: 'Gender (Male/Female/Other)', required: 'Optional', format: 'Male, Female, or Other', example: 'Male', notes: 'Select from dropdown in Column F.' },
      { column: 'Current Location', required: 'Optional', format: 'City, State', example: 'Bengaluru, Karnataka', notes: 'Current residential location.' },
      { column: 'Preferred Location', required: 'Optional', format: 'City or Region', example: 'Hyderabad, Bengaluru', notes: 'Preferred work city.' },
      { column: 'Total Experience (Years)', required: 'Optional', format: 'Decimal number (e.g. 4.5)', example: '4.5', notes: 'Total professional experience in years.' },
      { column: 'Relevant Experience (Years)', required: 'Optional', format: 'Decimal number (e.g. 3.0)', example: '3.0', notes: 'Cannot exceed Total Experience.' },
      { column: 'Highest Qualification', required: 'Optional', format: 'Degree / Diploma', example: 'B.Tech in Computer Science', notes: 'Highest completed degree.' },
      { column: 'Education', required: 'Optional', format: 'Level (B.Tech, MBA, etc.)', example: 'B.Tech', notes: 'Educational level.' },
      { column: 'Current Company', required: 'Optional', format: 'Company Name', example: 'Infosys Ltd', notes: 'Present employer.' },
      { column: 'Current Designation', required: 'Optional', format: 'Job Title', example: 'Senior Software Engineer', notes: 'Present designation.' },
      { column: 'Previous Company', required: 'Optional', format: 'Company Name', example: 'TCS', notes: 'Prior employer.' },
      { column: 'Notice Period', required: 'Optional', format: 'Text (e.g. 30 Days)', example: '30 Days', notes: 'Notice period description.' },
      { column: 'Notice Period Days', required: 'Optional', format: 'Integer (0 to 180)', example: '30', notes: 'Days between 0 and 180.' },
      { column: 'Current Monthly Salary', required: 'Optional', format: 'INR Monthly', example: '65000', notes: 'Monthly in-hand salary.' },
      { column: 'Expected Monthly Salary', required: 'Optional', format: 'INR Monthly', example: '85000', notes: 'Expected monthly compensation.' },
      { column: 'Current CTC', required: 'Optional', format: 'INR Annual', example: '780000', notes: 'Annual cost to company.' },
      { column: 'Expected CTC', required: 'Optional', format: 'INR Annual', example: '1020000', notes: 'Expected annual CTC.' },
      { column: 'Skills (comma-separated)', required: 'Optional', format: 'Comma-separated skills', example: 'React, TypeScript, Node.js', notes: 'Cleaned and deduplicated.' },
      { column: 'Languages (comma-separated)', required: 'Optional', format: 'Comma-separated languages', example: 'English, Hindi', notes: 'Languages spoken.' },
      { column: 'Resume URL', required: 'Optional', format: 'Valid URL (http/https)', example: 'https://example.com/cv.pdf', notes: 'Direct link to resume document.' },
      { column: 'Source', required: 'Optional', format: 'Sourcing Channel', example: 'Bulk Import', notes: 'Defaults to Bulk Import.' },
      { column: 'Tags (comma-separated)', required: 'Optional', format: 'Comma-separated tags', example: 'Frontend, Verified', notes: 'Categorization tags.' },
      { column: 'Notes', required: 'Optional', format: 'Free text notes', example: 'Candidate ready for immediate onboarding.', notes: 'Screening or interview notes.' },
    ];

    instructionsData.forEach(row => instructionsSheet.addRow(row));

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Orrica_Edge_Candidate_Import_Template.xlsx"');
    res.setHeader('Content-Length', buffer.byteLength.toString());
    res.end(buffer);
  } catch (err) {
    next(err);
  }
};

/**
 * Bulk Candidate Import from Excel/CSV
 * POST /api/v1/candidates/bulk-import
 * POST /api/v1/candidates/bulk-import-validate
 */
export const bulkImportCandidates = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      sendError(res, 'Spreadsheet file is required. Upload a valid .xlsx, .xls, or .csv file.', 400);
      return;
    }

    // 5MB file size limit enforcement
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      sendError(res, 'File size exceeds the 5MB limit. Please upload a smaller file.', 400);
      return;
    }

    const isDryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.query?.dryRun === 'true';
    const defaultSource = sanitizeCellValue(req.body?.source || 'Bulk Import');
    const userRole = (req.user as any)?.role;
    const isRecruiter = userRole === 'RECRUITER' || userRole === 'FREELANCE_RECRUITER';
    const currentUserId = (req.user as any)?.userId || (req.user as any)?.id || null;

    // Recruiter role ownership backend enforcement:
    // If recruiter imports, every candidate is strictly owned by the logged-in recruiter
    let targetRecruiterId: string | null = null;
    if (isRecruiter) {
      targetRecruiterId = currentUserId;
    } else if (req.body?.assignedRecruiterId) {
      targetRecruiterId = String(req.body.assignedRecruiterId).trim() || null;
    }

    // Verify foreign keys against database to prevent Postgres constraint violations
    let validOwnerRecruiterId: string | null = null;
    if (targetRecruiterId) {
      const rec = await prisma.user.findFirst({
        where: {
          OR: [
            { id: targetRecruiterId },
            { recruiterId: targetRecruiterId },
          ],
        },
        select: { id: true },
      });
      validOwnerRecruiterId = rec?.id || null;
    }

    let validCreatedById: string | null = null;
    if (currentUserId) {
      const usr = await prisma.user.findUnique({
        where: { id: currentUserId },
        select: { id: true },
      });
      validCreatedById = usr?.id || null;
    }

    // 1. Parse spreadsheet safely (disable formula execution)
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, {
        type: 'buffer',
        cellFormula: false,
        cellHTML: false,
        cellText: true,
      });
    } catch (parseErr: any) {
      sendError(res, `Failed to parse spreadsheet: ${parseErr?.message || 'Invalid or corrupted file.'}`, 400);
      return;
    }

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      sendError(res, 'Uploaded spreadsheet contains no worksheets.', 400);
      return;
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      raw: false,
    });

    if (!rawRows || rawRows.length === 0) {
      sendError(res, 'Uploaded spreadsheet contains no data rows.', 400);
      return;
    }

    // Maximum 2,000 rows limit enforcement
    const MAX_ROW_LIMIT = 2000;
    if (rawRows.length > MAX_ROW_LIMIT) {
      sendError(res, `Spreadsheet exceeds maximum allowed limit of ${MAX_ROW_LIMIT} rows per import batch.`, 400);
      return;
    }

    // 2. Validate sheet headers against canonical format
    const firstRowKeys = Object.keys(rawRows[0] || {});
    const normalizedSheetHeaders = firstRowKeys.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const hasFullName = normalizedSheetHeaders.some(h => ['fullname', 'name', 'candidatename'].includes(h));
    const hasPhone = normalizedSheetHeaders.some(h => ['phone', 'mobile', 'phonenumber', 'contact', 'mobilenumber', 'contactnumber'].includes(h));

    if (!hasFullName || !hasPhone) {
      sendError(
        res,
        "Spreadsheet headers do not match template: Required columns 'Full Name' and 'Phone' were not found. Please use the standard template.",
        400
      );
      return;
    }

    // Normalization map for headers
    const normalizeKey = (key: string): string => {
      const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['fullname', 'name', 'candidatename'].includes(lower)) return 'fullName';
      if (['phone', 'mobile', 'phonenumber', 'contact', 'mobilenumber', 'contactnumber'].includes(lower)) return 'phone';
      if (['email', 'emailaddress', 'emailid'].includes(lower)) return 'email';
      if (['fathername', 'fathersname'].includes(lower)) return 'fatherName';
      if (['dateofbirth', 'dob', 'birthdate'].includes(lower)) return 'dateOfBirth';
      if (['gender', 'sex'].includes(lower)) return 'gender';
      if (['currentlocation', 'location', 'city', 'address', 'fulladdress'].includes(lower)) return 'location';
      if (['preferredlocation', 'preferredcity'].includes(lower)) return 'preferredLocation';
      if (['totalexperience', 'experience', 'exp', 'totalexp', 'experienceyears'].includes(lower)) return 'totalExperience';
      if (['relevantexperience', 'relexp'].includes(lower)) return 'relevantExperience';
      if (['highestqualification', 'qualification', 'degree', 'highestdegree'].includes(lower)) return 'highestQualification';
      if (['education', 'academics'].includes(lower)) return 'education';
      if (['currentcompany', 'company', 'employer'].includes(lower)) return 'currentCompany';
      if (['currentdesignation', 'designation', 'role', 'jobtitle', 'currentrole'].includes(lower)) return 'currentDesignation';
      if (['previouscompany', 'pastcompany'].includes(lower)) return 'previousCompany';
      if (['noticeperiod', 'notice'].includes(lower)) return 'noticePeriod';
      if (['noticeperioddays', 'noticedays'].includes(lower)) return 'noticePeriodDays';
      if (['currentsalary', 'currentmonthlysalary', 'salary'].includes(lower)) return 'currentSalary';
      if (['expectedsalary', 'expectedmonthlysalary'].includes(lower)) return 'expectedSalary';
      if (['currentctc'].includes(lower)) return 'currentCtc';
      if (['expectedctc'].includes(lower)) return 'expectedCtc';
      if (['skills', 'skillset', 'keyskills'].includes(lower)) return 'skills';
      if (['languages', 'languagesknown'].includes(lower)) return 'languages';
      if (['resumeurl', 'resumelink', 'cvlink'].includes(lower)) return 'resumeUrl';
      if (['source', 'sourcingchannel'].includes(lower)) return 'source';
      if (['tags', 'tag'].includes(lower)) return 'tags';
      if (['notes', 'remarks', 'feedback', 'comments'].includes(lower)) return 'notes';
      return lower;
    };

    type ProcessedRow = {
      rowNumber: number;
      data: any;
      isValid: boolean;
      isDuplicateInSheet: boolean;
      errors: string[];
    };

    const processedRows: ProcessedRow[] = [];
    const seenPhonesInSheet = new Map<string, number>();
    const seenEmailsInSheet = new Map<string, number>();

    const candidatePhonesForDbCheck = new Set<string>();
    const candidateEmailsForDbCheck = new Set<string>();

    for (let index = 0; index < rawRows.length; index++) {
      const raw = rawRows[index];
      const rowNumber = index + 2; // +1 for 0-index, +1 for header row
      const errors: string[] = [];

      // Extract normalized fields
      const rowNormalized: Record<string, any> = {};
      for (const [key, val] of Object.entries(raw)) {
        const canonicalKey = normalizeKey(key);
        rowNormalized[canonicalKey] = sanitizeCellValue(val);
      }

      const fullName = (rowNormalized.fullName || '').trim();
      const rawPhone = rowNormalized.phone || '';
      const rawEmail = (rowNormalized.email || '').toLowerCase().trim();

      // Skip template example row if user uploaded template without removing row 2
      if (fullName.includes('(Example Row') || fullName.includes('(EXAMPLE')) {
        continue;
      }

      // Required: Full Name
      if (!fullName) {
        errors.push('Full Name is required.');
      }

      // Required: Phone (normalized 10-digit Indian mobile, scientific notation protected)
      const { phone: normalizedPhone, isValid: isPhoneValid, error: phoneError } = normalizePhoneNumber(rawPhone);
      if (!isPhoneValid) {
        errors.push(phoneError || `Invalid phone number '${rawPhone}'. Must be a valid 10-digit Indian mobile number.`);
      }

      // Email validation (optional; if present, validate format)
      const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
      let finalEmail: string | null = null;
      if (rawEmail) {
        if (emailRegex.test(rawEmail)) {
          finalEmail = rawEmail.toLowerCase().trim();
        } else {
          errors.push(`Invalid email address '${rawEmail}'.`);
        }
      } else if (isPhoneValid) {
        // Fallback unique email for candidates imported without email
        finalEmail = `bulk.${normalizedPhone}@orricaedge.internal`;
      }

      // Check within-sheet duplicates
      let isDuplicateInSheet = false;
      if (isPhoneValid) {
        if (seenPhonesInSheet.has(normalizedPhone)) {
          isDuplicateInSheet = true;
          errors.push(`Duplicate phone number in spreadsheet. Already appeared in Row ${seenPhonesInSheet.get(normalizedPhone)}.`);
        } else {
          seenPhonesInSheet.set(normalizedPhone, rowNumber);
          candidatePhonesForDbCheck.add(normalizedPhone);
        }
      }

      if (finalEmail) {
        if (seenEmailsInSheet.has(finalEmail)) {
          isDuplicateInSheet = true;
          errors.push(`Duplicate email address in spreadsheet. Already appeared in Row ${seenEmailsInSheet.get(finalEmail)}.`);
        } else {
          seenEmailsInSheet.set(finalEmail, rowNumber);
          candidateEmailsForDbCheck.add(finalEmail);
        }
      }

      // Gender validation (case-insensitive Male/Female/Other)
      const { gender: parsedGender, error: genderError } = parseGender(rowNormalized.gender);
      if (genderError) {
        errors.push(genderError);
      }

      // Date of Birth validation (ISO, past date, age 18+)
      const { date: dobDate, error: dobError } = parseDateOfBirth(rowNormalized.dateOfBirth);
      if (dobError) {
        errors.push(dobError);
      }

      // Parse experience and numbers safely
      const parseDecimal = (val: any): number | null => {
        if (val === undefined || val === null || val === '') return null;
        const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
        return isNaN(num) ? null : Math.max(0, num);
      };

      const totalExp = parseDecimal(rowNormalized.totalExperience) ?? 0;
      const relExp = parseDecimal(rowNormalized.relevantExperience) ?? 0;

      if (relExp > totalExp) {
        errors.push(`Relevant Experience (${relExp} yrs) cannot exceed Total Experience (${totalExp} yrs).`);
      }

      // Notice period days (integer 0 to 180)
      let parsedNoticeDays: number | null = null;
      if (rowNormalized.noticePeriodDays !== undefined && rowNormalized.noticePeriodDays !== '') {
        const nd = parseInt(String(rowNormalized.noticePeriodDays).trim(), 10);
        if (isNaN(nd) || nd < 0 || nd > 180) {
          errors.push(`Notice Period Days must be an integer between 0 and 180.`);
        } else {
          parsedNoticeDays = nd;
        }
      }

      const currSal = parseDecimal(rowNormalized.currentSalary);
      const expSal = parseDecimal(rowNormalized.expectedSalary);
      const currCtc = parseDecimal(rowNormalized.currentCtc) ?? (currSal ? currSal * 12 : null);
      const expCtc = parseDecimal(rowNormalized.expectedCtc) ?? (expSal ? expSal * 12 : null);

      // Parse arrays (comma-separated, trimmed, deduplicated)
      const parseArray = (str: string): string[] => {
        if (!str) return [];
        const items = str.split(',').map(s => s.trim()).filter(Boolean);
        return Array.from(new Set(items));
      };

      const skillsArr = parseArray(rowNormalized.skills);
      const languagesArr = parseArray(rowNormalized.languages);
      const tagsArr = parseArray(rowNormalized.tags);

      // Validate Resume URL
      let validResumeUrl = '';
      if (rowNormalized.resumeUrl) {
        const urlStr = String(rowNormalized.resumeUrl).trim();
        if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(urlStr)) {
          validResumeUrl = urlStr;
        } else {
          errors.push(`Invalid Resume URL '${urlStr}'. Must start with http:// or https://.`);
        }
      }

      const candidateData = {
        fullName,
        name: fullName,
        phone: normalizedPhone,
        email: finalEmail,
        fatherName: rowNormalized.fatherName ? String(rowNormalized.fatherName).trim() : null,
        dateOfBirth: dobDate,
        gender: parsedGender,
        currentLocation: rowNormalized.location ? String(rowNormalized.location).trim() : '',
        location: rowNormalized.location ? String(rowNormalized.location).trim() : '',
        preferredLocation: rowNormalized.preferredLocation ? String(rowNormalized.preferredLocation).trim() : null,
        totalExperience: totalExp,
        relevantExperience: relExp,
        experienceYears: totalExp,
        highestQualification: rowNormalized.highestQualification || rowNormalized.education || null,
        education: rowNormalized.education || rowNormalized.highestQualification || null,
        currentCompany: rowNormalized.currentCompany ? String(rowNormalized.currentCompany).trim() : null,
        currentDesignation: rowNormalized.currentDesignation ? String(rowNormalized.currentDesignation).trim() : null,
        previousCompany: rowNormalized.previousCompany ? String(rowNormalized.previousCompany).trim() : null,
        noticePeriod: rowNormalized.noticePeriod || (parsedNoticeDays !== null ? `${parsedNoticeDays} Days` : null),
        noticePeriodDays: parsedNoticeDays,
        currentSalary: currSal,
        expectedSalary: expSal,
        currentCtc: currCtc,
        expectedCtc: expCtc,
        skills: skillsArr,
        languages: languagesArr.length > 0 ? languagesArr : ['English', 'Hindi'],
        resumeUrl: validResumeUrl,
        source: rowNormalized.source || defaultSource,
        tags: tagsArr,
        notes: rowNormalized.notes ? String(rowNormalized.notes).trim() : null,
        status: 'New',
        ownerRecruiterId: validOwnerRecruiterId || undefined,
        assignedRecruiterIds: validOwnerRecruiterId ? [validOwnerRecruiterId] : [],
        createdById: validCreatedById || undefined,
      };

      processedRows.push({
        rowNumber,
        data: candidateData,
        isValid: errors.length === 0,
        isDuplicateInSheet,
        errors,
      });
    }

    // 4. Second pass: Query existing candidates to detect duplicates in DB
    const existingDbCandidates = await prisma.candidate.findMany({
      where: {
        OR: [
          { phone: { in: Array.from(candidatePhonesForDbCheck) } },
          ...(candidateEmailsForDbCheck.size > 0
            ? [{ email: { in: Array.from(candidateEmailsForDbCheck) } }]
            : []),
        ],
      },
      select: {
        id: true,
        candidateCode: true,
        phone: true,
        email: true,
        fullName: true,
        name: true,
        isArchived: true,
      },
    });

    const phoneToCandidateMap = new Map<string, any>();
    const emailToCandidateMap = new Map<string, any>();

    for (const ec of existingDbCandidates) {
      if (ec.phone) phoneToCandidateMap.set(ec.phone, ec);
      if (ec.email) emailToCandidateMap.set(ec.email.toLowerCase(), ec);
    }

    const errorReport: { row: number; candidateName: string; phone: string; email: string; reason: string }[] = [];
    const validRowsToInsert: ProcessedRow[] = [];
    let duplicateSheetCount = 0;
    let duplicateDbCount = 0;
    let invalidFieldCount = 0;

    for (const row of processedRows) {
      if (!row.isValid) {
        if (row.isDuplicateInSheet) {
          duplicateSheetCount++;
        } else {
          invalidFieldCount++;
        }
        errorReport.push({
          row: row.rowNumber,
          candidateName: row.data.fullName || 'Unknown',
          phone: row.data.phone || '',
          email: row.data.email || '',
          reason: row.errors.join('; '),
        });
        continue;
      }

      // Check DB duplicates by phone or email:
      // STRICT POLICY: SKIP and REPORT; NEVER OVERWRITE existing records
      const matchedByPhone = phoneToCandidateMap.get(row.data.phone);
      const matchedByEmail = row.data.email ? emailToCandidateMap.get(row.data.email.toLowerCase()) : null;
      const matchedExisting = matchedByPhone || matchedByEmail;

      if (matchedExisting) {
        duplicateDbCount++;
        errorReport.push({
          row: row.rowNumber,
          candidateName: row.data.fullName,
          phone: row.data.phone,
          email: row.data.email,
          reason: `Duplicate candidate skipped: ${matchedByPhone ? 'Phone' : 'Email'} already exists in database (matched Candidate: ${matchedExisting.candidateCode} - ${matchedExisting.fullName || matchedExisting.name}).`,
        });
        continue;
      }

      // Row is completely valid and not duplicate: ready for atomic insert
      validRowsToInsert.push(row);
    }

    const totalDuplicates = duplicateSheetCount + duplicateDbCount;

    // 5. If dryRun is requested (or /bulk-import-validate), return preview analysis without writing to DB
    if (isDryRun) {
      sendSuccess(
        res,
        {
          isDryRun: true,
          totalRows: processedRows.length,
          validCount: validRowsToInsert.length,
          createdCount: validRowsToInsert.length,
          importedCount: validRowsToInsert.length,
          updatedCount: 0,
          matchedCount: 0,
          duplicateCount: totalDuplicates,
          duplicateSheetCount,
          duplicateDbCount,
          skippedCount: totalDuplicates,
          conflictCount: 0,
          invalidCount: invalidFieldCount,
          failedCount: errorReport.length,
          previewRows: validRowsToInsert.slice(0, 10).map((r) => ({
            row: r.rowNumber,
            name: r.data.fullName,
            phone: r.data.phone,
            email: r.data.email,
            location: r.data.location,
            totalExperience: r.data.totalExperience,
            currentCompany: r.data.currentCompany,
            status: 'Valid',
          })),
          errors: errorReport.slice(0, 200),
        },
        'Spreadsheet validation completed successfully.'
      );
      return;
    }

    // 6. Execute atomic batch operations in transactions (batches of 20 with explicit 60s timeout)
    const insertedCodes: string[] = [];
    const insertedItems: { id: string; candidateCode: string }[] = [];
    const CHUNK_SIZE = 20;

    if (validRowsToInsert.length > 0) {
      const candidateCodes = await generateCandidateCodesBatch(validRowsToInsert.length);

      for (let i = 0; i < validRowsToInsert.length; i += CHUNK_SIZE) {
        const chunk = validRowsToInsert.slice(i, i + CHUNK_SIZE);
        const codesChunk = candidateCodes.slice(i, i + CHUNK_SIZE);

        const chunkResult = await prisma.$transaction(
          async (tx) => {
            const batchInserted: { id: string; candidateCode: string }[] = [];
            for (let j = 0; j < chunk.length; j++) {
              const rowItem = chunk[j];
              const code = codesChunk[j];
              const dataToInsert = rowItem.data;

              const tagsWithRecruiter = validOwnerRecruiterId
                ? Array.from(new Set([...dataToInsert.tags, `assignedRecruiter:${validOwnerRecruiterId}`]))
                : dataToInsert.tags;

              const created = await tx.candidate.create({
                data: {
                  ...dataToInsert,
                  candidateCode: code,
                  tags: tagsWithRecruiter,
                  source: dataToInsert.source || 'Bulk Import',
                },
                select: { id: true, candidateCode: true },
              });

              batchInserted.push({ id: created.id, candidateCode: created.candidateCode });
            }
            return batchInserted;
          },
          {
            maxWait: 15000,
            timeout: 60000,
          }
        );

        for (const item of chunkResult) {
          insertedCodes.push(item.candidateCode);
          insertedItems.push(item);
        }
      }

      // 7. Resilient asynchronous timeline logging outside the critical transaction
      if (validCreatedById && insertedItems.length > 0) {
        Promise.allSettled(
          insertedItems.map((item) =>
            logCandidateTimeline({
              candidateId: item.id,
              userId: validCreatedById!,
              userName: (req.user as any)?.email,
              userRole: (req.user as any)?.role,
              action: 'Candidate Imported',
              newStatus: 'New',
              remarks: `Candidate profile created (${item.candidateCode}) via Bulk Import by ${(req.user as any)?.email || 'User'}`,
            })
          )
        ).catch((tlErr) => {
          console.warn('[BULK_IMPORT] Non-fatal timeline log error:', tlErr);
        });
      }
    }

    // Audit log for the import batch
    try {
      await logAudit({
        userId: validCreatedById || undefined,
        action: 'BULK_CANDIDATE_IMPORT',
        module: 'CANDIDATES',
        entity: 'Candidate',
        entityId: `batch-${Date.now()}`,
        newValue: {
          importedCount: insertedCodes.length,
          skippedDuplicates: totalDuplicates,
          invalidRows: invalidFieldCount,
          fileName: file.originalname,
          role: userRole,
          ownerRecruiterId: validOwnerRecruiterId,
        },
      });
    } catch {}

    sendSuccess(
      res,
      {
        totalProcessed: processedRows.length,
        totalRows: processedRows.length,
        createdCount: insertedCodes.length,
        importedCount: insertedCodes.length,
        updatedCount: 0,
        skippedCount: totalDuplicates,
        duplicateCount: totalDuplicates,
        failedCount: invalidFieldCount,
        generatedCodes: insertedCodes,
        errors: errorReport,
        message: `Bulk candidate import completed: ${insertedCodes.length} imported, ${totalDuplicates} duplicates skipped, ${invalidFieldCount} invalid rows failed.`,
      },
      'Bulk candidate import processed successfully.'
    );
  } catch (err: any) {
    console.error('[BULK_IMPORT] Error during bulk candidate import:', err);
    next(err);
  }
};
