const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

let ses;

function init() {
  ses = new SESClient({
    region: process.env.AWS_REGION || 'ap-southeast-2',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log('[SES] Initialized');
}

async function send({ to, subject, body, replyTo }) {
  const fromName = process.env.SES_FROM_NAME || 'Jimmy Grills';
  const fromEmail = process.env.SES_FROM_EMAIL;

  const params = {
    Source: `${fromName} <${fromEmail}>`,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: body, Charset: 'UTF-8' },
      },
    },
  };

  if (replyTo) {
    params.ReplyToAddresses = [replyTo];
  }

  const command = new SendEmailCommand(params);
  const result = await ses.send(command);

  console.log(`[SES] Sent to ${to} — MessageId: ${result.MessageId}`);
  return { messageId: result.MessageId };
}

module.exports = { init, send };
