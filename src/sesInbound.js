const { simpleParser } = require('mailparser');

// Parse an SNS notification containing an SES inbound email
async function parseSesNotification(snsMessage) {
  // SES wraps the email in a notification object
  const sesNotification = typeof snsMessage === 'string' ? JSON.parse(snsMessage) : snsMessage;

  // The raw email content is in the 'content' field
  const rawEmail = sesNotification.content;
  if (!rawEmail) {
    // If no content, try to extract from the SES mail object
    const mail = sesNotification.mail;
    if (!mail) throw new Error('No email content in SES notification');

    return {
      from_email: mail.source || mail.commonHeaders?.from?.[0],
      from_name: extractName(mail.commonHeaders?.from?.[0] || ''),
      subject: mail.commonHeaders?.subject || '(no subject)',
      text_body: 'Email body not available — stored in S3. Check AWS console.',
      message_id: mail.messageId,
    };
  }

  // Parse the raw MIME email
  const parsed = await simpleParser(rawEmail);

  return {
    from_email: parsed.from?.value?.[0]?.address || '',
    from_name: parsed.from?.value?.[0]?.name || '',
    subject: parsed.subject || '(no subject)',
    text_body: parsed.text || parsed.html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '',
    message_id: parsed.messageId,
  };
}

// Extract display name from "Name <email>" format
function extractName(fromHeader) {
  const match = fromHeader.match(/^(.+?)\s*<.*>$/);
  return match ? match[1].replace(/"/g, '').trim() : '';
}

// Validate that an SNS message is actually from AWS
// In production, verify the signing certificate
function validateSnsMessage(body) {
  if (!body.Type) return false;
  if (!body.TopicArn?.startsWith('arn:aws:sns:')) return false;
  return true;
}

module.exports = { parseSesNotification, validateSnsMessage };
