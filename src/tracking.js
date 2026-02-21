const db = require('./database');

const BASE_URL = () => (process.env.BASE_URL || '').replace(/\/$/, '');

/**
 * Prepare an email for tracked sending.
 * Creates a tracking record, converts plain text body to HTML with
 * a tracking pixel and click-tracked links.
 * Returns { token, trackingId, textBody, htmlBody }
 */
function prepareTrackedEmail({ contactId, threadId, broadcastId, body }) {
  const { id: trackingId, token } = db.createTrackingToken({
    contactId, threadId, broadcastId,
  });

  const textBody = body;
  const campaign = broadcastId ? `broadcast_${broadcastId}` : `thread_${threadId}`;
  const htmlBody = buildTrackedHtml({ body, token, campaign });

  return { token, trackingId, textBody, htmlBody };
}

/**
 * Convert plain text body to HTML with click-tracked links and a tracking pixel.
 * Returns null if BASE_URL is not configured.
 */
function buildTrackedHtml({ body, token, campaign }) {
  const baseUrl = BASE_URL();
  if (!baseUrl) {
    console.warn('[Tracking] BASE_URL not set — skipping HTML tracking');
    return null;
  }

  let html = escapeHtml(body);

  // Replace URLs with tracked redirects + UTM params on the destination
  const urlRegex = /(https?:\/\/[^\s<>"')\]]+)/g;
  html = html.replace(urlRegex, (url) => {
    const separator = url.includes('?') ? '&' : '?';
    const utmUrl = `${url}${separator}utm_source=jimmy-email-agent&utm_medium=email&utm_campaign=${campaign}&utm_content=${token}`;
    const encodedUrl = encodeURIComponent(utmUrl);
    const trackedUrl = `${baseUrl}/t/click/${token}?url=${encodedUrl}`;
    return `<a href="${trackedUrl}">${url}</a>`;
  });

  // Convert newlines to <br> for HTML rendering
  html = html.replace(/\n/g, '<br>\n');

  // Wrap in minimal HTML structure with tracking pixel and unsubscribe link
  const unsubscribeUrl = `${baseUrl}/unsubscribe/${token}`;
  html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: #333;">
${html}
<br><br>
<div style="font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 10px; margin-top: 20px;">
<a href="${unsubscribeUrl}" style="color: #999;">Unsubscribe</a>
</div>
<img src="${baseUrl}/t/open/${token}" width="1" height="1" alt="" style="display:none;" />
</body>
</html>`;

  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { prepareTrackedEmail };
