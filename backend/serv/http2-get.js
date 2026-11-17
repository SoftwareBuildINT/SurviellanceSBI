const http2 = require('http2');

/**
 * HTTP/2 GET helper — use for APIs that reject HTTP/1.1 with 426 Upgrade Required.
 * Returns a response-shaped object { data } compatible with axios responses.
 */
function http2Get(url, { timeoutMs = 30000, rejectUnauthorized = false } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }

    const client = http2.connect(`${parsed.protocol}//${parsed.host}`, {
      rejectUnauthorized,
    });

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      err ? reject(err) : resolve(value);
    };

    client.on('error', (err) => finish(err));

    const req = client.request({
      ':method': 'GET',
      ':path': parsed.pathname + parsed.search,
      ':scheme': parsed.protocol.replace(':', ''),
      ':authority': parsed.host,
      'accept': 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });

    let statusCode = 0;
    req.on('response', (headers) => { statusCode = headers[':status']; });

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (statusCode >= 200 && statusCode < 300) {
        try { finish(null, { data: JSON.parse(body) }); }
        catch (e) { finish(new Error(`JSON parse failed (status ${statusCode}): ${e.message}`)); }
      } else {
        finish(new Error(`Request failed with status code ${statusCode}`));
      }
    });
    req.on('error', (err) => finish(err));

    const timer = setTimeout(() => finish(new Error('Request timeout')), timeoutMs);
    req.end();
  });
}

module.exports = { http2Get };
