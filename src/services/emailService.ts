import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { env } from '../config/env';

let transporter: nodemailer.Transporter | null = null;
let etherealAccount: { user: string; pass: string; previewBase: string } | null = null;
let resendClient: Resend | null = null;

/**
 * Initialize Email provider.
 * If RESEND_API_KEY is configured, initializes Resend HTTP client (ideal for cloud production).
 * Otherwise, falls back to Ethereal SMTP for local testing.
 */
export async function initEmailTransporter(): Promise<void> {
  if (env.RESEND_API_KEY) {
    resendClient = new Resend(env.RESEND_API_KEY);
    console.log('✅ Resend API client initialized (Production HTTP Mode - Port 443)');
    return;
  }

  if (env.ETHEREAL_USER && env.ETHEREAL_PASS) {
    etherealAccount = {
      user: env.ETHEREAL_USER,
      pass: env.ETHEREAL_PASS,
      previewBase: 'https://ethereal.email/message',
    };
  } else {
    const account = await nodemailer.createTestAccount();
    etherealAccount = {
      user: account.user,
      pass: account.pass,
      previewBase: 'https://ethereal.email/message',
    };
    console.log('📧 Ethereal Email account created:');
    console.log('   User:', account.user);
    console.log('   Pass:', account.pass);
    console.log('   Preview: https://ethereal.email/login');
    console.log('   (Add these to .env as ETHEREAL_USER/ETHEREAL_PASS to reuse)');
  }

  transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
      user: etherealAccount.user,
      pass: etherealAccount.pass,
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
  });

  // Verify connection non-fatally so cloud providers restricting outbound port 587 do not prevent server boot
  try {
    await transporter.verify();
    console.log('✅ Ethereal SMTP connected');
  } catch (err: any) {
    console.warn('⚠️  Ethereal SMTP verification timed out or failed (outbound port 587 may be blocked by cloud provider):', err.message || err);
    console.warn('   Server continuing to boot normally. Email jobs will attempt delivery when executed.');
  }
}

export interface SendEmailOptions {
  toEmail: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
}

export interface SendEmailResult {
  messageId: string;
  previewUrl: string;
}

/**
 * Send a single email via Resend API or Ethereal SMTP.
 * Returns the message ID and preview URL.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  if (resendClient) {
    // Resend requires sending from a verified domain or onboarding@resend.dev when on the free tier.
    // If RESEND_FROM_EMAIL is set in .env, use it. Otherwise default to onboarding@resend.dev.
    const fromAddress = env.RESEND_FROM_EMAIL
      ? `"${options.fromName}" <${env.RESEND_FROM_EMAIL}>`
      : `"${options.fromName}" <onboarding@resend.dev>`;

    const { data, error } = await resendClient.emails.send({
      from: fromAddress,
      to: options.toEmail,
      subject: options.subject,
      html: options.body,
      text: options.body.replace(/<[^>]*>/g, ''),
      replyTo: options.fromEmail, // Allows recipient replies to go directly to the original sender!
    });

    if (error || !data) {
      throw new Error(`Resend API error: ${error?.message || 'Unknown error'}`);
    }

    return {
      messageId: data.id,
      previewUrl: `https://resend.com/emails/${data.id}`,
    };
  }

  if (!transporter || !etherealAccount) {
    throw new Error('Email transporter not initialized. Call initEmailTransporter() first.');
  }

  const info = await transporter.sendMail({
    from: `"${options.fromName}" <${options.fromEmail}>`,
    to: options.toEmail,
    subject: options.subject,
    html: options.body,
    text: options.body.replace(/<[^>]*>/g, ''), // Strip HTML for text version
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || `${etherealAccount.previewBase}/${info.messageId}`;

  return {
    messageId: info.messageId,
    previewUrl: previewUrl as string,
  };
}
