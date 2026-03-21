/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "jsdom",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  moduleNameMapper: {
    "^@services/(.*)$": "<rootDir>/src/services/$1",
    "^@components/(.*)$": "<rootDir>/src/components/$1",
    "^@panels/(.*)$": "<rootDir>/src/panels/$1",
    "^@hooks/(.*)$": "<rootDir>/src/hooks/$1",
    "^@types/(.*)$": "<rootDir>/src/types/$1",
    "^@utils/(.*)$": "<rootDir>/src/utils/$1",
    "\\.css$": "<rootDir>/tests/__mocks__/styleMock.js",
  },
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  coverageThreshold: {
    global: {
      statements: 64,
      branches: 50,
      functions: 64,
      lines: 66,
    },
  },
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/index.tsx",
    "!src/types/**",
    "!src/**/index.ts",
  ],
};
