import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative to `text`. */
  html?: string;
}

export interface Mailer {
  /** False when no SMTP server is configured; messages are logged instead. */
  configured: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Fail fast instead of hanging a request on an unreachable or stalled SMTP server. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
};

export const DEFAULT_MAIL_FROM = "Knotworking <no-reply@localhost>";

/** `MAIL_FROM`, or the default when it is unset *or empty* (compose passes an empty string). */
export const mailFrom = (env: Record<string, string | undefined>) => env.MAIL_FROM || DEFAULT_MAIL_FROM;

/**
 * Email is optional. Set SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465)
 * to send invites and password resets; otherwise they're printed to the server
 * log and admins copy links from the Members page instead.
 */
export function createMailer(env: Record<string, string | undefined> = process.env): Mailer {
  if (!env.SMTP_URL) {
    return {
      configured: false,
      async send(message) {
        console.info(
          `[mail] SMTP not configured — would send to ${message.to}: ${message.subject}\n${message.text}`,
        );
      },
    };
  }
  const transport = nodemailer.createTransport({ url: env.SMTP_URL, ...SMTP_TIMEOUTS });
  const from = mailFrom(env);
  return {
    configured: true,
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}

/** Collects messages in memory (tests). */
export function createMemoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    configured: true,
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}
