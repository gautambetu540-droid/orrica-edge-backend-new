import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

// Ensure upload directory exists
if (!fs.existsSync(config.upload.dir)) {
  fs.mkdirSync(config.upload.dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.upload.dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `resume-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (
  req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedExtensions = ['.pdf', '.doc', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF and DOC/DOCX files are permitted for resumes.'));
  }
};

export const uploadResume = multer({
  storage,
  limits: {
    fileSize: config.upload.maxFileSizeMb * 1024 * 1024,
  },
  fileFilter,
});

/**
 * Memory storage for Excel and CSV bulk uploads.
 * Keeps file buffer in memory for safe parsing and avoids temporary disk artifacts.
 */
const spreadsheetFilter = (
  req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedExtensions = ['.xlsx', '.xls', '.csv'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file format. Only Excel (.xlsx, .xls) and CSV (.csv) files are supported for bulk candidate import.'));
  }
};

export const uploadSpreadsheet = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB maximum file size
  },
  fileFilter: spreadsheetFilter,
});
