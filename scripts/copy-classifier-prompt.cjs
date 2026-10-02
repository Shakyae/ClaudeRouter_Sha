const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../src/classifier/prompt.md');
const destinationDirectory = path.resolve(__dirname, '../dist/classifier');

fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, path.join(destinationDirectory, 'prompt.md'));
