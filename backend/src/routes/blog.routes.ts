import { Router } from 'express';
import {
  getBlogPosts,
  getBlogPostBySlug,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from '../controllers/blog.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public Career Resources routes
router.get('/', getBlogPosts);
router.get('/:slug', getBlogPostBySlug);

// Admin-only management
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), createBlogPost);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), updateBlogPost);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteBlogPost);

export default router;
