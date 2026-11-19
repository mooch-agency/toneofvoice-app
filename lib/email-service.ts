import { Resend } from "resend"

let _resend: { key: string; client: Resend } | null = null
function getResend(key: string): Resend {
  if (_resend?.key !== key) _resend = { key, client: new Resend(key) }
  return _resend.client
}

export interface EmailData {
  to: string
  subject: string
  html?: string
  text?: string
}

export interface ThankYouEmailData {
  customerEmail: string
  customerName?: string
}

export type SendResult = { success: true; id?: string } | { success: false; error: string }

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function firstName(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there"
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://toneofvoice.app").replace(/\/+$/, "")
}

class EmailService {
  /** Sends via Resend. Never throws and never logs the recipient. */
  async sendEmail(data: EmailData): Promise<SendResult> {
    const key = process.env.RESEND_API_KEY
    if (!key) {
      console.log("[email] RESEND_API_KEY not set; email not sent:", data.subject)
      return { success: false, error: "No API key configured" }
    }
    try {
      // onboarding@resend.dev works without a verified domain (local/dev).
      const from =
        process.env.NODE_ENV === "production"
          ? "Tahi from Tone of Voice App <support@toneofvoice.app>"
          : "Tahi from Tone of Voice App <onboarding@resend.dev>"
      const result = await getResend(key).emails.send({
        from,
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text ?? "",
      })
      console.log("[email] Sent:", result.data?.id)
      return { success: true, id: result.data?.id }
    } catch (error) {
      console.error("[email] Send failed:", error instanceof Error ? error.message : error)
      return { success: false, error: "Send failed" }
    }
  }

  async sendThankYouEmail(data: ThankYouEmailData): Promise<SendResult> {
    return this.sendEmail({
      to: data.customerEmail,
      subject: "Thanks for your purchase!",
      html: thankYouHtml(data),
      text: thankYouText(data),
    })
  }
}

function thankYouHtml(data: ThankYouEmailData): string {
  const name = escapeHtml(firstName(data.customerName))
  const dashboardUrl = escapeHtml(`${appUrl()}/dashboard`)
  return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Thank you for using Tone of Voice App!</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <p style="margin-bottom: 20px;">Hey ${name},</p>
          <p style="margin-bottom: 15px;">I'm Tahi. I built Tone of Voice App because I kept wasting hours piecing together brand voice docs for clients.</p>
          <p style="margin-bottom: 15px;">Seeing your order come through today honestly made my week. 🙌</p>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 25px 0;">
            <p style="margin: 0 0 15px 0; font-weight: 500;">If you have 2 minutes:</p>
            <ol style="margin: 0; padding-left: 20px;">
              <li style="margin-bottom: 8px;">What problem were you hoping Tone of Voice App would solve?</li>
              <li style="margin-bottom: 8px;">What nearly stopped you from buying?</li>
              <li style="margin-bottom: 0;">Anything else you wanna share :)</li>
            </ol>
          </div>
          <p style="margin-bottom: 15px;">And if you've got questions about Tone of Voice App, here's my direct Calendly link (15 min, no pitch):</p>
          <div style="text-align: center; margin: 25px 0;">
            <a href="https://calendly.com/l-gichigi/customer-chat"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              📅 Chat with Tahi (15 min)
            </a>
          </div>
          <div style="text-align: center; margin: 25px 0;">
            <a href="${dashboardUrl}"
               style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              Open your guides
            </a>
          </div>
          <p style="margin-bottom: 15px;">Thanks again for being one of our very first customers. Anything you need, just hit reply — it's really me on the other end.</p>
          <p style="margin-bottom: 5px;">Cheers,<br>
          Tahi<br>
          Founder, Tone of Voice App<br>
          <a href="https://x.com/tahigichigi" style="color: #2563eb;">x.com/tahigichigi</a></p>
        </body>
      </html>
    `
}

function thankYouText(data: ThankYouEmailData): string {
  return `Hey ${firstName(data.customerName)},

I'm Tahi. I built Tone of Voice App because I kept wasting hours piecing together brand voice docs for clients.

Seeing your order come through today honestly made my week. 🙌

If you have 2 minutes:
1. What problem were you hoping Tone of Voice App would solve?
2. What nearly stopped you from buying?
3. Anything else you wanna share :)

And if you've got questions about Tone of Voice App, here's my direct Calendly link (15 min, no pitch): https://calendly.com/l-gichigi/customer-chat

Open your guides: ${appUrl()}/dashboard

Thanks again for being one of our very first customers. Anything you need, just hit reply — it's really me on the other end.

Cheers,
Tahi
Founder, Tone of Voice App
x.com/tahigichigi`
}

export const emailService = new EmailService()
