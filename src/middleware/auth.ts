import { Request, Response, NextFunction } from 'express';
import type { UserSession } from '../types';

// Extend Express Request to include passport user type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatar: string | null;
      googleId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  }
}

export interface AuthRequest extends Request {
  userSession?: UserSession;
}

export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.substring(7).trim();

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
    return;
  }

  // Treat the bearer token as the authenticated user ID session
  req.userSession = { userId: token };
  next();
}
