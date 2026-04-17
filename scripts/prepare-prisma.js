const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

// Load environment variables from .env
dotenv.config();

const schemaPath = path.join(__dirname, '../prisma/schema.prisma');
let schemaContent = fs.readFileSync(schemaPath, 'utf8');

const dbUrl = process.env.DATABASE_URL || '';
// Also support the user's requested custom env var as a fallback, though auto-detect is smarter
const customProvider = process.env.DB_PROVIDER || process.env.DB_NAME;

let provider = 'postgresql'; // default

// Auto-detect from connection string or explicit env var
if (customProvider === 'sqlite' || dbUrl.startsWith('file:') || dbUrl.startsWith('sqlite:')) {
  provider = 'sqlite';
} else if (customProvider === 'mysql' || dbUrl.startsWith('mysql:')) {
  provider = 'mysql';
}

// Ensure the regex finds the provider ONLY within the datasource block
const regex = /(datasource\s+[A-Za-z0-9_]+\s*{[^}]*provider\s*=\s*")([^"]+)(")/;
const match = schemaContent.match(regex);

if (match && match[2] !== provider) {
  console.log(`\x1b[36m[Prisma Auto-Configure]\x1b[0m Switching database provider to \x1b[32m${provider}\x1b[0m...`);
  const newSchema = schemaContent.replace(regex, `$1${provider}$3`);
  
  // Save the modified schema
  fs.writeFileSync(schemaPath, newSchema, 'utf8');
  
  // Only generate prisma client when we actually made a change
  try {
    console.log(`\x1b[36m[Prisma Auto-Configure]\x1b[0m Regenerating Prisma Client for ${provider}...`);
    execSync('npx prisma generate', { stdio: 'inherit' });
    console.log(`\x1b[32m[Prisma Auto-Configure]\x1b[0m Setup complete!\n`);
  } catch (error) {
    console.error(`\n\x1b[31m[Prisma Auto-Configure] Error generating Prisma client:\x1b[0m`, error);
  }
} else {
  // Provider is already correct
  console.log(`\x1b[36m[Prisma Auto-Configure]\x1b[0m Provider is already optimized for ${provider}.`);
}
