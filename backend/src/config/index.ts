import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'orrica_edge_access_default_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'orrica_edge_refresh_default_secret',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '1d',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'],
  upload: {
    dir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads'),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10),
  },
};
