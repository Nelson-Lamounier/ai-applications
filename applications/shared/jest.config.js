const { cjsConfig } = require('../../jest.config.base.cjs');
module.exports = {
  ...cjsConfig,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: './tsconfig.json',
      diagnostics: false,
    }],
  },
};
