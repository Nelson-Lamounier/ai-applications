const cjsConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: './tsconfig.json'
    }]
  },
  roots: ['<rootDir>'],
  // Integration suites (*.integration.test.ts) require live infra (RDS via
  // kubectl port-forward, real Bedrock/AWS) and are run separately via the
  // `test:integration` script / applications/jest.config.js. Exclude them
  // from the default unit-test run so it stays green without infra.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/cdk\\.out/', '\\.integration\\.test\\.ts$'],
  clearMocks: true,
};

module.exports = { cjsConfig };
