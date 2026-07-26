import { Router, Request, Response } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { users } from '../database/schema';
import { env } from '../config/env';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// ─── Configure Google OAuth Strategy ──────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('No email in Google profile'));
        }

        const name = profile.displayName || email;
        const avatar = profile.photos?.[0]?.value || null;

        // Upsert user
        const existingUsers = await db
          .select()
          .from(users)
          .where(eq(users.googleId, profile.id))
          .limit(1);

        let user = existingUsers[0];

        if (!user) {
          // Check if email exists (different login method)
          const byEmail = await db
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          if (byEmail[0]) {
            // Link Google ID to existing email account
            const [updated] = await db
              .update(users)
              .set({ googleId: profile.id, avatar, updatedAt: new Date() })
              .where(eq(users.email, email))
              .returning();
            user = updated;
          } else {
            // Create new user
            const [created] = await db
              .insert(users)
              .values({ googleId: profile.id, email, name, avatar })
              .returning();
            user = created;
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err as Error);
      }
    },
  ),
);

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Initiate Google OAuth flow */
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  }),
);

/** Google OAuth callback */
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${env.FRONTEND_URL}/login?error=oauth_failed`,
  }),
  (req: Request, res: Response) => {
    const user = req.user as typeof users.$inferSelect;
    const token = user.id; // Use user ID directly as session token

    // Redirect to frontend with token
    res.redirect(`${env.FRONTEND_URL}/auth/callback?token=${token}`);
  },
);

/** Get current user info */
router.get('/me', authMiddleware as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userSession!.userId;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
    });
  } catch (err) {
    console.error('GET /auth/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
