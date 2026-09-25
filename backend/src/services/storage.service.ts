import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';

const s3Bucket = process.env.AWS_S3_BUCKET_NAME || '';
const s3Region = process.env.AWS_REGION || 'ap-south-1';
const hasS3Config = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && s3Bucket);

const s3Client = hasS3Config
  ? new S3Client({
      region: s3Region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

export interface UploadFileResult {
  fileUrl: string;
  key: string;
  storageType: 'S3' | 'LOCAL';
}

export const uploadResumeFile = async (
  file: Express.Multer.File,
  candidateName: string
): Promise<UploadFileResult> => {
  const sanitizedName = candidateName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const ext = path.extname(file.originalname).toLowerCase();
  const fileKey = `resumes/${sanitizedName}-${Date.now()}${ext}`;

  // If AWS S3 credentials are provided, upload to AWS S3 bucket
  if (s3Client && s3Bucket) {
    const fileBuffer = fs.readFileSync(file.path);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: file.mimetype,
      })
    );

    // Remove temp file from local disk after S3 upload
    try {
      fs.unlinkSync(file.path);
    } catch (e) {
      // ignore unlink error
    }

    const s3Url = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${fileKey}`;
    return {
      fileUrl: s3Url,
      key: fileKey,
      storageType: 'S3',
    };
  }

  // Fallback to local storage URL
  const localUrl = `/uploads/${file.filename}`;
  return {
    fileUrl: localUrl,
    key: file.filename,
    storageType: 'LOCAL',
  };
};

export const deleteResumeFile = async (fileKey: string): Promise<boolean> => {
  try {
    if (s3Client && s3Bucket && fileKey.startsWith('resumes/')) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: fileKey,
        })
      );
      return true;
    }

    const localPath = path.join(config.upload.dir, path.basename(fileKey));
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
    return true;
  } catch (err: any) {
    console.error('[STORAGE DELETE ERROR]:', err.message);
    return false;
  }
};
