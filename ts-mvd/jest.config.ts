import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    // app.test.ts calls closeAppForTests() in afterAll — sessions, UDP
    // socket, SSE heartbeat and HTTP listener all release cleanly, so the
    // suite no longer needs forceExit.
    forceExit: false,
    // ts-jest reads tsconfig.test.json so jest types and the test root are available
    // without polluting the shipped dist build.
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    },
};

export default config;
