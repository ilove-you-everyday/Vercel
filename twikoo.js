'use strict';

// Keep the official Twikoo Vercel adapter as the request handler.
// twikoo-vercel 2.0.1+ exports the handler function directly; the fallback keeps the
// entry working if a future build exposes it as `.default` instead.
const adapter = require('twikoo-vercel');
module.exports = typeof adapter === 'function' ? adapter : adapter.default;
