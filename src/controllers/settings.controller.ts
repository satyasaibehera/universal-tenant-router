import { Router, Request, Response, NextFunction } from 'express';
import {
  SettingsError,
  settingsService,
} from '../services/settings.service';

export class SettingsController {
  readonly router: Router;

  constructor() {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Public feature-flag readout
    this.router.get('/config/auth', this.getAuthConfig);

    // Admin upsert for auth provider
    this.router.put('/admin/settings/auth', this.putAuthProvider);
  }

  getAuthConfig = async (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const provider = await settingsService.getAuthProvider();
      res.status(200).json({ provider });
    } catch (err) {
      this.handleError(err, res, next);
    }
  };

  putAuthProvider = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { provider } = req.body as { provider?: string };

      if (!provider) {
        res.status(400).json({ error: 'provider is required' });
        return;
      }

      const saved = await settingsService.setAuthProvider(provider);
      res.status(200).json({ provider: saved });
    } catch (err) {
      this.handleError(err, res, next);
    }
  };

  private handleError(
    err: unknown,
    res: Response,
    next: NextFunction,
  ): void {
    if (err instanceof SettingsError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

export const settingsController = new SettingsController();
export const settingsRouter = settingsController.router;
