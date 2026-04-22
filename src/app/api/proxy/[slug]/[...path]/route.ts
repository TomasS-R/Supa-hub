import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

interface RouteContext {
  params: Promise<{
    slug: string
    path: string[]
  }>
}

const ALLOWED_SERVICES = ['kong', 'studio', 'analytics', 'db', 'rest', 'auth', 'storage']

// Internal Docker ports — these are the ports services listen on INSIDE their containers,
// not the external mapped ports. When communicating via Docker network (dokploy-network),
// we always use internal ports.
const INTERNAL_PORTS: Record<string, number> = {
  kong: 8000,
  studio: 3000,
  analytics: 4000,
  auth: 9999,
  rest: 3000,
  storage: 5000,
  db: 5432,
}

function getContainerName(service: string, slug: string): string {
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

    // Check if service is disabled
    const disabledEnv = await prisma.projectEnvVar.findUnique({
      where: { projectId_key: { projectId: project.id, key: 'DISABLED_MODULES' } }
    })
    const disabledModules = disabledEnv?.value ? disabledEnv.value.split(',') : []

    if ((service === 'studio' && disabledModules.includes('studio')) ||
        (service === 'analytics' && disabledModules.includes('analytics'))) {
      return NextResponse.json(
        { error: `Service ${service} is disabled for this project` },
        { status: 403 }
      )
    }

    // Build the target URL using internal Docker ports and container names.
    // Both SupaConsole and Supabase services are on dokploy-network,
    // so Docker DNS resolves container names automatically.
    const containerName = getContainerName(service, slug)
    const internalPort = INTERNAL_PORTS[service]

    // Build the forwarded path — the path segments already exclude /api/proxy/[slug]
    // because Next.js routing extracted [slug] and [...path] for us.
    const forwardPath = remainingPath.length > 0
      ? '/' + remainingPath.join('/')
      : '/'

    const queryString = request.nextUrl.search || ''
    const targetUrl = `http://${containerName}:${internalPort}${forwardPath}${queryString}`

    let body: ReadableStream | null = null
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      body = request.body
    }

    // Forward the request, but fix the Host header to match the target
    const headers = new Headers(request.headers)
    headers.set('host', `${containerName}:${internalPort}`)
    // Remove headers that could cause issues with the proxy
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
      // Remove headers that Next.js shouldn't pass through
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      responseHeaders.delete('transfer-encoding')

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch (fetchError) {
      console.error(`Proxy error for ${service} on project ${slug} (target: ${targetUrl}):`, fetchError)
      return NextResponse.json(
        { error: `Failed to connect to ${service} service. Is the project running? Target: ${containerName}:${internalPort}` },
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

// Export all HTTP methods so Studio, Kong API, etc. all work through the proxy
export const GET = handleProxy
export const POST = handleProxy
export const PUT = handleProxy
export const PATCH = handleProxy
export const DELETE = handleProxy
export const OPTIONS = handleProxy
export const HEAD = handleProxy

export const dynamic = 'force-dynamic'
export const revalidate = 0
