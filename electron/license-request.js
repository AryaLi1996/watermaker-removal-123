'use strict';

/**
 * The HTTP call to the license service.
 *
 * Separate from the monitor so the state machine can be tested with a stub in
 * place of a network, and so the one thing that must not be got wrong here —
 * the timeout — lives in one place.
 *
 * Every route is on the same base URL, dispatched server-side by path suffix,
 * so a Function URL and an API Gateway stage are both valid bases: `/prod`
 * plus `trial/status` still ends with the route the handler matches.
 */

const { LICENSE_CONFIG } = require('./license-config');

/**
 * A timeout that actually hangs up.
 *
 * A connection that stalls after the handshake — a captive portal, a firewall
 * dropping packets — leaves a request pending forever. Aborting the request
 * rather than merely giving up on awaiting it is what frees the socket, and
 * on the startup path it is the difference between a slow launch and a launch
 * that never finishes.
 */
function createRequest(net) {
  return function request(method, routePath, body, timeoutMs = LICENSE_CONFIG.requestTimeoutMs) {
    const base = String(LICENSE_CONFIG.verificationUrl || '').replace(/\/+$/, '');
    if (!base) {
      return Promise.reject(new Error('LICENSE_URL is not configured'));
    }

    return new Promise((resolve, reject) => {
      const req = net.request({ method, url: `${base}/${routePath}` });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.abort();
        reject(new Error(`Request to ${routePath || '/'} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk.toString(); });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('The license service returned something that is not JSON'));
          }
        });
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      if (body !== undefined) {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  };
}

module.exports = { createRequest };
