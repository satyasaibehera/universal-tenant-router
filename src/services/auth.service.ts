import { randomInt } from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import { pool } from '../db/pool';

const BCRYPT_ROUNDS = 10;
const OTP_TTL_MINUTES = 10;

export type TenantMembership = {
  tenant_id: string;
  role: 'owner' | 'admin' | 'member';
};

export type AuthTokenPayload = {
  user_id: string;
  email: string;
  tenants: TenantMembership[];
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  private resend: Resend | null = null;

  private getResend(): Resend {
    if (!this.resend) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        throw new AuthError('RESEND_API_KEY is not configured', 500);
      }
      this.resend = new Resend(apiKey);
    }
    return this.resend;
  }

  /** Secure 6-digit numeric OTP (000000–999999). */
  generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async register(
    email: string,
    password?: string,
  ): Promise<{ id: string; email: string; created_at: Date }> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new AuthError('A valid email is required', 400);
    }

    const passwordHash = password
      ? await this.hashPassword(password)
      : null;

    try {
      const result = await pool.query<{
        id: string;
        email: string;
        created_at: Date;
      }>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at`,
        [normalizedEmail, passwordHash],
      );

      return result.rows[0];
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new AuthError('A user with this email already exists', 409);
      }
      throw err;
    }
  }

  /**
   * Passwordless login: generate OTP, persist bcrypt hash, email plaintext code.
   */
  async login(email: string): Promise<{ message: string }> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new AuthError('A valid email is required', 400);
    }

    const userResult = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = userResult.rows[0];

    // Avoid account enumeration: same response whether or not the user exists.
    if (!user) {
      return { message: 'If an account exists, a login code has been sent' };
    }

    const otp = this.generateOtp();
    const otpCodeHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await pool.query(
      `INSERT INTO auth_otps (user_id, otp_code_hash, expires_at, used_at)
       VALUES ($1, $2, $3, FALSE)`,
      [user.id, otpCodeHash, expiresAt],
    );

    await this.sendOtpEmail(user.email, otp);

    return { message: 'If an account exists, a login code has been sent' };
  }

  /**
   * Verify OTP: user exists → hash match → not expired → mark used → issue JWT.
   */
  async verify(
    email: string,
    otp: string,
  ): Promise<{ token: string; expires_in: string }> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !otp) {
      throw new AuthError('Email and OTP are required', 400);
    }

    const userResult = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = $1`,
      [normalizedEmail],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new AuthError('Invalid or expired OTP', 401);
    }

    const otpResult = await pool.query<{
      id: string;
      otp_code_hash: string;
      expires_at: Date;
      used_at: boolean;
    }>(
      `SELECT id, otp_code_hash, expires_at, used_at
       FROM auth_otps
       WHERE user_id = $1
         AND used_at = FALSE
         AND expires_at > NOW()
       ORDER BY expires_at DESC
       LIMIT 5`,
      [user.id],
    );

    let matchedOtpId: string | null = null;
    for (const row of otpResult.rows) {
      const matches = await bcrypt.compare(otp, row.otp_code_hash);
      if (matches) {
        matchedOtpId = row.id;
        break;
      }
    }

    if (!matchedOtpId) {
      throw new AuthError('Invalid or expired OTP', 401);
    }

    const markResult = await pool.query(
      `UPDATE auth_otps
       SET used_at = TRUE
       WHERE id = $1 AND used_at = FALSE
       RETURNING id`,
      [matchedOtpId],
    );
    if (markResult.rowCount === 0) {
      throw new AuthError('Invalid or expired OTP', 401);
    }

    const tenants = await this.getTenantMemberships(user.id);
    const token = this.issueJwt({
      user_id: user.id,
      email: user.email,
      tenants,
    });

    const expiresIn = process.env.JWT_EXPIRES_IN ?? '7d';
    return { token, expires_in: expiresIn };
  }

  private async getTenantMemberships(
    userId: string,
  ): Promise<TenantMembership[]> {
    const result = await pool.query<TenantMembership>(
      `SELECT tenant_id, role
       FROM tenant_users
       WHERE user_id = $1`,
      [userId],
    );
    return result.rows;
  }

  private issueJwt(payload: AuthTokenPayload): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const expiresIn = process.env.JWT_EXPIRES_IN ?? '7d';
    return jwt.sign(payload, secret, {
      expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    });
  }

  private async sendOtpEmail(to: string, otp: string): Promise<void> {
    const from =
      process.env.RESEND_FROM_EMAIL ?? 'Auth <onboarding@resend.dev>';

    const { error } = await this.getResend().emails.send({
      from,
      to,
      subject: 'Your login code',
      html: `
        <p>Your one-time login code is:</p>
        <p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${otp}</p>
        <p>This code expires in ${OTP_TTL_MINUTES} minutes.</p>
      `,
      text: `Your one-time login code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
    });

    if (error) {
      throw new AuthError('Failed to send login code', 502);
    }
  }

  private normalizeEmail(email: string): string {
    return (email ?? '').trim().toLowerCase();
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    );
  }
}
