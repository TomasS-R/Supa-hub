import { promises as fs } from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createHmac } from 'crypto'
import { prisma } from './db'
import { findAvailablePorts, getUsedPortsFromDatabase } from './port-utils'


const execAsync = promisify(exec)

// Helper functions for generating secure defaults
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function generateJWT(role: 'anon' | 'service_role', secret: string, timestamp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    role,
    iss: 'supabase',
    iat: Math.floor(timestamp / 1000),
    exp: Math.floor(timestamp / 1000) + (365 * 24 * 60 * 60) // 1 year
  })).toString('base64url')

  // Generate proper HMAC-SHA256 signature
  const signatureInput = `${header}.${payload}`
  const signature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64url')

  return `${header}.${payload}.${signature}`
}

// Pre-flight checks for Docker deployment
async function checkDockerPrerequisites() {
  const checks = {
    docker: false,
    dockerCompose: false,
    internetConnection: false,
  }

  try {
    await execAsync('docker --version')
    checks.docker = true
  } catch {
    // Docker not available
  }

  try {
    await execAsync('docker compose version')
    checks.dockerCompose = true
  } catch {
    // Docker Compose not available
  }

  // Multi-layered internet connectivity check
  checks.internetConnection = await checkInternetConnectivity()

  return checks
}

// Improved internet connectivity check using multiple methods
async function checkInternetConnectivity(): Promise<boolean> {
  // Method 1: HTTP connectivity test to multiple reliable endpoints
  const httpEndpoints = [
    'https://www.google.com',
    'https://1.1.1.1', // Cloudflare DNS
    'https://8.8.8.8', // Google DNS
  ]

  for (const endpoint of httpEndpoints) {
    try {
      // Use curl for HTTP connectivity test with short timeout
      await execAsync(`curl -s --max-time 10 --head ${endpoint}`, { timeout: 15000 })
      return true // If any endpoint succeeds, we have internet
    } catch {
      // Try next endpoint
      continue
    }
  }

  // Method 2: DNS resolution test
  try {
    await execAsync('nslookup google.com', { timeout: 10000 })
    return true
  } catch {
    // DNS resolution failed
  }

  // Method 3: Ping test (as fallback)
  try {
    const pingCommand = process.platform === 'win32'
      ? 'ping -n 1 8.8.8.8'
      : 'ping -c 1 8.8.8.8'
    await execAsync(pingCommand, { timeout: 10000 })
    return true
  } catch {
    // Ping failed
  }

  // Method 4: Docker registry connectivity (original method as last resort)
  try {
    await execAsync('docker pull alpine:latest', {
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for Docker pull
    })
    return true
  } catch {
    // All methods failed
  }

  return false
}

export async function initializeSupabaseCore() {
  const coreDir = path.join(process.cwd(), 'supabase-core')
  const projectsDir = path.join(process.cwd(), 'supabase-projects')

  try {
    const coreDockerDir = path.join(coreDir, 'docker')
    const isCoreValid = await fs.access(coreDockerDir).then(() => true).catch(() => false)

    if (!isCoreValid) {
      // Remove any partial or invalid clone
      await fs.rm(coreDir, { recursive: true, force: true }).catch(() => {})
      
      // Pinned to a verified stable tag
      const SUPABASE_PINNED_VERSION = process.env.SUPABASE_VERSION || 'v1.24.09'
      const repoUrl = process.env.SUPABASE_CORE_REPO_URL || 'https://github.com/supabase/supabase'

      console.log(`Cloning Supabase repository (tag: ${SUPABASE_PINNED_VERSION})...`);
      await execAsync(
        `git clone --depth 1 --single-branch --branch ${SUPABASE_PINNED_VERSION} ${repoUrl} "${coreDir}"`,
        { timeout: 120000, maxBuffer: 1024 * 1024 * 10 }
      );
    }

    await fs.mkdir(projectsDir, { recursive: true })

    return { success: true }
  } catch (error) {
    console.error('Failed to initialize Supabase core:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

function pruneDockerCompose(content: string, disabledModules: string[]): string {
  if (!disabledModules || disabledModules.length === 0) return content;

  // Map frontend module names to docker-compose service names
  const modulesToSkip = disabledModules.map(m => m === 'edge-functions' ? 'functions' : m);
  
  // Make sure vector is removed if analytics is removed
  if (modulesToSkip.includes('analytics') && !modulesToSkip.includes('vector')) {
    modulesToSkip.push('vector');
  }

  const lines = content.split('\n');

  // ── Pass 1: Remove disabled service blocks ──────────────────────────
  const prunedLines: string[] = [];
  let skippingService = false;

  for (const line of lines) {
    // Top-level key (e.g. "services:", "volumes:") — always keep, resets skip
    if (line.match(/^[a-zA-Z0-9_-]+: *\r?$/)) {
      skippingService = false;
      prunedLines.push(line);
      continue;
    }

    // Service-level key (2-space indent, e.g. "  studio:")
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+): *\r?$/);
    if (serviceMatch) {
      skippingService = modulesToSkip.includes(serviceMatch[1]);
    }

    if (!skippingService) {
      prunedLines.push(line);
    }
  }

  // ── Pass 2: Cure orphan dependencies & environment variables ────────
  const finalLines: (string | null)[] = [];
  let inDependsOn = false;
  let dependsOnHeaderIndex = -1;
  let dependsOnChildCount = 0;
  // Track existing dep names in the current depends_on block to prevent duplicate keys
  let existingDeps: Set<string> = new Set();

  for (let i = 0; i < prunedLines.length; i++) {
    let line = prunedLines[i];
    const indent = (line.match(/^( *)/) || ['', ''])[1].length;

    // Detect end of depends_on block (indent drops to 4 or less on a non-empty line)
    if (inDependsOn && indent <= 4 && line.trim() !== '') {
      inDependsOn = false;
      // If depends_on ended up empty, remove its header line
      if (dependsOnChildCount === 0 && dependsOnHeaderIndex >= 0) {
        finalLines[dependsOnHeaderIndex] = null;
      }
      existingDeps = new Set();
    }

    // Detect start of depends_on
    if (line.match(/^ {4}depends_on: *\r?$/)) {
      inDependsOn = true;
      dependsOnHeaderIndex = finalLines.length;
      dependsOnChildCount = 0;
      existingDeps = new Set();
      finalLines.push(line);
      continue;
    }

    // Inside depends_on: process dependency entries (6-space indent)
    if (inDependsOn) {
      const depMatch = line.match(/^ {6}([a-zA-Z0-9_-]+): *\r?$/);
      if (depMatch) {
        const depName = depMatch[1];

        if (modulesToSkip.includes(depName)) {
          // Skip this dependency + its condition/comment lines
          while (i + 1 < prunedLines.length) {
            const nextIndent = (prunedLines[i + 1].match(/^( *)/) || ['', ''])[1].length;
            const nextTrimmed = prunedLines[i + 1].trim();
            // Lines at 8+ spaces that are children of this dep (condition:, comments)
            if (nextIndent >= 8 || nextTrimmed.startsWith('#')) {
              i++;
            } else {
              break;
            }
          }

          // If we removed analytics, inject db as fallback ONLY if not already present
          if (depName === 'analytics' && !existingDeps.has('db')) {
            finalLines.push('      db:');
            finalLines.push('        condition: service_healthy');
            existingDeps.add('db');
            dependsOnChildCount++;
          }
          continue;
        }

        // Track this dep as existing
        existingDeps.add(depName);
        dependsOnChildCount++;
      }
    }

    // ── Environment variable curing ───────────────────────────────────
    if (modulesToSkip.includes('analytics')) {
      // Disable logs — handle both quoted and unquoted values
      if (line.match(/NEXT_PUBLIC_ENABLE_LOGS:\s*/)) {
        line = line.replace(/NEXT_PUBLIC_ENABLE_LOGS:\s*.*/, 'NEXT_PUBLIC_ENABLE_LOGS: "false"');
      }
      // Remove all LOGFLARE-related variables
      if (line.match(/^\s*(LOGFLARE_URL|LOGFLARE_API_KEY|LOGFLARE_PUBLIC_ACCESS_TOKEN|LOGFLARE_PRIVATE_ACCESS_TOKEN|NEXT_ANALYTICS_BACKEND_PROVIDER):/)) continue;
    }

    if (modulesToSkip.includes('imgproxy')) {
      if (line.match(/ENABLE_IMAGE_TRANSFORMATION:\s*/)) {
        line = line.replace(/ENABLE_IMAGE_TRANSFORMATION:\s*.*/, 'ENABLE_IMAGE_TRANSFORMATION: "false"');
      }
      if (line.match(/^\s*IMGPROXY_URL:/)) continue;
    }

    // ── Global volume cleanup ─────────────────────────────────────────
    // Dynamically remove any named volume that belongs to a disabled service
    if (modulesToSkip.includes('functions')) {
      if (line.match(/^ {2}deno-cache/)) continue;
    }

    finalLines.push(line);
  }

  return finalLines.filter(l => l !== null).join('\n');
}

export async function createProject(name: string, userId: string, description?: string, disabledModules: string[] = []) {
  try {
    // Generate unique slug
    const timestamp = Date.now()
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${timestamp}`

    // Create project in database
    const project = await prisma.project.create({
      data: {
        name,
        slug,
        description,
        ownerId: userId,
      },
    })

    // Create project directory
    const projectDir = path.join(process.cwd(), 'supabase-projects', slug)
    const coreDockerDir = path.join(process.cwd(), 'supabase-core', 'docker')

    // Copy docker folder from supabase-core
    await fs.mkdir(projectDir, { recursive: true })

    // Ensure supabase-core exists before copying (fallback in case it wasn't initialized)
    const coreDockerExists = await fs.access(coreDockerDir).then(() => true).catch(() => false)
    if (!coreDockerExists) {
      console.log('supabase-core/docker missing during project creation. Running initialization fallback...')
      const initResult = await initializeSupabaseCore()
      if (!initResult.success) {
        throw new Error(`Failed to initialize Supabase core before creation: ${initResult.error}`)
      }
    }

    // Use cross-platform copy command
    const isWindows = process.platform === 'win32'
    const copyCommand = isWindows
      ? `xcopy "${coreDockerDir}" "${path.join(projectDir, 'docker')}" /E /I /H /K`
      : `cp -r "${coreDockerDir}" "${projectDir}/"`

    await execAsync(copyCommand)

    // Fix line endings in pooler.exs file (convert CRLF to LF for Elixir compatibility)
    const poolerExsPath = path.join(projectDir, 'docker', 'volumes', 'pooler', 'pooler.exs')
    try {
      const poolerContent = await fs.readFile(poolerExsPath, 'utf8')
      const fixedContent = poolerContent.replace(/\r\n/g, '\n')
      await fs.writeFile(poolerExsPath, fixedContent, 'utf8')
      console.log('Fixed line endings in pooler.exs')
    } catch (poolerError) {
      console.warn('Could not fix pooler.exs line endings:', poolerError)
    }

    // Fix line endings in kong-entrypoint.sh (convert CRLF to LF for bash/sh compatibility)
    const kongScriptPath = path.join(projectDir, 'docker', 'volumes', 'api', 'kong-entrypoint.sh')
    try {
      const kongContent = await fs.readFile(kongScriptPath, 'utf8')
      const fixedKongContent = kongContent.replace(/\r\n/g, '\n')
      await fs.writeFile(kongScriptPath, fixedKongContent, 'utf8')
      console.log('Fixed line endings in kong-entrypoint.sh')
    } catch (kongError) {
      console.warn('Could not fix kong-entrypoint.sh line endings:', kongError)
    }

    // Customize docker-compose.yml with unique container names and project-specific settings
    const dockerComposeFile = path.join(projectDir, 'docker', 'docker-compose.yml')
    let dockerComposeContent = await fs.readFile(dockerComposeFile, 'utf8')
    
    // Execute Pruning engine BEFORE any other modifications!
    if (disabledModules && disabledModules.length > 0) {
      console.log(`Pruning docker-compose with modules: ${disabledModules.join(', ')}`)
      dockerComposeContent = pruneDockerCompose(dockerComposeContent, disabledModules)
    }

    // Define container mappings for unique names
    const containerMappings = [
      { original: 'supabase-studio', replacement: `${slug}-studio` },
      { original: 'supabase-kong', replacement: `${slug}-kong` },
      { original: 'supabase-auth', replacement: `${slug}-auth` },
      { original: 'supabase-rest', replacement: `${slug}-rest` },
      { original: 'realtime-dev.supabase-realtime', replacement: `realtime-dev.${slug}-realtime` },
      { original: 'supabase-storage', replacement: `${slug}-storage` },
      { original: 'supabase-imgproxy', replacement: `${slug}-imgproxy` },
      { original: 'supabase-meta', replacement: `${slug}-meta` },
      { original: 'supabase-edge-functions', replacement: `${slug}-edge-functions` },
      { original: 'supabase-analytics', replacement: `${slug}-analytics` },
      { original: 'supabase-db', replacement: `${slug}-db` },
      { original: 'supabase-vector', replacement: `${slug}-vector` },
      { original: 'supabase-pooler', replacement: `${slug}-pooler` }
    ]

    // Find available ports dynamically to prevent conflicts
    console.log('Finding available ports for Supabase services...')

    // First, get ports that are already assigned to other SupaConsole projects
    const reservedPorts = await getUsedPortsFromDatabase()
    console.log('Reserved ports from database:', Array.from(reservedPorts))

    const portRequests = [
      { name: 'KONG_HTTP_PORT', startPort: 8000 },
      { name: 'KONG_HTTPS_PORT', startPort: 8443 },
      { name: 'POSTGRES_PORT', startPort: 54320 },
      { name: 'POOLER_PROXY_PORT_TRANSACTION', startPort: 54321 },
    ]
    if (!disabledModules.includes('studio')) {
      portRequests.push({ name: 'STUDIO_PORT', startPort: 3000 })
    }
    if (!disabledModules.includes('analytics')) {
      portRequests.push({ name: 'ANALYTICS_PORT', startPort: 4000 })
    }

    // Then find available ports, avoiding both system-used and database-reserved ports
    const availablePorts = await findAvailablePorts(portRequests, reservedPorts)

    console.log('Assigned ports:', availablePorts)

    // Generate JWT_SECRET first so we can use it to sign the tokens
    const jwtSecret = generateRandomString(64)

    // Securely parse the APP_URL to avoid generating invalid URLs like http://localhost:3000:8000
    const appUrlStr = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost'
    let baseHostname = 'localhost'
    let baseProtocol = 'http'
    try {
      const urlObj = new URL(appUrlStr)
      baseHostname = urlObj.hostname
      baseProtocol = urlObj.protocol.replace(':', '')
    } catch {
      // ignore
    }
    const safePublicUrl = `${baseProtocol}://${baseHostname}:${availablePorts.KONG_HTTP_PORT}`

    const defaultEnvVars = {
      // Secrets - generated random values
      POSTGRES_PASSWORD: generateRandomString(32),
      JWT_SECRET: jwtSecret,
      ANON_KEY: generateJWT('anon', jwtSecret, timestamp),
      SERVICE_ROLE_KEY: generateJWT('service_role', jwtSecret, timestamp),
      DASHBOARD_USERNAME: 'supabase',
      DASHBOARD_PASSWORD: generateRandomString(16),
      SECRET_KEY_BASE: generateRandomString(64),
      VAULT_ENC_KEY: generateRandomString(32),
      PG_META_CRYPTO_KEY: generateRandomString(32),

      // Dynamically assigned available ports
      POSTGRES_PORT: availablePorts.POSTGRES_PORT.toString(),
      POOLER_PROXY_PORT_TRANSACTION: availablePorts.POOLER_PROXY_PORT_TRANSACTION.toString(),
      KONG_HTTP_PORT: availablePorts.KONG_HTTP_PORT.toString(),
      KONG_HTTPS_PORT: availablePorts.KONG_HTTPS_PORT.toString(),
      
      // Dynamic ports depending on pruning status
      ...(!disabledModules.includes('analytics') ? {
        ANALYTICS_PORT: availablePorts.ANALYTICS_PORT.toString(),
        // Generate both old-style (LOGFLARE_API_KEY) and new-style tokens for version compatibility
        LOGFLARE_API_KEY: generateRandomString(64),
        LOGFLARE_PUBLIC_ACCESS_TOKEN: generateRandomString(64),
        LOGFLARE_PRIVATE_ACCESS_TOKEN: generateRandomString(64),
      } : {}),
      ...(!disabledModules.includes('studio') ? {
        STUDIO_PORT: availablePorts.STUDIO_PORT.toString(),
      } : {}),
      ...(!disabledModules.includes('imgproxy') ? {
        IMGPROXY_AUTO_WEBP: 'true',
      } : {}),

      // Database
      POSTGRES_HOST: 'db',
      POSTGRES_DB: 'postgres',
      POSTGRES_USER: 'supabase_admin',

      // Other defaults
      POOLER_DEFAULT_POOL_SIZE: '20',
      POOLER_MAX_CLIENT_CONN: '100',
      POOLER_TENANT_ID: `project-${timestamp}`,
      POOLER_DB_POOL_SIZE: '5',
      PGRST_DB_SCHEMAS: 'public,storage,graphql_public',
      SITE_URL: safePublicUrl,
      ADDITIONAL_REDIRECT_URLS: '',
      JWT_EXPIRY: '3600',
      DISABLE_SIGNUP: 'false',
      API_EXTERNAL_URL: safePublicUrl,
      MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
      MAILER_URLPATHS_INVITE: '/auth/v1/verify',
      MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
      MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
      ENABLE_EMAIL_SIGNUP: 'true',
      ENABLE_EMAIL_AUTOCONFIRM: 'false',
      SMTP_ADMIN_EMAIL: 'admin@example.com',
      SMTP_HOST: 'supabase-mail',
      SMTP_PORT: '2500',
      SMTP_USER: 'fake_mail_user',
      SMTP_PASS: 'fake_mail_password',
      SMTP_SENDER_NAME: 'fake_sender',
      ENABLE_ANONYMOUS_USERS: 'false',
      ENABLE_PHONE_SIGNUP: 'true',
      ENABLE_PHONE_AUTOCONFIRM: 'true',
      STUDIO_DEFAULT_ORGANIZATION: 'Default Organization',
      STUDIO_DEFAULT_PROJECT: 'Default Project',
      STUDIO_PORT: availablePorts.STUDIO_PORT ? availablePorts.STUDIO_PORT.toString() : '3000',
      SUPABASE_PUBLIC_URL: safePublicUrl,
      IMGPROXY_ENABLE_WEBP_DETECTION: 'true',
      OPENAI_API_KEY: '',
      FUNCTIONS_VERIFY_JWT: 'false',
      DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
      GOOGLE_PROJECT_ID: 'GOOGLE_PROJECT_ID',
      GOOGLE_PROJECT_NUMBER: 'GOOGLE_PROJECT_NUMBER',
      GLOBAL_S3_BUCKET: 'stub',
      S3_PROTOCOL_ACCESS_KEY_ID: generateRandomString(32),
      S3_PROTOCOL_ACCESS_KEY_SECRET: generateRandomString(64),
      REGION: 'stub',
      STORAGE_TENANT_ID: 'stub',
    }

    // Write initial .env file with unique defaults
    const envFilePath = path.join(projectDir, 'docker', '.env')
    const envContent = Object.entries(defaultEnvVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')

    await fs.writeFile(envFilePath, envContent)

    // Generate PostgreSQL initialization script with correct passwords
    console.log('Generating PostgreSQL initialization script...')
    const initScriptTemplatePath = path.join(process.cwd(), 'src', 'templates', 'init-db.sql.template')
    const initScriptTemplate = await fs.readFile(initScriptTemplatePath, 'utf8')
    const initScript = initScriptTemplate.replace(
      /{{POSTGRES_PASSWORD}}/g,
      defaultEnvVars.POSTGRES_PASSWORD
    )
    const initScriptPath = path.join(projectDir, 'docker', 'init-db.sql')
    await fs.writeFile(initScriptPath, initScript)
    console.log('Init script created at:', initScriptPath)

    // Modify docker-compose.yml with a safer line-by-line approach
    console.log('Configuring Docker Compose services...')
    const lines = dockerComposeContent.split('\n')
    const updatedLines: string[] = []
    let currentService: string | null = null
    let inVolumes = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match service definition (e.g., "  db:")
      const serviceMatch = line.match(/^  ([a-z_]+):/)
      if (serviceMatch) {
        currentService = serviceMatch[1]
        inVolumes = false
      }

      let updatedLine = line

      // 1. Replace container names if this line contains one
      for (const mapping of containerMappings) {
        if (line.includes(`container_name: ${mapping.original}`)) {
          updatedLine = line.replace(`container_name: ${mapping.original}`, `container_name: ${mapping.replacement}`)
        }
      }

      // 2. Update healthcheck retries to give massive patience to heavy containers (especially db on a VPS)
      if (line.includes('retries: 10')) {
        updatedLine = line.replace('retries: 10', 'retries: 120') // Give ~10 mins to start 
      }
      if (line.includes('retries: 3')) {
        updatedLine = line.replace('retries: 3', 'retries: 60')
      }

      // 2b. Crucial fix for Linux VPS where localhost resolves to ::1 (IPv6)
      if (line.includes('"localhost"')) {
        updatedLine = line.replace('"localhost"', '"127.0.0.1"')
      }

      // 3. Update the compose project name to be unique
      if (line.startsWith('name: supabase')) {
        updatedLine = `name: ${slug}`
      }

      // 3. Replace hardcoded analytics port with variable
      if (line.trim() === '- 4000:4000') {
        updatedLine = line.replace('- 4000:4000', `- \${ANALYTICS_PORT}:4000`)
      }

      // 4. Mount init script in DB service
      if (currentService === 'db') {
        if (line.trim() === 'volumes:') {
          inVolumes = true
        } else if (inVolumes && (line.match(/^    [a-z_]+:/) || (line.trim() === '' && i + 1 < lines.length && !lines[i + 1].trim().startsWith('-')))) {
          // We reached the end of volumes section (next key or empty line)
          updatedLines.push('      - ./init-db.sql:/docker-entrypoint-initdb.d/migrations/999-supaconsole-init.sql:ro')
          inVolumes = false
        }
      }

      updatedLines.push(updatedLine)
    }

    // Add dokploy-network to networks section if not present
    const hasNetworks = updatedLines.some(l => l.trim() === 'networks:')
    if (!hasNetworks) {
      updatedLines.push('')
      updatedLines.push('networks:')
      updatedLines.push('  dokploy-network:')
      updatedLines.push('    external: true')
    }

    // Add dokploy-network to each service that doesn't have networks defined
    const finalLines3: string[] = []
    for (let i = 0; i < updatedLines.length; i++) {
      const line = updatedLines[i]
      finalLines3.push(line)
      
      // If this is a service definition, check if it has networks and add if missing
      const serviceDef = line.match(/^  ([a-z_]+):/)
      if (serviceDef && !['networks', 'version', 'name'].includes(serviceDef[1])) {
        // Look ahead to see if this service has networks defined
        let hasServiceNetworks = false
        for (let j = i + 1; j < Math.min(i + 50, updatedLines.length); j++) {
          const nextLine = updatedLines[j]
          if (nextLine.match(/^  [a-z_]+:/) && nextLine !== line) break
          if (nextLine.includes('networks:')) {
            hasServiceNetworks = true
            break
          }
        }
        if (!hasServiceNetworks) {
          // Add networks at the end of this service block
          let insertAt = finalLines3.length
          for (let j = i + 1; j < updatedLines.length; j++) {
            if (updatedLines[j].match(/^  [a-z_]+:/) && !updatedLines[j].includes('name:')) {
              insertAt = finalLines3.length
              // Back up to last non-empty line
              while (insertAt > 0 && finalLines3[insertAt - 1].trim() === '') {
                insertAt--
              }
              insertAt++
              break
            }
            if (j === updatedLines.length - 1) {
              insertAt = finalLines3.length
            }
          }
          finalLines3.splice(insertAt, 0, '    networks:', '      - dokploy-network')
        }
      }
    }

    await fs.writeFile(dockerComposeFile, finalLines3.join('\n'))
    console.log('Docker Compose configuration updated safely')

    // Save environment variables to database
    for (const [key, value] of Object.entries(defaultEnvVars)) {
      await prisma.projectEnvVar.create({
        data: {
          projectId: project.id,
          key,
          value,
        },
      })
    }

    if (disabledModules && disabledModules.length > 0) {
      await prisma.projectEnvVar.create({
        data: {
          projectId: project.id,
          key: 'DISABLED_MODULES',
          value: disabledModules.join(','),
        },
      })
    }

    return { success: true, project }
  } catch (error) {
    console.error('Failed to create project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function updateProjectEnvVars(projectId: string, envVars: Record<string, string>) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    // Update environment variables in database
    for (const [key, value] of Object.entries(envVars)) {
      await prisma.projectEnvVar.upsert({
        where: {
          projectId_key: {
            projectId,
            key,
          },
        },
        update: { value },
        create: {
          projectId,
          key,
          value,
        },
      })
    }

    // Update .env file in project directory
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    const envFilePath = path.join(projectDir, '.env')

    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')

    await fs.writeFile(envFilePath, envContent)

    return { success: true }
  } catch (error) {
    console.error('Failed to update project env vars:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function getProjectStatus(slug: string) {
  try {
    const projectDir = path.join(process.cwd(), 'supabase-projects', slug, 'docker')
    
    const dockerExists = await fs.access(projectDir)
      .then(() => true)
      .catch(() => false)

    if (!dockerExists) {
      return { status: 'not_found', containers: [] }
    }

    const { stdout } = await execAsync('docker compose ps --format json', {
      cwd: projectDir,
      maxBuffer: 1024 * 1024 * 2
    })

    const lines = stdout.trim().split('\n').filter(Boolean)
    if (lines.length === 0) {
      return { status: 'not_found', containers: [] }
    }

    const containers = JSON.parse(`[${lines.join(',')}]`)
    
    if (!Array.isArray(containers) || containers.length === 0) {
      return { status: 'not_found', containers: [] }
    }

    const containerInfo = containers.map((c: any) => ({
      name: c.Name || c.name || 'unknown',
      state: (c.State || c.state || '').toLowerCase(),
      health: (c.Health || c.health || null),
      ports: (c.Ports || c.ports || ''),
      localStatus: (c.State || c.state || '').toLowerCase()
    }))

    const runningCount = containerInfo.filter((c: any) => 
      c.localStatus === 'running'
    ).length
    const pausedCount = containerInfo.filter((c: any) => 
      c.localStatus === 'exited' || c.localStatus === 'stopped' || c.localStatus === 'paused'
    ).length
    const errorCount = containerInfo.filter((c: any) => 
      c.localStatus === 'unhealthy' || c.localStatus === 'restarting' || c.localStatus === 'dead' || c.localStatus === 'crashed'
    ).length

    let realStatus = 'active'
    if (errorCount > 0) {
      realStatus = 'error'
    } else if (runningCount === containerInfo.length) {
      realStatus = 'active'
    } else if (runningCount > 0) {
      realStatus = 'partially_running'
    } else if (pausedCount === containerInfo.length) {
      realStatus = 'paused'
    } else if (containerInfo.every((c: any) => c.localStatus === 'created')) {
      realStatus = 'created'
    }

    return { status: realStatus, containers: containerInfo }
  } catch {
    return { status: 'not_found', containers: [] }
  }
}

export async function deployProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')

    // Run pre-flight checks
    console.log('Running pre-flight checks...')
    const checks = await checkDockerPrerequisites()

    if (!checks.docker) {
      throw new Error('Docker is not installed or not running. Please install Docker Desktop and ensure it is started before deploying.')
    }

    if (!checks.dockerCompose) {
      throw new Error('Docker Compose is not available. Please ensure Docker Desktop includes Docker Compose or install it separately.')
    }

    // Try to run Docker commands with better error handling
    try {
      // Only pull images if we have internet connectivity
      if (checks.internetConnection) {
        console.log('Attempting to pull latest Docker images...')
        try {
          await execAsync('docker compose pull', {
            cwd: projectDir,
            timeout: 300000, // 5 minute timeout
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
          })
        } catch (pullError) {
          console.warn('Failed to pull some images, will try to use existing/cached images:', pullError)
          // Continue with deployment even if pull fails
        }
      } else {
        console.warn('No internet connectivity detected, using cached Docker images')
      }

      // Start the services
      console.log('Starting Supabase services...')
      await execAsync('docker compose up -d --remove-orphans', {
        cwd: projectDir,
        timeout: 300000, // 5 minute timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      })

    } catch (composeError) {
      // If the main docker compose command fails, provide better error message
      let errorMessage = composeError instanceof Error ? composeError.message : 'Unknown Docker error'

      // Attempt to fetch container logs to see why they failed
      try {
        const { stdout: containerLogs } = await execAsync('docker compose logs --tail=50 db analytics', { cwd: projectDir })
        if (containerLogs) {
          errorMessage += `\n\n--- Container Failing Logs ---\n${containerLogs}`
        }
      } catch {
        // Ignore errors fetching logs
      }

      if (errorMessage.includes('maxBuffer length exceeded')) {
        throw new Error('Docker deployment generated too much output. This usually means the deployment is working but Docker is downloading many large images. Please wait a few more minutes and check Docker Desktop or Server.')
      } else if (errorMessage.includes('no such host') || errorMessage.includes('dial tcp')) {
        throw new Error(`Network connectivity issue: Unable to reach Docker registry.\n${errorMessage}`)
      } else if (errorMessage.includes('permission denied')) {
        throw new Error(`Docker permission denied. Please ensure your environment has privileges.\n${errorMessage}`)
      } else if (errorMessage.includes('address already in use') || errorMessage.includes('port is already allocated') || errorMessage.includes('Ports are not available')) {
        throw new Error(`Uno o más puertos asignados ya están en uso por otra aplicación. Por favor, elige otros puertos en la configuración e intenta nuevamente.\n${errorMessage}`)
      } else if (errorMessage.includes('dependency failed to start')) {
        throw new Error(`A critical Supabase container crashed during startup (likely Out of Memory on a VPS, or a configuration error). Check if your server has at least 4GB of RAM.\n${errorMessage}`)
      } else {
        throw new Error(`Docker deployment failed: ${errorMessage}`)
      }
    }

    // Verify that containers are running
    try {
      const { stdout } = await execAsync('docker compose ps --format json', {
        cwd: projectDir,
        maxBuffer: 1024 * 1024 * 2 // 2MB buffer for container status
      })
      const containers = JSON.parse(`[${stdout.trim().split('\n').join(',')}]`)
      const runningContainers = containers.filter((c: { State: string }) => c.State === 'running')
      console.log(`Deployment successful: ${runningContainers.length} containers running`)
    } catch {
      console.warn('Could not verify container status, but deployment may have succeeded')
    }

    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'active' },
    })

    // Connect SupaConsole to the project's Docker network
    try {
      const networkName = `${project.slug}_default`
      const containerName = 'supaconsole-app'
      
      try {
        await execAsync(`docker network inspect ${networkName}`, { timeout: 5000 })
        
        try {
          const { stdout } = await execAsync(
            `docker network inspect ${networkName} --format '{{range $key, $val := .Containers}}{{$key}} {{end}}'`,
            { timeout: 5000 }
          )
          
          if (!stdout.includes(containerName)) {
            console.log(`Connecting SupaConsole to network ${networkName}...`)
            try {
              await execAsync(`docker network connect ${networkName} ${containerName}`, { timeout: 10000 })
              console.log(`Connected to network ${networkName}`)
            } catch {}
          }
        } catch {}
      } catch {}
    } catch {}

    return { success: true }
  } catch (error) {
    console.error('Failed to deploy project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function pauseProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')

    // Stop Docker containers
    await execAsync('docker compose stop', { cwd: projectDir })

    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'paused' },
    })

    return { success: true }
  } catch (error) {
    console.error('Failed to pause project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deleteProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug)
    const dockerDir = path.join(projectDir, 'docker')

    // Step 1: Stop and remove Docker containers
    try {
      console.log(`Stopping Docker containers for project ${project.slug}...`)
      await execAsync('docker compose down --volumes --remove-orphans', {
        cwd: dockerDir,
        timeout: 120000, // 2 minutes timeout
        maxBuffer: 1024 * 1024 * 5 // 5MB buffer
      })
    } catch (dockerError) {
      console.warn('Failed to stop Docker containers (they may not be running):', dockerError)
      // Continue with deletion even if Docker cleanup fails
    }

    // Step 2: Remove project directory
    try {
      console.log(`Removing project directory: ${projectDir}`)
      const isWindows = process.platform === 'win32'
      const removeCommand = isWindows
        ? `rmdir /s /q "${projectDir}"`
        : `rm -rf "${projectDir}"`

      await execAsync(removeCommand, { timeout: 60000 })
    } catch (fsError) {
      console.warn('Failed to remove project directory:', fsError)
      // Continue with database cleanup even if filesystem cleanup fails
    }

    // Step 3: Clean up database records
    try {
      // Delete project environment variables
      await prisma.projectEnvVar.deleteMany({
        where: { projectId },
      })

      // Delete the project itself
      await prisma.project.delete({
        where: { id: projectId },
      })
    } catch (dbError) {
      console.error('Failed to clean up database records:', dbError)
      throw new Error('Failed to remove project from database')
    }

    console.log(`Project ${project.slug} deleted successfully`)
    return { success: true }
  } catch (error) {
    console.error('Failed to delete project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function restoreProject(projectId: string, forceNewPorts: boolean = false, customPorts: Record<string, number> | null = null) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    const coreDockerDir = path.join(process.cwd(), 'supabase-core', 'docker')

    // Verify Docker is running
    const dockerCheck = await checkDockerPrerequisites()
    if (!dockerCheck.docker || !dockerCheck.dockerCompose) {
      throw new Error('Docker is not running. Please start Docker Desktop and try again.')
    }

    console.log(`Restoring project ${project.name}...`)

    // Step 1: Aggressively stop and remove all containers and networks
    console.log('Stopping and removing existing containers...')
    try {
      await execAsync('docker compose down --remove-orphans --volumes --rmi local', { 
        cwd: projectDir, 
        timeout: 180000 
      })
      console.log('Existing containers removed')
    } catch {
      console.log('Trying alternative cleanup...')
      try {
        await execAsync('docker stop $(docker ps -q --filter "name=' + project.slug + '")', { 
          timeout: 60000 
        })
        await execAsync('docker rm $(docker ps -aq --filter "name=' + project.slug + '")', { 
          timeout: 60000 
        })
      } catch {
        console.log('No containers to stop')
      }
    }

    // Wait for ports to be released
    console.log('Waiting for ports to be released...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Step 2: Get environment variables from database
    const envVars = await prisma.projectEnvVar.findMany({
      where: { projectId },
    })
    const envVarsMap: Record<string, string> = {}
    envVars.forEach(ev => {
      envVarsMap[ev.key] = ev.value
    })

    // Step 3: Determine port configuration
    let portsChanged = false
    if (customPorts) {
      // Only update PostgreSQL and Pooler ports, keep others from database
      console.log('Using custom ports:', customPorts)
      
      envVarsMap['POSTGRES_PORT'] = customPorts.POSTGRES_PORT.toString()
      envVarsMap['POOLER_PROXY_PORT_TRANSACTION'] = customPorts.POOLER_PROXY_PORT_TRANSACTION.toString()
      portsChanged = true
    } else if (forceNewPorts) {
      // Find new available ports
      console.log('Finding new available ports...')
      const reservedPorts = await getUsedPortsFromDatabase()
      
      const availablePorts = await findAvailablePorts([
        { name: 'KONG_HTTP_PORT', startPort: 20000 },
        { name: 'KONG_HTTPS_PORT', startPort: 20001 },
        { name: 'STUDIO_PORT', startPort: 20002 },
        { name: 'ANALYTICS_PORT', startPort: 20003 },
        { name: 'POSTGRES_PORT', startPort: 60000 },
        { name: 'POOLER_PROXY_PORT_TRANSACTION', startPort: 60001 },
      ], reservedPorts)

      envVarsMap['KONG_HTTP_PORT'] = availablePorts.KONG_HTTP_PORT.toString()
      envVarsMap['KONG_HTTPS_PORT'] = availablePorts.KONG_HTTPS_PORT.toString()
      envVarsMap['STUDIO_PORT'] = availablePorts.STUDIO_PORT.toString()
      envVarsMap['ANALYTICS_PORT'] = availablePorts.ANALYTICS_PORT.toString()
      envVarsMap['POSTGRES_PORT'] = availablePorts.POSTGRES_PORT.toString()
      envVarsMap['POOLER_PROXY_PORT_TRANSACTION'] = availablePorts.POOLER_PROXY_PORT_TRANSACTION.toString()
      envVarsMap['SUPABASE_PUBLIC_URL'] = `http://localhost:${availablePorts.KONG_HTTP_PORT}`
      envVarsMap['API_EXTERNAL_URL'] = `http://localhost:${availablePorts.KONG_HTTP_PORT}`
      envVarsMap['SITE_URL'] = `http://localhost:${availablePorts.KONG_HTTP_PORT}`
      portsChanged = true
    }

    // Step 4: Copy fresh docker-compose.yml from supabase-core
    const coreDockerComposePath = path.join(coreDockerDir, 'docker-compose.yml')
    const projectDockerComposePath = path.join(projectDir, 'docker-compose.yml')

    let dockerComposeContent = await fs.readFile(coreDockerComposePath, 'utf8')

    // Update compose project name
    dockerComposeContent = dockerComposeContent.replace(/^name: supabase/m, `name: ${project.slug}`)

    // Update container names with project slug
    const containerMappings = [
      { original: 'supabase-studio', replacement: `${project.slug}-studio` },
      { original: 'supabase-kong', replacement: `${project.slug}-kong` },
      { original: 'supabase-auth', replacement: `${project.slug}-auth` },
      { original: 'supabase-rest', replacement: `${project.slug}-rest` },
      { original: 'realtime-dev.supabase-realtime', replacement: `realtime-dev.${project.slug}-realtime` },
      { original: 'supabase-storage', replacement: `${project.slug}-storage` },
      { original: 'supabase-imgproxy', replacement: `${project.slug}-imgproxy` },
      { original: 'supabase-meta', replacement: `${project.slug}-meta` },
      { original: 'supabase-edge-functions', replacement: `${project.slug}-edge-functions` },
      { original: 'supabase-analytics', replacement: `${project.slug}-analytics` },
      { original: 'supabase-db', replacement: `${project.slug}-db` },
      { original: 'supabase-vector', replacement: `${project.slug}-vector` },
      { original: 'supabase-pooler', replacement: `${project.slug}-pooler` },
      { original: 'supavisor', replacement: `${project.slug}-pooler` }
    ]

    for (const mapping of containerMappings) {
      dockerComposeContent = dockerComposeContent.replace(
        new RegExp(`container_name: ${mapping.original}`, 'g'),
        `container_name: ${mapping.replacement}`
      )
      // Also update service name
      dockerComposeContent = dockerComposeContent.replace(
        new RegExp(`^  ${mapping.original}:`, 'gm'),
        `  ${mapping.replacement}:`
      )
    }

    // Update port mappings with environment variables
    dockerComposeContent = dockerComposeContent.replace(
      /- 4000:4000/g,
      `- \${ANALYTICS_PORT}:4000`
    )

    // Apply healthcheck safety patches for VPS stability
    dockerComposeContent = dockerComposeContent.replace(/retries: 10/g, 'retries: 120')
    dockerComposeContent = dockerComposeContent.replace(/retries: 3/g, 'retries: 60')
    dockerComposeContent = dockerComposeContent.replace(/"localhost"/g, '"127.0.0.1"')

    await fs.writeFile(projectDockerComposePath, dockerComposeContent)
    console.log('docker-compose.yml restored')

    // Step 5: Write .env file with pgbouncer=true for Prisma compatibility
    const envFilePath = path.join(projectDir, '.env')
    
    // Ensure all required environment variables exist
    const defaultEnvVars: Record<string, string> = {
      STORAGE_TENANT_ID: 'stub',
      REGION: 'stub',
      S3_PROTOCOL_ACCESS_KEY_ID: '',
      S3_PROTOCOL_ACCESS_KEY_SECRET: '',
      GLOBAL_S3_BUCKET: 'stub',
      IMGPROXY_AUTO_WEBP: '',
      ANALYTICS_BACKEND: 'postgres',
    }
    
    // Merge with existing env vars, filling in defaults for missing ones
    for (const [key, value] of Object.entries(defaultEnvVars)) {
      if (!envVarsMap[key]) {
        envVarsMap[key] = value
      }
    }
    
    // Add pgbouncer=true to DATABASE_URL for Prisma compatibility with pooler
    if (envVarsMap.DATABASE_URL && !envVarsMap.DATABASE_URL.includes('pgbouncer')) {
      envVarsMap.DATABASE_URL = envVarsMap.DATABASE_URL + '&pgbouncer=true'
    }
    
    const envContent = Object.entries(envVarsMap)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    await fs.writeFile(envFilePath, envContent)
    console.log('.env file restored with all required variables')

    // Save updated env vars to database (including DATABASE_URL with pgbouncer and storage vars)
    for (const [key, value] of Object.entries(envVarsMap)) {
      await prisma.projectEnvVar.upsert({
        where: { projectId_key: { projectId, key } },
        update: { value },
        create: { projectId, key, value }
      })
    }
    console.log('Environment variables saved to database')

    // Step 6: Write init-db.sql
    try {
      const initScriptTemplatePath = path.join(process.cwd(), 'src', 'templates', 'init-db.sql.template')
      const initScriptTemplate = await fs.readFile(initScriptTemplatePath, 'utf8')
      const initScript = initScriptTemplate.replace(
        /{{POSTGRES_PASSWORD}}/g,
        envVarsMap.POSTGRES_PASSWORD || 'postgres'
      )
      const initScriptPath = path.join(projectDir, 'init-db.sql')
      await fs.writeFile(initScriptPath, initScript)
      console.log('init-db.sql restored')
    } catch (initError) {
      console.warn('Could not restore init-db.sql:', initError)
    }

    // Step 7: Copy only essential volume files needed for containers to start
    const isWindows = process.platform === 'win32'
    const projectVolumesDir = path.join(projectDir, 'volumes')
    
    try {
      // Create volumes directory structure
      await fs.mkdir(projectVolumesDir, { recursive: true })
      
      // Copy Kong-specific volumes (required for Kong to start)
      const kongVolumesDir = path.join(projectVolumesDir, 'api')
      await fs.mkdir(kongVolumesDir, { recursive: true })
      
      // Copy kong.yml
      const coreKongYml = path.join(coreDockerDir, 'volumes', 'api', 'kong.yml')
      if (await fs.access(coreKongYml).then(() => true).catch(() => false)) {
        await fs.copyFile(coreKongYml, path.join(kongVolumesDir, 'kong.yml'))
        console.log('Copied kong.yml')
      }
      
      // Copy kong-entrypoint.sh
      const coreKongEntry = path.join(coreDockerDir, 'volumes', 'api', 'kong-entrypoint.sh')
      if (await fs.access(coreKongEntry).then(() => true).catch(() => false)) {
        const entryContent = await fs.readFile(coreKongEntry, 'utf8')
        // Ensure Unix line endings
        const fixedContent = entryContent.replace(/\r\n/g, '\n')
        await fs.writeFile(path.join(kongVolumesDir, 'kong-entrypoint.sh'), fixedContent)
        console.log('Copied kong-entrypoint.sh')
        
        // Make executable (Unix only)
        if (!isWindows) {
          await execAsync(`chmod +x "${path.join(kongVolumesDir, 'kong-entrypoint.sh')}"`)
        }
      }
      
      // Copy studio volumes
      const studioVolumesDir = path.join(projectVolumesDir, 'studio')
      await fs.mkdir(studioVolumesDir, { recursive: true })
      
      const coreSnippetsDir = path.join(coreDockerDir, 'volumes', 'snippets')
      if (await fs.access(coreSnippetsDir).then(() => true).catch(() => false)) {
        await fs.mkdir(path.join(projectVolumesDir, 'snippets'), { recursive: true })
        await fs.mkdir(path.join(projectVolumesDir, 'functions'), { recursive: true })
        console.log('Created studio volumes directories')
      }
      
      // Copy db volumes (pooler.sql for initialization)
      const dbVolumesDir = path.join(projectVolumesDir, 'db')
      await fs.mkdir(dbVolumesDir, { recursive: true })
      
      const corePoolerSql = path.join(coreDockerDir, 'volumes', 'db', 'pooler.sql')
      if (await fs.access(corePoolerSql).then(() => true).catch(() => false)) {
        await fs.copyFile(corePoolerSql, path.join(dbVolumesDir, 'pooler.sql'))
        console.log('Copied pooler.sql')
      }
      
      console.log('Essential volumes copied')
    } catch (volError) {
      console.warn('Could not copy volumes:', volError)
    }

    // Step 7b: Create pooler.exs with correct configuration (with String.to_integer)
    try {
      const poolerVolumesDir = path.join(projectVolumesDir, 'pooler')
      await fs.mkdir(poolerVolumesDir, { recursive: true })
      
      const poolerExsPath = path.join(poolerVolumesDir, 'pooler.exs')
      const poolerContent = `{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => System.get_env("POOLER_TENANT_ID"),
  "db_host" => "db",
  "db_port" => String.to_integer(System.get_env("POSTGRES_PORT")),
  "db_database" => System.get_env("POSTGRES_DB"),
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => System.get_env("POOLER_MAX_CLIENT_CONN"),
  "default_pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => System.get_env("POSTGRES_PASSWORD"),
    "mode_type" => System.get_env("POOLER_POOL_MODE"),
    "pool_size" => System.get_env("POOLER_DEFAULT_POOL_SIZE"),
    "is_manager" => true
  }]
}

if !Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  {:ok, _} = Supavisor.Tenants.create_tenant(params)
end
`
      
      await fs.writeFile(poolerExsPath, poolerContent)
      console.log('Created pooler.exs with String.to_integer conversion')
    } catch (poolerFixError) {
      console.warn('Could not create pooler.exs:', poolerFixError)
    }

    // Step 8: Start containers
    console.log('Starting containers...')
    
    // First try to start existing containers
    try {
      console.log('Attempting docker compose start...')
      await execAsync('docker compose start', {
        cwd: projectDir,
        timeout: 180000
      })
      console.log('Containers started successfully')
    } catch {
      console.log('Start failed, trying docker compose up...')
      try {
        // First pull latest images
        console.log('Pulling latest images...')
        await execAsync('docker compose pull', {
          cwd: projectDir,
          timeout: 300000,
          maxBuffer: 1024 * 1024 * 20
        })
        
        console.log('Starting containers with up...')
        await execAsync('docker compose up -d', {
          cwd: projectDir,
          timeout: 600000,
          maxBuffer: 1024 * 1024 * 20
        })
        console.log('Containers started successfully')
      } catch (upError) {
        const errorMsg = upError instanceof Error ? upError.message : String(upError)
        console.log('Docker up error:', errorMsg)
        
        // Check all container status
        try {
          console.log('Checking container status...')
          const { stdout: psOutput } = await execAsync('docker ps -a --filter "name=' + project.slug + '" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', {
            timeout: 30000
          })
          console.log('Container status:\n', psOutput)
          
          // Check which containers are unhealthy
          const { stdout: unhealthy } = await execAsync('docker ps --filter "name=' + project.slug + '" --filter "health=unhealthy" --format "{{.Names}}: {{.Status}}"', {
            timeout: 30000
          })
          if (unhealthy) {
            console.log('Unhealthy containers:', unhealthy)
          }
          
          // Get Kong logs
          console.log('Getting Kong logs...')
          const { stdout: kongLogs } = await execAsync('docker logs ' + project.slug + '-kong --tail 50 2>&1', {
            timeout: 30000,
            maxBuffer: 1024 * 1024
          })
          console.log('Kong logs:', kongLogs)
        } catch (psError) {
          console.log('Could not get container status/logs:', psError)
        }
        
        throw new Error('Failed to start containers. Check Docker Desktop and try again.')
      }
    }

    // Connect SupaConsole to the project's Docker network for proxy access
    try {
      const projectName = project.slug
      const networkName = `${projectName}_default`
      const containerName = 'supaconsole-app'
      
      // Check if network exists
      try {
        await execAsync(`docker network inspect ${networkName}`, { timeout: 5000 })
        
        // Check if already connected
        try {
          await execAsync(`docker network inspect ${networkName} --format '{{range .Containers}}{{.Name}} {{end}}'`, {
            timeout: 5000
          }).then(({ stdout }) => {
            if (!stdout.includes(containerName)) {
              console.log(`Connecting SupaConsole to network ${networkName}...`)
              execAsync(`docker network connect ${networkName} ${containerName}`).catch(() => {})
            }
          }).catch(() => {})
        } catch {}
      } catch {}
    } catch {
      console.warn('Could not connect to project network (non-critical)')
    }

    // Connect SupaConsole to the project's Docker network for proxy access
    try {
      const networkName = `${project.slug}_default`
      const containerName = 'supaconsole-app'
      
      try {
        await execAsync(`docker network inspect ${networkName}`, { timeout: 5000 })
        
        try {
          const { stdout } = await execAsync(
            `docker network inspect ${networkName} --format '{{range $key, $val := .Containers}}{{$key}} {{end}}'`,
            { timeout: 5000 }
          )
          
          if (!stdout.includes(containerName)) {
            console.log(`Connecting SupaConsole to network ${networkName}...`)
            try {
              await execAsync(`docker network connect ${networkName} ${containerName}`, { timeout: 10000 })
              console.log(`Successfully connected to network ${networkName}`)
            } catch (connectErr) {
              console.warn(`Failed to connect to network ${networkName}:`, connectErr)
            }
          }
        } catch (inspectErr) {
          console.warn('Could not check network membership:', inspectErr)
        }
      } catch (netErr) {
        console.warn(`Network ${networkName} not found (project may not be running):`, netErr)
      }
    } catch (connectErr) {
      console.warn('Could not connect SupaConsole to project network:', connectErr)
    }

    console.log(`Project ${project.name} restored successfully`)

    const result: any = { success: true, project }
    if (portsChanged) {
      result.newPorts = {
        POSTGRES_PORT: envVarsMap['POSTGRES_PORT'],
        POOLER_PROXY_PORT_TRANSACTION: envVarsMap['POOLER_PROXY_PORT_TRANSACTION']
      }
    }
    return result
  } catch (error) {
    console.error(`Failed to restore project ${projectId}:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function updateProjectToLatest(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      throw new Error('Project not found')
    }

    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')

    // Verify Docker is running before attempting any operations
    const dockerCheck = await checkDockerPrerequisites()
    if (!dockerCheck.docker || !dockerCheck.dockerCompose) {
      throw new Error('Docker is not running. Please start Docker Desktop and try again.')
    }

    // Step 1: Stop Docker containers
    console.log(`Stopping containers for project ${project.slug}...`)
    try {
      await execAsync('docker compose stop', { cwd: projectDir, timeout: 60000 })
    } catch {
      console.log('Containers not running or already stopped, continuing...')
    }

    // Step 2: Update supabase-core reference (git pull)
    const coreDir = path.join(process.cwd(), 'supabase-core')
    if (await fs.access(coreDir).then(() => true).catch(() => false)) {
      console.log('Updating supabase-core reference...')
      try {
        const version = process.env.SUPABASE_VERSION || 'v1.24.09'
        // Fetch the specific version (tag or branch) with depth 1
        await execAsync(`git fetch origin ${version} --depth 1`, { cwd: coreDir, timeout: 60000 })
        await execAsync('git reset --hard FETCH_HEAD', { cwd: coreDir, timeout: 60000 })
        console.log('supabase-core updated')
      } catch {
        console.log('Could not update supabase-core (git error)')
      }
    }

    // Step 3: Update .env file from database
    const envVars = await prisma.projectEnvVar.findMany({
      where: { projectId },
    })
    const envVarsMap: Record<string, string> = {}
    envVars.forEach(ev => {
      envVarsMap[ev.key] = ev.value
    })

    const envFilePath = path.join(projectDir, '.env')
    const envContent = Object.entries(envVarsMap)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    await fs.writeFile(envFilePath, envContent)
    console.log(`.env file synced from database`)

    // Step 4: Restart containers
    console.log(`Starting containers for project ${project.slug}...`)
    
    try {
      console.log(`Attempting to start existing containers...`)
      await execAsync('docker compose start', {
        cwd: projectDir,
        timeout: 120000
      })
      console.log(`Containers started for project ${project.slug}`)
    } catch {
      console.log(`Start failed, attempting docker compose up...`)
      try {
        await execAsync('docker compose up -d --remove-orphans', {
          cwd: projectDir,
          timeout: 600000,
          maxBuffer: 1024 * 1024 * 20
        })
        console.log(`Containers started for project ${project.slug}`)
      } catch {
        throw new Error('Failed to start containers. Try restoring the project.')
      }
    }

    console.log(`Project ${project.slug} updated successfully`)
    return { success: true, project }
  } catch (error) {
    console.error(`Failed to update project ${projectId}:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export interface UpdateAllProjectsResult {
  success: boolean
  updated: string[]
  failed: { projectId: string; name: string; error: string }[]
  error?: string
}

export async function updateAllProjects(): Promise<UpdateAllProjectsResult> {
  const result: UpdateAllProjectsResult = {
    success: true,
    updated: [],
    failed: []
  }

  try {
    // Step 0: Verify Docker is running
    console.log('Checking Docker prerequisites...')
    const dockerCheck = await checkDockerPrerequisites()
    
    if (!dockerCheck.docker) {
      throw new Error('Docker is not installed or not running. Please start Docker Desktop and try again.')
    }
    
    if (!dockerCheck.dockerCompose) {
      throw new Error('Docker Compose is not available. Please ensure Docker Desktop includes Docker Compose.')
    }
    
    if (!dockerCheck.internetConnection) {
      console.warn('No internet connection detected. Updates may fail if new images are needed.')
    }
    
    console.log('Docker prerequisites check passed')

    // Step 1: Update supabase-core to latest version
    const coreDir = path.join(process.cwd(), 'supabase-core')
    
    if (await fs.access(coreDir).then(() => true).catch(() => false)) {
      console.log(`Updating supabase-core to latest version...`)
      try {
        const version = process.env.SUPABASE_VERSION || 'v1.24.09'
        await execAsync(`git fetch origin ${version} --depth 1`, { cwd: coreDir, timeout: 60000 })
        await execAsync('git reset --hard FETCH_HEAD', { cwd: coreDir, timeout: 60000 })
        console.log('supabase-core updated successfully')
      } catch (gitError) {
        console.warn('Could not update supabase-core (git error):', gitError)
      }
    } else {
      throw new Error('supabase-core directory not found. Please initialize first.')
    }

    // Step 2: Get all projects from database
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'asc' }
    })

    // Step 3: Update each project sequentially
    for (const project of projects) {
      console.log(`Updating project: ${project.name}...`)
      const updateResult = await updateProjectToLatest(project.id)
      
      if (updateResult.success) {
        result.updated.push(project.name)
      } else {
        result.failed.push({
          projectId: project.id,
          name: project.name,
          error: updateResult.error || 'Unknown error'
        })
      }
    }

    result.success = result.failed.length === 0
    return result
  } catch (error) {
    console.error('Failed to update all projects:', error)
    return {
      success: false,
      updated: [],
      failed: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
