import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    // The app module owns long-lived handles (HTTP server, UDP socket) that
    // can't all be cleaned between suites; let jest exit once tests pass.
    forceExit: true,
    // ts-jest reads tsconfig.test.json so jest types and the test root are available
    // without polluting the shipped dist build.
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    },
};

export default config;
