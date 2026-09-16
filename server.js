'use strict';

/* SFO2 — Railway connectivity probe
 *
 * Answers one question: can a US-region Railway service reach Paragon's API,
 * when n8n Cloud (egressing from London) could not?
 *
 * Deploy to Railway with the service region set to a US region, open the
 * public URL, and read the JSON. Delete the service once answered.
 *
 * No dependencies. Node 20+ (global fetch).
 */

const http = require('http');

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 12000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probe(name, url, options) {
  const started = Date.now();
  try {
    const res = await withTimeout(fetch(url, options || {}), TIMEOUT_MS);
    const text = await res.text();
    return {
      name,
      url,
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      body: text.slice(0, 400)
    };
  } catch (err) {
    return {
      name,
      url,
      ok: false,
      ms: Date.now() - started,
      error: err && err.message ? err.message : String(err),
      code: err && err.cause && err.cause.code ? err.cause.code : null
    };
  }
}

async function runAll() {
  const [egress, tls, paragonGet, paragonToken] = await Promise.all([
    /* Where does this service actually egress from? */
    probe('egress_ip_and_country', 'https://ifconfig.co/json'),

    /* Paragon told us they also reject anything below TLS 1.2. */
    probe('tls_version', 'https://www.howsmyssl.com/a/check'),

    /* The decisive test. This exact request returned ECONNRESET from n8n.
       A public static file — no auth, no body, nothing to get wrong. */
    probe('paragon_public_get',
      'https://stage.paragonsolutions.com/api/swagger/v2/swagger.json'),

    /* The real endpoint, with deliberately invalid credentials. From a browser
       this returns 500 "Invalid Credentials." — which is a SUCCESS here: it
       proves the request reached their application rather than being dropped
       at the edge. */
    probe('paragon_token_endpoint',
      'https://stage.paragonsolutions.com/api/v2/hp/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'probe', password: 'probe' })
      })
  ]);

  let country = null;
  let ip = null;
  try {
    const parsed = JSON.parse(egress.body || '{}');
    country = parsed.country_iso || parsed.country || null;
    ip = parsed.ip || null;
  } catch (e) {}

  let tlsVersion = null;
  try {
    tlsVersion = JSON.parse(tls.body || '{}').tls_version || null;
  } catch (e) {}

  const reachable = paragonGet.ok || paragonToken.ok;

  return {
    verdict: {
      egress_ip: ip,
      egress_country: country,
      tls_version: tlsVersion,
      paragon_reachable: reachable,
      reading: reachable
        ? 'Paragon accepts this host. Move the token mint here.'
        : 'Still blocked. If country is US, they are running an allow-list, not a geo filter — that needs Railway Pro static IPs.'
    },
    checks: [egress, tls, paragonGet, paragonToken],
    checked_at: new Date().toISOString()
  };
}

http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  try {
    const result = await runAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }, null, 2));
  }
}).listen(PORT, () => {
  console.log('SFO2 probe listening on ' + PORT);
});
