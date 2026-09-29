import { Router } from 'express';
import {
  getBlogPosts,
  getAdminBlogPosts,
  getBlogPostBySlug,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} from '../controllers/blog.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();

// Public Career Resources routes
router.get('/', getBlogPosts);

// Admin Career Resources — returns both DRAFT and PUBLISHED posts.
router.get('/admin', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), getAdminBlogPosts);

router.get('/:slug', getBlogPostBySlug);

// Admin-only management
router.post('/', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), createBlogPost);
router.put('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), updateBlogPost);
router.delete('/:id', authenticateJwt, requireRoles('SUPER_ADMIN', 'ADMIN'), deleteBlogPost);

export default router;
