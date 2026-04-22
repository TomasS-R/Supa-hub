import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Cache for network connection attempts
const networkConnectionCache = new Map<string, boolean>()

async function ensureNetworkConnected(slug: string): Promise<void> {
  const cacheKey = slug
  if (networkConnectionCache.has(cacheKey)) return
  
  const networkName = `${slug}_default`
  
  try {
    // Check if network exists
    await execAsync(`docker network inspect ${networkName}`, { timeout: 5000 })
    
    // Get our own container name
    let containerName: string
    try {
      const { stdout } = await execAsync("cat /proc/1/cgroup 2>/dev/null | grep -o 'supaconsole[^/]*' | head -1", { timeout: 5000 })
      containerName = stdout.trim()
    } catch {
      containerName = ''
    }
    
    if (!containerName) {
      try {
        const { stdout } = await execAsync('hostname', { timeout: 5000 })
        containerName = stdout.trim()
      } catch {
        containerName = ''
      }
    }
    
    if (!containerName) {
      console.warn('Could not detect own container name')
      return
    }
    
    // Check if already connected
    try {
      const { stdout } = await execAsync(
        `docker network inspect ${networkName} --format '{{range $key, $val := .Containers}}{{$key}} {{end}}'`,
        { timeout: 5000 }
      )
      
      if (!stdout.includes(containerName)) {
        console.log(`Connecting ${containerName} to network ${networkName}...`)
        await execAsync(`docker network connect ${networkName} ${containerName}`, { timeout: 10000 })
        console.log(`Connected to network ${networkName}`)
      }
    } catch {}
  } catch {
    // Network doesn't exist yet (project not deployed)
  }
  
  networkConnectionCache.set(cacheKey, true)
}

interface RouteContext {
  params: Promise<{
    slug: string
    service: string
  }>
}

const ALLOWED_SERVICES = ['kong', 'studio', 'analytics', 'db', 'rest', 'auth', 'storage']

async function resolveHost(service: string, slug: string, port: string): Promise<string> {
  // Priority 1: Container name (when on same Docker network)
  // Docker DNS resolves container names like {slug}-kong within the same network
  const containerNames: Record<string, string> = {
    kong: `${slug}-kong`,
    studio: `${slug}-studio`,
    analytics: `${slug}-analytics`,
    auth: `${slug}-auth`,
    rest: `${slug}-rest`,
    storage: `${slug}-storage`,
    db: `${slug}-db`,
  }
  
  return containerNames[service] || `${slug}-${service}`
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { slug, service } = await params
  
  if (!ALLOWED_SERVICES.includes(service)) {
    return NextResponse.json(
      { error: 'Invalid service' },
      { status: 400 }
    )
  }

  try {
    const sessionToken = request.cookies.get('session')?.value

    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const session = await validateSession(sessionToken)
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      )
    }

    const project = await prisma.project.findUnique({
      where: { slug }
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const envVars = await prisma.projectEnvVar.findMany({
      where: { projectId: project.id }
    })

    const envVarsMap: Record<string, string> = {}
    envVars.forEach((envVar: { key: string; value: string }) => {
      envVarsMap[envVar.key] = envVar.value
    })

    let targetPort: string | undefined
    switch (service) {
      case 'kong':
        targetPort = envVarsMap.KONG_HTTP_PORT
        break
      case 'studio':
        targetPort = envVarsMap.STUDIO_PORT
        break
      case 'analytics':
        targetPort = envVarsMap.ANALYTICS_PORT
        break
      case 'db':
        targetPort = envVarsMap.POSTGRES_PORT
        break
      case 'rest':
        targetPort = envVarsMap.POSTGRES_PORT
        break
      case 'auth':
        targetPort = envVarsMap.KONG_HTTP_PORT
        break
      case 'storage':
        targetPort = envVarsMap.KONG_HTTP_PORT
        break
    }

    if (!targetPort) {
      return NextResponse.json(
        { error: `Port not found for service: ${service}` },
        { status: 500 }
      )
    }

    const disabledStr = envVarsMap.DISABLED_MODULES || ''
    const disabledModules = disabledStr ? disabledStr.split(',') : []
    
    if ((service === 'studio' && disabledModules.includes('studio')) ||
        (service === 'analytics' && disabledModules.includes('analytics'))) {
      return NextResponse.json(
        { error: `Service ${service} is disabled for this project` },
        { status: 403 }
      )
    }

    // Ensure SupaConsole is connected to the project's Docker network
    await ensureNetworkConnected(slug)

    // Resolve the target host (container name when on same network)
    const targetHost = await resolveHost(service, slug, targetPort)
    const targetUrl = `http://${targetHost}:${targetPort}${request.nextUrl.pathname}${request.nextUrl.search}`
    
    let body: ReadableStream | null = null
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      body = request.body
    }

    const fetchOptions: RequestInit = {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        'host': `${targetHost}:${targetPort}`,
      },
      body: body,
      redirect: 'manual',
    }

    try {
      const response = await fetch(targetUrl, fetchOptions)
      
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch (fetchError) {
      console.error(`Proxy error for ${service} on project ${slug} (host: ${targetHost}:${targetPort}):`, fetchError)
      return NextResponse.json(
        { error: `Failed to connect to ${service} service. Is the project running? Tried host: ${targetHost}:${targetPort}` },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Proxy error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
