/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS adapter for the upstream SDK. */
// Compatibility adapter: keep the CloudBase SDK's set API while using the
// maintained lodash implementation that rejects prototype-polluting paths.
const set = require('lodash/set');
module.exports = set;
module.exports.default = set;
