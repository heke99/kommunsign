const category = process.argv[2] ?? 'unknown';
console.error(`${category.toUpperCase()}_TEST_ENVIRONMENT_NOT_CONFIGURED`);
console.error('This category requires the documented browser/provider test environment. No green result was fabricated.');
process.exitCode = 2;
