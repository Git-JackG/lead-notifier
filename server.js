require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const axios = require('axios');

const app = express();
app.use(express.json());

// ── Meta Webhook Verification ──────────────────────────────────────────────
// Meta sends a GET request when you first connect the webhook.
// It must return the hub.challenge value to confirm ownership.
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Meta Webhook Event Receiver ────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Acknowledge immediately — Meta will retry if it doesn't get 200 fast
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry) {
      for (const change of (entry.changes || [])) {
        if (change.field === 'leadgen') {
          const leadId  = change.value.leadgen_id;
          const formId  = change.value.form_id;
          const adName  = change.value.ad_name || 'Unknown Ad';
          console.log(`New lead received — lead_id: ${leadId}, ad: ${adName}`);
          await processLead(leadId, adName);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ── Fetch lead data and send SMS ───────────────────────────────────────────
async function processLead(leadId, adName) {
  const url = `https://graph.facebook.com/v20.0/${leadId}`;
  const response = await axios.get(url, {
    params: {
      access_token: process.env.META_PAGE_ACCESS_TOKEN,
      fields: 'field_data,created_time'
    }
  });

  const lead   = response.data;
  const fields = {};

  for (const field of (lead.field_data || [])) {
    // Normalize key: lowercase, replace spaces/hyphens with underscores
    const key        = field.name.toLowerCase().replace(/[\s\-]/g, '_');
    fields[key]      = field.values[0];
  }

  // Support common Meta field name variations
  const firstName = fields['first_name']    || '';
  const lastName  = fields['last_name']     || '';
  const fullName  = fields['full_name']
                 || fields['name']
                 || `${firstName} ${lastName}`.trim()
                 || 'Not provided';

  const phone = fields['phone_number']
             || fields['phone']
             || 'Not provided';

  const email = fields['email']
             || fields['email_address']
             || null;

  let message = `New Lead!\nName: ${fullName}\nPhone: ${phone}`;
  if (email)   message += `\nEmail: ${email}`;
  if (adName)  message += `\nAd: ${adName}`;

  console.log('Sending SMS:', message);
  await sendSMS(message);
}

// ── Send email notification via Resend ────────────────────────────────────
async function sendSMS(message) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const lines = message.split('\n');
  const subject = lines[0];
  const htmlBody = lines.map(l => `<p style="margin:4px 0">${l}</p>`).join('');

  await resend.emails.send({
    from:    'Lead Notifier <onboarding@resend.dev>',
    to:      process.env.NOTIFY_EMAIL,
    subject: subject,
    html:    htmlBody
  });

  console.log('Email notification sent');
}

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lead notification server running on port ${PORT}`));
