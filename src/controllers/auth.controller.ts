import { Router, Request, Response, NextFunction } from 'express';
import { AuthError, AuthService } from '../services/auth.service';

export class AuthController {
  readonly router: Router;
  private readonly authService: AuthService;

  constructor(authService: AuthService = new AuthService()) {
    this.authService = authService;
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.router.post('/register', this.register);
    this.router.post('/login', this.login);
    this.router.post('/verify', this.verify);
  }

  register = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { email, password } = req.body as {
        email?: string;
        password?: string;
      };

      if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
      }

      const user = await this.authService.register(email, password);
      res.status(201).json({
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      });
    } catch (err) {
      this.handleError(err, res, next);
    }
  };

  login = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { email } = req.body as { email?: string };

      if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
      }

      const result = await this.authService.login(email);
      res.status(200).json(result);
    } catch (err) {
      this.handleError(err, res, next);
    }
  };

  verify = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { email, otp } = req.body as { email?: string; otp?: string };

      if (!email || !otp) {
        res.status(400).json({ error: 'Email and OTP are required' });
        return;
      }

      const result = await this.authService.verify(email, otp);
      res.status(200).json(result);
    } catch (err) {
      this.handleError(err, res, next);
    }
  };

  private handleError(
    err: unknown,
    res: Response,
    next: NextFunction,
  ): void {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

export const authController = new AuthController();
export const authRouter = authController.router;
