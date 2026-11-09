/**
 * Email Layout Service: Canonical SKY BLUE Theme for Orrica Edge
 * -------------------------------------------------------------
 * Provides a responsive, Outlook & Gmail compatible email wrapper
 * and sky blue styled components.
 *
 * Design Tokens:
 * - Primary Accent: #0EA5E9 (Sky 500)
 * - Primary Hover / Deep: #0284C7 (Sky 600)
 * - Brand Dark / Heading: #0C4A6E (Sky 900)
 * - Light Tint / Background: #F0F9FF (Sky 50)
 * - Border / Divider: #E0F2FE (Sky 100) / #BAE6FD (Sky 200)
 * - Body Text: #1E293B (Slate 800)
 * - Muted Text: #64748B (Slate 500)
 * - Surface / Card: #FFFFFF
 */

export interface EmailLayoutOptions {
  contentHtml: string;
  preheader?: string;
  title?: string;
}

export const wrapWithSkyBlueLayout = (options: EmailLayoutOptions | string): string => {
  const contentHtml = typeof options === 'string' ? options : options.contentHtml;
  const preheader = typeof options === 'object' && options.preheader ? options.preheader : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Orrica Edge</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td, p, a { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#F0F9FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  ${preheader ? `
  <div style="display:none;font-size:1px;color:#F0F9FF;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">
    ${preheader}
  </div>` : ''}

  <!-- OUTER WRAPPER TABLE -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F0F9FF" style="background-color:#F0F9FF;width:100%;table-layout:fixed;padding:32px 12px;">
    <tr>
      <td align="center" style="padding:0;">
        <!-- INNER CONTAINER CARD -->
        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
        <![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#FFFFFF" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E0F2FE;box-shadow:0 8px 24px rgba(14,165,233,0.08);">
          
          <!-- BRAND HEADER BANNER -->
          <tr>
            <td bgcolor="#0284C7" style="background:linear-gradient(135deg, #0284C7 0%, #0EA5E9 100%);background-color:#0284C7;padding:26px 32px;text-align:left;border-bottom:3px solid #BAE6FD;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:0.8px;display:inline-block;text-transform:uppercase;">
                      ORRICA EDGE
                    </span>
                    <span style="display:block;font-size:11px;color:#E0F2FE;text-transform:uppercase;letter-spacing:1.5px;margin-top:3px;font-weight:600;">
                      Talent Acquisition Platform
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN BODY CONTAINER -->
          <tr>
            <td style="padding:32px 28px;color:#1E293B;font-size:14.5px;line-height:1.65;">
              ${contentHtml}
            </td>
          </tr>

          <!-- DIVIDER -->
          <tr>
            <td style="padding:0 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="border-top:1px solid #E0F2FE;font-size:0;line-height:0;height:1px;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td bgcolor="#F0F9FF" style="background-color:#F0F9FF;padding:24px 28px;font-size:11.5px;line-height:1.6;color:#64748B;text-align:center;">
              <p style="margin:0 0 6px;font-weight:700;color:#0C4A6E;font-size:12px;">
                Orrica Edge Recruitment Solutions
              </p>
              <p style="margin:0 0 6px;color:#64748B;">
                Automated update sent from <span style="color:#0284C7;font-weight:600;">noreply@update.orricaedge.com</span>
              </p>
              <p style="margin:0 0 10px;color:#64748B;">
                Support: <a href="mailto:info@orricaedge.com" style="color:#0284C7;text-decoration:none;font-weight:600;">info@orricaedge.com</a> &bull; +91 97537 91491
              </p>
              <p style="margin:0;font-size:11px;color:#94A3B8;">
                &copy; 2026 Orrica Edge. All rights reserved. &bull;
                <a href="https://orricaedge.com/privacy" style="color:#64748B;text-decoration:underline;">Privacy Policy</a> &bull;
                <a href="https://orricaedge.com" style="color:#0284C7;text-decoration:none;font-weight:600;">orricaedge.com</a>
              </p>
            </td>
          </tr>

        </table>
        <!--[if (gte mso 9)|(IE)]>
            </td>
          </tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
};
