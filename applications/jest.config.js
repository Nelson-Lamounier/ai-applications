/** @format */

// Fallback Jest config for workspaces under applications/ that do not define
// their own jest.config.js (Jest walks up the tree and uses this one). It
// inherits the shared base so fallback workspaces behave identically to the
// ones with an explicit config — notably the integration-test exclusion and
// clearMocks. Re-export rather than duplicate to avoid drift.
const { cjsConfig } = require('../jest.config.base.cjs');

module.exports = { ...cjsConfig };
