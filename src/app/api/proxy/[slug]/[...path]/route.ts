import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

interface RouteContext {
  params: Promise<{
    slug: string
    path: string[]
  }>
}

const ALLOWED_SERVICES = ['kong', 'studio', 'analytics', 'db', 'rest', 'auth', 'storage']

// Internal Docker ports — these are the ports services listen on INSIDE their containers.
const INTERNAL_PORTS: Record<string, number> = {
  kong: 8000,
  studio: 3000,
  analytics: 4000,
  auth: 9999,
  rest: 3000,
  storage: 5000,
  db: 5432,
}

// Cache container IPs for 30 seconds to avoid calling docker inspect on every request
const ipCache = new Map<string, { ip: string; timestamp: number }>()
const IP_CACHE_TTL = 30_000 // 30 seconds

/**
 * Resolve a container's IP address using `docker inspect`.
 * This bypasses Docker DNS entirely, which doesn't work reliably
 * between Swarm services (SupaConsole) and standalone containers (Supabase projects).
 */
async function resolveContainerIP(containerName: string): Promise<string | null> {
  // Check cache first
  const cached = ipCache.get(containerName)
  if (cached && Date.now() - cached.timestamp < IP_CACHE_TTL) {
    return cached.ip
  }

  try {
    const { stdout } = await execAsync(
      `docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${containerName}`,
      { timeout: 5000 }
    )
    const ip = stdout.trim().split(' ').filter(Boolean)[0]
    if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      ipCache.set(containerName, { ip, timestamp: Date.now() })
      return ip
    }
    return null
  } catch {
    // Container not running or not found
    ipCache.delete(containerName)
    return null
  }
}

function getContainerName(service: string, slug: string): string {
  return `${slug}-${service}`
}

async function handleProxy(request: NextRequest, { params }: RouteContext) {
  const { slug, path: pathSegments } = await params

  // First segment of path is the service name, rest is the forwarded path
  const service = pathSegments[0]
  const remainingPath = pathSegments.slice(1)

  if (!service || !ALLOWED_SERVICES.includes(service)) {
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

    const containerName = getContainerName(service, slug)
    const internalPort = INTERNAL_PORTS[service]

    // Resolve container IP via docker inspect (bypasses Docker DNS issues)
    const containerIP = await resolveContainerIP(containerName)
    if (!containerIP) {
      return NextResponse.json(
        { error: `Service ${service} is not running. Container '${containerName}' not found or has no IP address.` },
        { status: 503 }
      )
    }

    // Build the forwarded path
    const forwardPath = remainingPath.length > 0
      ? '/' + remainingPath.join('/')
      : '/'

    const queryString = request.nextUrl.search || ''
    const targetUrl = `http://${containerIP}:${internalPort}${forwardPath}${queryString}`

    let body: ReadableStream | null = null
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      body = request.body
    }

    // Forward the request with corrected headers
    const headers = new Headers(request.headers)
    headers.set('host', `${containerName}:${internalPort}`)
    headers.delete('connection')
    headers.delete('transfer-encoding')

    const fetchOptions: RequestInit = {
      method: request.method,
      headers: Object.fromEntries(headers.entries()),
      body: body,
      redirect: 'manual',
    }

    try {
      const response = await fetch(targetUrl, fetchOptions)

      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      responseHeaders.delete('transfer-encoding')

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch (fetchError) {
      // Clear cache on connection failure so next request retries inspect
      ipCache.delete(containerName)
      console.error(`Proxy error for ${service} on project ${slug} (target: ${targetUrl}):`, fetchError)
      return NextResponse.json(
        { error: `Failed to connect to ${service} service. Is the project running?` },
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

// Export all HTTP methods
export const GET = handleProxy
export const POST = handleProxy
export const PUT = handleProxy
export const PATCH = handleProxy
export const DELETE = handleProxy
export const OPTIONS = handleProxy
export const HEAD = handleProxy

export const dynamic = 'force-dynamic'
export const revalidate = 0
