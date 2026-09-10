'use strict';

// Compatibility entry for repository tools and legacy development scripts.
// The maintained implementation lives in sidecar/src and is compiled before
// tests and packaging, so removed plugin paths cannot survive in a stale copy.
module.exports = require('../sidecar/dist/desktop-core.js');
