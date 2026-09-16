'use strict';

/* baseops-sfo2-api
 *
 * Replaces the n8n workflow "SFO2 — Lead Capture → Email", which stopped working
 * when the n8n Cloud trial expired.
 *
 *   GET  /            health
 *   GET  /probe       connectivity probe (egress region + Paragon reachability)
 *   POST /lead        landing-page form → reference + emails + Airtable row
 *
 * Deployed on Railway in a US region — that is load-bearing. Paragon's edge drops
 * connections routing from outside the US, which is what killed the n8n path.
 *
 * Credentials come from Railway environment variables. Never commit them.
 */

const http = require('http');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;

const CFG = {
  smtpHost: process.env.SMTP_HOST || 'smtp.zoho.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  leadTo: (process.env.LEAD_TO || '').split(',').map(s => s.trim()).filter(Boolean),

  airtableToken: process.env.AIRTABLE_TOKEN || '',
  airtableBase: process.env.AIRTABLE_BASE || '',
  airtableTable: process.env.AIRTABLE_TABLE || '',

  allowedOrigins: (process.env.ALLOWED_ORIGINS ||
    'https://www.baseops.tech,https://baseops.tech')
    .split(',').map(s => s.trim()).filter(Boolean),

  price: Number(process.env.OFFER_PRICE || 75)
};

/* ---------------------------------------------------------------- helpers */

const clean = v => (v === undefined || v === null) ? '' : String(v).trim();

const esc = s => String(s).replace(/[&<>"]/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function toE164(raw) {
  const d = clean(raw).replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

function pretty(e164) {
  if (!e164) return '';
  const d = e164.replace(/\D/g, '').slice(-10);
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

/* Join key between our lead record and the payment. Alphabet excludes I/L/O/0/1
   so it survives being read aloud over the phone. 11 chars total. */
function makeInvNum() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return 'SFO2-' + s;
}

const ROLES = { lead: 'Lead', follow: 'Follow', undecided: 'Still deciding' };
const VALID_SOURCES = ['qr-studio', 'qr-social', 'ig-bio', 'email-campaign', 'referral', 'direct'];

/* ------------------------------------------------------------ normalising */

function normalise(body) {
  const b = body || {};
  const fullName = clean(b.name);
  const parts = fullName.split(/\s+/).filter(Boolean);
  const first = parts.length ? parts[0] : '';
  const last = parts.length > 1 ? parts.slice(1).join(' ') : '';

  const phoneE164 = toE164(b.phone);
  const email = clean(b.email).toLowerCase();

  const roleRaw = clean(b.dance_role).toLowerCase();
  const source = VALID_SOURCES.includes(clean(b.source)) ? clean(b.source) : 'direct';
  const consent = b.sms_consent === true || b.sms_consent === 'true';

  const errors = [];
  if (!first) errors.push('name missing');
  if (!phoneE164) errors.push('phone invalid');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('email invalid');

  return {
    name: fullName,
    first_name: first,
    last_name: last,
    phone: phoneE164,
    phone_display: pretty(phoneE164),
    email,
    dance_role: ROLES[roleRaw] ? roleRaw : null,
    dance_role_label: ROLES[roleRaw] || 'Not provided',
    source,
    sms_consent: consent,
    consent_timestamp: consent ? new Date().toISOString() : null,
    consent_text_version: consent ? (clean(b.consent_text_version) || 'v1-2026-08') : null,
    offer: '5-class-pass',
    amount: CFG.price,
    invoice_number: makeInvNum(),
    status: 'new',
    intent: clean(b.intent) || 'checkout',
    created_at: new Date().toISOString(),
    valid: errors.length === 0,
    errors
  };
}

/* ----------------------------------------------------------------- email */

function buildEmail(lead) {
  const nowET = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  const subject = lead.errors.length
    ? '[CHECK] SFO2 lead — ' + (lead.name || 'unknown') + ' — ' + lead.errors.join(', ')
    : 'SFO2 Lead — ' + lead.name + ' — 5-Class Pass ($' + CFG.price + ') — ' + lead.invoice_number;

  const row = (k, v, mono) =>
    '<tr><td style="padding:9px 14px;border-bottom:1px solid #eee;color:#666;font-size:13px;white-space:nowrap">' +
    esc(k) + '</td><td style="padding:9px 14px;border-bottom:1px solid #eee;color:#111;font-size:15px;' +
    (mono ? 'font-family:ui-monospace,Menlo,monospace;' : '') + 'font-weight:600">' + esc(v) + '</td></tr>';

  const warn = lead.errors.length
    ? '<div style="background:#FFF4F3;border:1px solid #F3C9C6;border-radius:8px;padding:12px 14px;margin:0 0 18px;color:#B3312A;font-size:14px"><b>Check before entering:</b> ' +
      esc(lead.errors.join(' · ')) + '</div>'
    : '';

  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:22px">' +
    '<div style="background:linear-gradient(100deg,#FBAB7E,#F7CE68);border-radius:12px 12px 0 0;padding:16px 20px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#111;opacity:.75">Salsa Fever On2 · New student</div>' +
    '<div style="font-size:21px;font-weight:800;color:#111;margin-top:3px">' + esc(lead.name || 'Name missing') + '</div></div>' +
    '<div style="border:1px solid #e6e6e6;border-top:none;border-radius:0 0 12px 12px;padding:20px">' + warn +
    '<p style="margin:0 0 16px;font-size:14px;color:#444">Enter this student into WellnessLiving, then reply <b>DONE</b> to this email.</p>' +
    '<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden">' +
    row('First name', lead.first_name || '—') +
    row('Last name', lead.last_name || '—') +
    row('Mobile', lead.phone_display || '—', true) +
    row('E.164', lead.phone || '—', true) +
    row('Email', lead.email || '—', true) +
    row('Purchase', '5-Class Pass — $' + CFG.price) +
    row('Lead / Follow', lead.dance_role_label) +
    row('SMS opt-in', lead.sms_consent ? 'YES — consented' : 'No') +
    row('Source', lead.source, true) +
    row('Reference', lead.invoice_number, true) +
    row('Submitted', nowET + ' ET') +
    '</table>' +
    '<div style="margin-top:18px;background:#FAFAFA;border:1px solid #eee;border-radius:8px;padding:14px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:8px">Copy &amp; paste block</div>' +
    '<pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.7;color:#222;white-space:pre-wrap">' +
    esc(lead.first_name) + '\n' + esc(lead.last_name) + '\n' + esc(lead.phone_display) + '\n' + esc(lead.email) +
    '</pre></div>' +
    '<p style="margin:18px 0 0;font-size:12px;color:#999;line-height:1.6">' +
    (lead.sms_consent
      ? 'This student opted in to SMS. Consent recorded with timestamp and text version — safe to add to the texting list.'
      : 'This student did <b>not</b> opt in to SMS. Do not add them to any texting list.') +
    '</p></div></div>';

  /* Plain-text alternative. HTML-only mail is weighted against by spam filters,
     and Yahoo has already been fussy about this domain. */
  const text = [
    'SALSA FEVER ON2 — NEW STUDENT',
    '',
    'Name:          ' + (lead.name || '—'),
    'Mobile:        ' + (lead.phone_display || '—') + '  (' + (lead.phone || '—') + ')',
    'Email:         ' + (lead.email || '—'),
    'Purchase:      5-Class Pass — $' + CFG.price,
    'Lead / Follow: ' + lead.dance_role_label,
    'SMS opt-in:    ' + (lead.sms_consent ? 'YES — consented' : 'No'),
    'Source:        ' + lead.source,
    'Reference:     ' + lead.invoice_number,
    'Submitted:     ' + nowET + ' ET',
    lead.errors.length ? '' : null,
    lead.errors.length ? 'CHECK BEFORE ENTERING: ' + lead.errors.join(', ') : null,
    '',
    'Enter this student into WellnessLiving, then reply DONE to this email.'
  ].filter(l => l !== null).join('\n');

  return { subject, html, text };
}

let transporter = null;
function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: CFG.smtpHost,
      port: CFG.smtpPort,
      secure: CFG.smtpPort === 465,
      auth: { user: CFG.smtpUser, pass: CFG.smtpPass }
    });
  }
  return transporter;
}

/* One send per recipient rather than one message with several To: addresses.
   A bounce for one address then cannot suppress delivery to the other. */
async function sendLeadEmails(lead) {
  const { subject, html, text } = buildEmail(lead);
  const results = await Promise.allSettled(
    CFG.leadTo.map(to => mailer().sendMail({ from: CFG.mailFrom, to, subject, html, text }))
  );
  return CFG.leadTo.map((to, i) => ({
    to,
    ok: results[i].status === 'fulfilled',
    error: results[i].status === 'rejected' ? String(results[i].reason && results[i].reason.message) : null
  }));
}

/* --------------------------------------------------------------- airtable */

async function writeAirtable(lead) {
  if (!CFG.airtableToken || !CFG.airtableBase || !CFG.airtableTable) {
    return { ok: false, skipped: true, error: 'airtable not configured' };
  }
  const url = 'https://api.airtable.com/v0/' + CFG.airtableBase + '/' + CFG.airtableTable;
  const fields = {
    'Name': lead.name,
    'Reference': lead.invoice_number,
    'First Name': lead.first_name,
    'Last Name': lead.last_name,
    'Phone': lead.phone || '',
    'Email': lead.email,
    'Lead / Follow': lead.dance_role_label,
    'SMS Opt-in': lead.sms_consent,
    'Source': lead.source,
    'Offer': lead.offer,
    'Amount': lead.amount,
    'Status': lead.status,
    'Submitted': lead.created_at,
    'Valid': lead.valid,
    'Errors': lead.errors.join(', ')
  };
  if (lead.consent_timestamp) fields['Consent Timestamp'] = lead.consent_timestamp;
  if (lead.consent_text_version) fields['Consent Text Version'] = lead.consent_text_version;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CFG.airtableToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields, typecast: true })
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, id: body.id || null, error: res.ok ? null : JSON.stringify(body).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/* -------------------------------------------------------------------- CORS */

function corsHeaders(origin) {
  const allowed = origin && CFG.allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : CFG.allowedOrigins[0] || '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ probe */

async function connectivityProbe() {
  const check = async (name, url, options) => {
    const started = Date.now();
    try {
      const res = await fetch(url, options || {});
      const text = await res.text();
      return { name, ok: true, status: res.status, ms: Date.now() - started, body: text.slice(0, 200) };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - started, error: String(err && err.message) };
    }
  };
  const [egress, paragon] = await Promise.all([
    check('egress', 'https://ifconfig.co/json'),
    check('paragon_token_endpoint', 'https://stage.paragonsolutions.com/api/v2/hp/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'probe' })
    })
  ]);
  let country = null;
  try { country = JSON.parse(egress.body || '{}').country_iso || null; } catch (e) {}
  return { egress_country: country, paragon_reachable: paragon.ok, checks: [egress, paragon] };
}

/* ----------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);

  const json = (status, payload) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify(payload, null, 2));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
    return json(200, {
      service: 'baseops-sfo2-api',
      ok: true,
      configured: {
        smtp: Boolean(CFG.smtpUser && CFG.smtpPass),
        recipients: CFG.leadTo.length,
        airtable: Boolean(CFG.airtableToken && CFG.airtableBase && CFG.airtableTable)
      },
      time: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/probe') {
    return json(200, await connectivityProbe());
  }

  if (req.method === 'POST' && url.pathname === '/lead') {
    let parsed;
    try {
      const raw = await readBody(req, 64 * 1024);
      parsed = JSON.parse(raw || '{}');
    } catch (err) {
      return json(400, { ok: false, error: 'invalid body' });
    }

    const lead = normalise(parsed);

    /* Email and Airtable run together. Neither is allowed to fail the request:
       the student is mid-signup and a logging problem must not look to them
       like their submission failed. */
    const [emails, airtable] = await Promise.all([
      sendLeadEmails(lead).catch(err => [{ ok: false, error: String(err && err.message) }]),
      writeAirtable(lead)
    ]);

    const anyEmail = emails.some(e => e.ok);
    if (!anyEmail) console.error('LEAD EMAIL FAILED', lead.invoice_number, JSON.stringify(emails));
    if (!airtable.ok) console.error('LEAD AIRTABLE FAILED', lead.invoice_number, airtable.error);
    console.log('lead', lead.invoice_number, 'valid=' + lead.valid,
      'email=' + emails.filter(e => e.ok).length + '/' + emails.length,
      'airtable=' + (airtable.ok ? 'ok' : 'fail'));

    /* payment_url stays null while checkout runs through WellnessLiving.
       /paragon-token will populate it once the Paragon path is switched on. */
    return json(200, {
      ok: true,
      received: lead.valid,
      errors: lead.errors,
      invoice_number: lead.invoice_number,
      payment_url: null
    });
  }

  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log('baseops-sfo2-api listening on ' + PORT);
  console.log('smtp=' + (CFG.smtpUser ? 'configured' : 'MISSING') +
    ' recipients=' + CFG.leadTo.length +
    ' airtable=' + (CFG.airtableToken ? 'configured' : 'MISSING'));
});
