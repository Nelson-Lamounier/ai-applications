const { cjsConfig } = require('../../jest.config.base.cjs');
module.exports = {
  ...cjsConfig,
  testTimeout: 10000,
  verbose: true,
  collectCoverage: false,
  forceExit: true,
};
