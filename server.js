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

  /* Mail goes out over HTTP, not SMTP — Railway blocks outbound 465 and 587
     (both ETIMEDOUT, confirmed via /selftest on 2026-09-16). */
  resendKey: process.env.RESEND_API_KEY || '',

  airtableToken: process.env.AIRTABLE_TOKEN || '',
  airtableBase: process.env.AIRTABLE_BASE || '',
  airtableTable: process.env.AIRTABLE_TABLE || '',

  allowedOrigins: (process.env.ALLOWED_ORIGINS ||
    'https://www.baseops.tech,https://baseops.tech')
    .split(',').map(s => s.trim()).filter(Boolean),

  price: Number(process.env.OFFER_PRICE || 75),

  /* Paragon hosted checkout. Credentials come from PUREsight →
     Hosted Page → Misc → Generate. Generating a new pair invalidates the old
     one, so retrieve rather than regenerate if they already exist.
     While any of these are blank, payment_url comes back null and the landing
     page falls through to WellnessLiving. */
  paragonUser: process.env.PARAGON_HP_USER || '',
  paragonPass: process.env.PARAGON_HP_PASS || '',
  paragonMerchantKey: process.env.PARAGON_MERCHANT_KEY || '',
  paragonTokenUrl: process.env.PARAGON_TOKEN_URL ||
    'https://stage.paragonsolutions.com/api/v2/hp/token',
  paragonPayBase: process.env.PARAGON_PAY_BASE ||
    'https://stage.shpp.paragonsolutions.com/payment'
};

const paragonConfigured = () =>
  Boolean(CFG.paragonUser && CFG.paragonPass && CFG.paragonMerchantKey);

/* --- Twilio SMS ---
   Transactional only for now: a confirmation of a purchase the student just
   made. Nothing promotional goes out on this path, because the consent
   checkbox on the form is optional and unticked by default — marketing to
   someone who did not tick it is exactly what that checkbox exists to prevent. */
CFG.twilioSid = process.env.TWILIO_ACCOUNT_SID || '';
CFG.twilioToken = process.env.TWILIO_AUTH_TOKEN || '';
CFG.twilioFrom = process.env.TWILIO_FROM || '';
CFG.studioPhone = process.env.STUDIO_PHONE || '201-792-1616';
CFG.studioAddress = process.env.STUDIO_ADDRESS || '83 Franklin St, Jersey City';

/* "dow:hour:label" entries, comma separated. Sunday = 0.
   UNCONFIRMED by Mario as of 2026-09-17 — kept in config precisely so it can
   be corrected without a deploy. */
CFG.classSchedule = (process.env.CLASS_SCHEDULE || '1:19:7pm,6:12:12pm')
  .split(',')
  .map(s => s.trim().split(':'))
  .filter(p => p.length === 3)
  .map(p => ({ dow: Number(p[0]), hour: Number(p[1]), label: p[2] }));

const smsConfigured = () =>
  Boolean(CFG.twilioSid && CFG.twilioToken && CFG.twilioFrom);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Next scheduled class in studio time, skipping one that has already started. */
function nextClassText() {
  if (!CFG.classSchedule.length) return null;
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  for (let d = 0; d < 21; d++) {
    const day = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate() + d);
    for (const s of CFG.classSchedule) {
      if (day.getDay() !== s.dow) continue;
      const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.hour);
      if (when <= nowET) continue;
      return DAYS[when.getDay()] + ' ' + MONTHS[when.getMonth()] + ' ' + when.getDate() + ', ' + s.label;
    }
  }
  return null;
}

async function sendSms(to, body) {
  if (!smsConfigured()) return { ok: false, error: 'twilio not configured' };
  if (!to) return { ok: false, error: 'no phone number' };

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' +
    encodeURIComponent(CFG.twilioSid) + '/Messages.json';
  const auth = Buffer.from(CFG.twilioSid + ':' + CFG.twilioToken).toString('base64');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: CFG.twilioFrom, Body: body }).toString(),
      signal: ac.signal
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      sid: json.sid || null,
      error: res.ok ? null : (json.message || ('HTTP ' + res.status))
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

/* Deliberately factual and short. No marketing language, no links to follow,
   nothing that would make this read as promotional to a regulator.

   ASCII ONLY — and this matters commercially. Any character outside GSM-7 (an
   em dash, curly quote, accent) switches the whole message to UCS-2, which cuts
   the per-segment limit from 160 to 70. One stray dash turns a single-segment
   text into three and triples the cost of every send. */
function toGsm7(s) {
  return String(s)
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function paymentSmsBody(firstName, payment) {
  const next = nextClassText();
  const body = [
    'Salsa Fever On2: payment received' + (payment.amount ? (', $' + payment.amount) : '') + '.',
    firstName ? ('Thanks ' + firstName + '!') : '',
    next ? ('Next class ' + next + ', ' + CFG.studioAddress + '.') : (CFG.studioAddress + '.'),
    'Questions ' + CFG.studioPhone + '.',
    'Ref ' + (payment.invoice_number || '')
  ].filter(Boolean).join(' ');
  return toGsm7(body);
}

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

/* Timeouts are not optional here. Without them nodemailer waits minutes on a
   blocked port, which is how /lead first came to hang with no response.
   Kept only for /selftest — Railway blocks outbound SMTP on 465 and 587, so
   mail actually goes out over HTTP via Resend. */
function makeTransport(port) {
  return nodemailer.createTransport({
    host: CFG.smtpHost,
    port: port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000
  });
}

/* One send per recipient rather than one message with several To: addresses.
   A bounce for one address then cannot suppress delivery to the other. */
async function sendLeadEmails(lead) {
  if (!CFG.resendKey) {
    return CFG.leadTo.map(to => ({ to, ok: false, error: 'RESEND_API_KEY not set' }));
  }
  const { subject, html, text } = buildEmail(lead);

  const sendOne = async (to) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + CFG.resendKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject, html, text }),
        signal: ac.signal
      });
      const body = await res.json().catch(() => ({}));
      return {
        to,
        ok: res.ok,
        id: body.id || null,
        error: res.ok ? null : (JSON.stringify(body).slice(0, 200) || ('HTTP ' + res.status))
      };
    } catch (err) {
      return { to, ok: false, error: String(err && err.message) };
    } finally {
      clearTimeout(timer);
    }
  };

  return Promise.all(CFG.leadTo.map(sendOne));
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

/* ---------------------------------------------------------------- paragon */

/* Mint a short-lived SecureToken. Credentials go server-side only — the
   browser never sees them, which is the whole reason this runs here.
   Token lifetime is 5 minutes per the July 2026 integration guide; the student
   is redirected immediately, so that is ample. */
async function mintParagonToken(lead) {
  if (!paragonConfigured()) return { token: null, error: 'paragon not configured' };
  if (!lead.valid) return { token: null, error: 'lead failed validation' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(CFG.paragonTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: CFG.paragonUser,
        password: CFG.paragonPass,
        /* Binds the amount to the token so it cannot be edited in the URL. */
        extendedInfo: { transactionInfo: { amount: CFG.price.toFixed(2) } }
      }),
      signal: ac.signal
    });

    const raw = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }

    if (!res.ok) {
      return { token: null, error: 'HTTP ' + res.status + ' ' + String(raw).slice(0, 200) };
    }
    /* Response shape unconfirmed against a live credential — accept the
       documented key plus plausible variants, and a bare string. */
    const token = (parsed && (parsed.token || parsed.Token || parsed.secureToken || parsed.SecureToken)) ||
      (typeof parsed === 'string' && parsed.trim() && !parsed.includes(' ') ? parsed.trim() : null);

    if (!token) return { token: null, error: 'no token in response: ' + String(raw).slice(0, 200) };
    return { token, error: null };
  } catch (err) {
    return { token: null, error: String(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

function buildPaymentUrl(token, lead) {
  const q = new URLSearchParams({
    SecureToken: token,
    MerchantKey: CFG.paragonMerchantKey,
    Amount: CFG.price.toFixed(2),
    InvoiceNumber: lead.invoice_number,   /* join key back to the Airtable row */
    EchoID: lead.source,                  /* echoed back on the callback */
    Email: lead.email,
    BillingFirstName: lead.first_name,
    BillingLastName: lead.last_name
  });
  return CFG.paragonPayBase + '?' + q.toString();
}

/* Find the Leads row for a reference and mark it paid.
   The n8n version of this once updated the WRONG row because a filter was
   silently ignored, so the returned record's Reference is re-checked here
   before anything is written. */
async function markLeadPaid(invoiceNumber, payment) {
  if (!CFG.airtableToken || !invoiceNumber) {
    return { ok: false, error: 'missing token or reference' };
  }
  const baseUrl = 'https://api.airtable.com/v0/' + CFG.airtableBase + '/' + CFG.airtableTable;
  const formula = '{Reference}="' + invoiceNumber.replace(/"/g, '') + '"';
  const auth = { 'Authorization': 'Bearer ' + CFG.airtableToken };

  try {
    const findRes = await fetch(baseUrl + '?maxRecords=1&filterByFormula=' + encodeURIComponent(formula), { headers: auth });
    const found = await findRes.json();
    const rec = (found.records || [])[0];

    if (!rec) return { ok: false, error: 'no row for ' + invoiceNumber };
    if (String(rec.fields && rec.fields.Reference).trim() !== invoiceNumber.trim()) {
      return { ok: false, error: 'reference mismatch — refusing to update ' + rec.id };
    }

    const fields = {
      'Status': payment.approved ? 'paid' : 'payment_issue',
      'Paid At': payment.received_at
    };
    if (payment.pnref) fields['Payment Ref'] = payment.pnref;

    const upRes = await fetch(baseUrl, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({ records: [{ id: rec.id, fields }], typecast: true })
    });
    const upBody = await upRes.json().catch(() => ({}));
    /* Return the student's details too — the callback needs them to send the
       confirmation SMS, and this lookup already has them. */
    return {
      ok: upRes.ok,
      id: rec.id,
      fields: rec.fields || {},
      error: upRes.ok ? null : JSON.stringify(upBody).slice(0, 200)
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/* Paragon documents the Callback URL setting but not its payload. Parse
   defensively across plausible spellings and keep the raw body for the email,
   so the first real transaction tells us the true shape. */
function parseCallback(body, query) {
  const bag = {};
  for (const src of [query, body]) {
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (v !== null && typeof v === 'object') continue;
        bag[String(k).toLowerCase()] = v;
      }
    }
  }
  const pick = (...names) => {
    for (const n of names) {
      const v = bag[n.toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
  const result = pick('result', 'respcode', 'responsecode');
  return {
    invoice_number: pick('invoicenumber', 'invnum', 'invoice_number', 'invoice'),
    echo_id: pick('echoid', 'echo_id'),
    pnref: pick('pnref', 'payment_reference_number', 'transactionid'),
    result,
    resp_message: pick('respmsg', 'message', 'result_message'),
    amount: pick('amount', 'amt'),
    auth_code: pick('authcode', 'authorization_code', 'approval_code'),
    last_four: pick('lastfour', 'last4', 'card_number_last_four_digits'),
    card_type: pick('cardtype', 'card_type'),
    customer_name: pick('customername', 'name_on_card', 'customer_name'),
    approved: result === '0',
    received_at: new Date().toISOString()
  };
}

async function sendPaymentEmail(payment, raw, airtableResult, studentSms) {
  studentSms = studentSms || { ok: false, error: 'not attempted' };
  if (!CFG.resendKey) return [{ ok: false, error: 'RESEND_API_KEY not set' }];

  const matched = Boolean(payment.invoice_number);
  const subject = !matched
    ? '[UNMATCHED] SFO2 payment — no reference in callback'
    : (payment.approved
      ? 'SFO2 PAID — ' + payment.invoice_number + ' — $' + (payment.amount || '?')
      : '[CHECK] SFO2 payment not approved — ' + payment.invoice_number + ' — result ' + (payment.result || '?'));

  const row = (k, v) =>
    '<tr><td style="padding:9px 14px;border-bottom:1px solid #eee;color:#666;font-size:13px;white-space:nowrap">' +
    esc(k) + '</td><td style="padding:9px 14px;border-bottom:1px solid #eee;color:#111;font-size:15px;font-weight:600">' +
    esc(v) + '</td></tr>';

  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:22px">' +
    '<div style="background:' + (payment.approved ? '#7EE8A2' : '#F7A98F') + ';border-radius:12px 12px 0 0;padding:16px 20px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#111;opacity:.75">Salsa Fever On2 · Payment</div>' +
    '<div style="font-size:21px;font-weight:800;color:#111;margin-top:3px">' +
    (payment.approved ? 'Payment received' : 'Needs attention') + '</div></div>' +
    '<div style="border:1px solid #e6e6e6;border-top:none;border-radius:0 0 12px 12px;padding:20px">' +
    '<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden">' +
    row('Reference', payment.invoice_number || '— none sent —') +
    row('Transaction', payment.pnref || '—') +
    row('Amount', payment.amount ? ('$' + payment.amount) : '—') +
    row('Result', (payment.result || '—') + (payment.resp_message ? (' · ' + payment.resp_message) : '')) +
    row('Card', ((payment.card_type || '') + (payment.last_four ? (' ••••' + payment.last_four) : '')) || '—') +
    row('Source (EchoID)', payment.echo_id || '—') +
    row('Airtable', airtableResult.ok ? 'row marked ' + (payment.approved ? 'paid' : 'payment_issue') : ('NOT updated — ' + airtableResult.error)) +
    row('Confirmation SMS', studentSms.ok ? 'sent to the student' : ('not sent — ' + studentSms.error)) +
    '</table>' +
    '<div style="margin-top:18px;background:#FAFAFA;border:1px solid #eee;border-radius:8px;padding:14px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:8px">Raw callback — this is how we learn the real shape</div>' +
    '<pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;color:#222;white-space:pre-wrap">' +
    esc(JSON.stringify(raw, null, 2).slice(0, 2000)) + '</pre></div>' +
    '<p style="margin:18px 0 0;font-size:12px;color:#B3312A;line-height:1.6">' +
    'The student has paid but has no pass in WellnessLiving yet — create it, or confirm they registered themselves.' +
    '</p></div></div>';

  const text = 'SFO2 PAYMENT\n\nReference: ' + (payment.invoice_number || '—') +
    '\nTransaction: ' + (payment.pnref || '—') +
    '\nAmount: $' + (payment.amount || '?') +
    '\nResult: ' + (payment.result || '—') + ' ' + (payment.resp_message || '') +
    '\nAirtable: ' + (airtableResult.ok ? 'updated' : 'NOT updated — ' + airtableResult.error) +
    '\n\nThe student has paid but has no pass in WellnessLiving yet.';

  const sendOne = async (to) => {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + CFG.resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject, html, text })
      });
      return { to, ok: res.ok };
    } catch (err) {
      return { to, ok: false, error: String(err && err.message) };
    }
  };
  return Promise.all(CFG.leadTo.map(sendOne));
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
    /* Reports which env var NAMES are present — never their values. Exists
       because "configured: false" alone can't distinguish a typo from a
       variable set on the wrong service or a deploy that never picked it up. */
    const expected = ['RESEND_API_KEY', 'MAIL_FROM', 'LEAD_TO',
      'AIRTABLE_TOKEN', 'AIRTABLE_BASE', 'AIRTABLE_TABLE',
      'ALLOWED_ORIGINS', 'OFFER_PRICE',
      'PARAGON_HP_USER', 'PARAGON_HP_PASS', 'PARAGON_MERCHANT_KEY',
      'PARAGON_TOKEN_URL', 'PARAGON_PAY_BASE',
      'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
      'CLASS_SCHEDULE', 'STUDIO_PHONE', 'STUDIO_ADDRESS'];
    const present = {};
    expected.forEach(k => { present[k] = Boolean(process.env[k] && String(process.env[k]).trim()); });

    return json(200, {
      service: 'baseops-sfo2-api',
      ok: true,
      configured: {
        email: Boolean(CFG.resendKey),
        mail_from: CFG.mailFrom || null,
        recipients: CFG.leadTo.length,
        airtable: Boolean(CFG.airtableToken && CFG.airtableBase && CFG.airtableTable),
        paragon: paragonConfigured(),
        sms: smsConfigured()
      },
      next_class: nextClassText(),
      env_present: present,
      env_var_count: Object.keys(process.env).length,
      time: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url.pathname === '/probe') {
    return json(200, await connectivityProbe());
  }

  /* Which dependency is actually failing? Read-only: sends no mail, writes no
     records. `?smtp=1` additionally retries the blocked SMTP ports, which is
     only useful for re-confirming the Railway block. */
  if (req.method === 'GET' && url.pathname === '/selftest') {
    const smtp = {};
    if (url.searchParams.get('smtp') === '1') {
      for (const port of [465, 587]) {
        const started = Date.now();
        try {
          await makeTransport(port).verify();
          smtp['port_' + port] = { ok: true, ms: Date.now() - started };
        } catch (err) {
          smtp['port_' + port] = {
            ok: false,
            ms: Date.now() - started,
            error: String(err && err.message).slice(0, 200),
            code: (err && err.code) || null
          };
        }
      }
    }

    let resend = { ok: false, error: 'RESEND_API_KEY not set' };
    if (CFG.resendKey) {
      const rStarted = Date.now();
      try {
        const rr = await fetch('https://api.resend.com/domains', {
          headers: { 'Authorization': 'Bearer ' + CFG.resendKey }
        });
        const t = await rr.text();
        resend = { ok: rr.ok, status: rr.status, ms: Date.now() - rStarted, body: t.slice(0, 300) };
      } catch (err) {
        resend = { ok: false, ms: Date.now() - rStarted, error: String(err && err.message) };
      }
    }

    let twilio = { ok: false, error: 'TWILIO not configured' };
    if (smsConfigured()) {
      const tStarted = Date.now();
      try {
        const auth = Buffer.from(CFG.twilioSid + ':' + CFG.twilioToken).toString('base64');
        const tr = await fetch('https://api.twilio.com/2010-04-01/Accounts/' +
          encodeURIComponent(CFG.twilioSid) + '.json', { headers: { 'Authorization': 'Basic ' + auth } });
        const tj = await tr.json().catch(() => ({}));
        twilio = {
          ok: tr.ok,
          status: tr.status,
          ms: Date.now() - tStarted,
          account_status: tj.status || null,
          from: CFG.twilioFrom || null,
          error: tr.ok ? null : (tj.message || ('HTTP ' + tr.status))
        };
      } catch (err) {
        twilio = { ok: false, error: String(err && err.message) };
      }
    }

    let airtable;
    const aStarted = Date.now();
    try {
      const r = await fetch(
        'https://api.airtable.com/v0/' + CFG.airtableBase + '/' + CFG.airtableTable + '?maxRecords=1',
        { headers: { 'Authorization': 'Bearer ' + CFG.airtableToken } });
      const t = await r.text();
      airtable = { ok: r.ok, status: r.status, ms: Date.now() - aStarted, body: t.slice(0, 200) };
    } catch (err) {
      airtable = { ok: false, ms: Date.now() - aStarted, error: String(err && err.message) };
    }

    return json(200, {
      resend, airtable, twilio,
      mail_from: CFG.mailFrom,
      recipients: CFG.leadTo,
      next_class: nextClassText(),
      smtp
    });
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

    /* The token mint is the ONLY thing the response waits on, because the
       redirect URL depends on it (~700ms against stage). Email and Airtable
       run after the response — the student must never wait on those. An
       earlier version awaited email too and hung for minutes when the mail
       port stalled, leaving the form spinning.
       If minting fails, payment_url is null and the landing page falls back
       to WellnessLiving rather than showing an error. */
    const { token, error: tokenError } = await mintParagonToken(lead);
    const paymentUrl = token ? buildPaymentUrl(token, lead) : null;
    if (tokenError && paragonConfigured()) {
      console.error('PARAGON TOKEN FAILED', lead.invoice_number, tokenError);
    }

    json(200, {
      ok: true,
      received: lead.valid,
      errors: lead.errors,
      invoice_number: lead.invoice_number,
      payment_url: paymentUrl
    });

    Promise.allSettled([
      sendLeadEmails(lead),
      writeAirtable(lead)
    ]).then(([mailRes, airRes]) => {
      const emails = mailRes.status === 'fulfilled' ? mailRes.value : [{ ok: false, error: String(mailRes.reason && mailRes.reason.message) }];
      const airtable = airRes.status === 'fulfilled' ? airRes.value : { ok: false, error: String(airRes.reason && airRes.reason.message) };

      if (!emails.some(e => e.ok)) console.error('LEAD EMAIL FAILED', lead.invoice_number, JSON.stringify(emails));
      if (!airtable.ok) console.error('LEAD AIRTABLE FAILED', lead.invoice_number, airtable.error);
      console.log('lead', lead.invoice_number, 'valid=' + lead.valid,
        'email=' + emails.filter(e => e.ok).length + '/' + emails.length,
        'airtable=' + (airtable.ok ? 'ok' : 'fail'));
    });
    return;
  }

  /* Paragon's "Transaction Create" callback. Set this URL in PUREsight →
     Hosted Page → Fields → Callback URL.
     NOT AUTHENTICATED YET — anyone who learns this URL can post a forged
     payment. PUREsight → Administration → Keys holds HMAC keys; wire
     signature verification before real money moves. */
  if (req.method === 'POST' && url.pathname === '/paragon-callback') {
    let body = {};
    try {
      const raw = await readBody(req, 64 * 1024);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        body = JSON.parse(raw || '{}');
      } else {
        body = Object.fromEntries(new URLSearchParams(raw || ''));
      }
    } catch (err) {
      body = {};
    }
    const query = Object.fromEntries(url.searchParams);
    const payment = parseCallback(body, query);

    /* Always acknowledge. A non-2xx here could make Paragon retry or, worse,
       treat the payment as unsettled — the money has already moved. */
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    res.end('OK');

    const airtableResult = payment.invoice_number
      ? await markLeadPaid(payment.invoice_number, payment)
      : { ok: false, error: 'no reference in callback' };

    /* Transactional confirmation to the student. Only on an approved payment,
       only when we positively matched their row, and regardless of the SMS
       marketing opt-in — this is a receipt for a purchase they just made, not
       promotion. Anything promotional must be gated on that opt-in instead. */
    let studentSms = { ok: false, error: 'not attempted' };
    const studentFields = airtableResult.fields || {};
    if (payment.approved && airtableResult.ok && studentFields.Phone) {
      studentSms = await sendSms(
        studentFields.Phone,
        paymentSmsBody(studentFields['First Name'] || '', payment)
      );
      if (!studentSms.ok) {
        console.error('STUDENT SMS FAILED', payment.invoice_number, studentSms.error);
      }
    } else if (payment.approved && !studentFields.Phone) {
      studentSms = { ok: false, error: 'no phone on the matched row' };
    }

    console.log('callback', payment.invoice_number || '(none)',
      'approved=' + payment.approved,
      'airtable=' + (airtableResult.ok ? 'ok' : airtableResult.error),
      'sms=' + (studentSms.ok ? 'sent' : studentSms.error));

    sendPaymentEmail(payment, { query, body }, airtableResult, studentSms)
      .catch(err => console.error('PAYMENT EMAIL FAILED', String(err && err.message)));
    return;
  }

  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log('baseops-sfo2-api listening on ' + PORT);
  console.log('email=' + (CFG.resendKey ? 'resend' : 'MISSING') +
    ' from=' + (CFG.mailFrom || 'MISSING') +
    ' recipients=' + CFG.leadTo.length +
    ' airtable=' + (CFG.airtableToken ? 'configured' : 'MISSING'));
});
