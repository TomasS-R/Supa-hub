import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

interface RouteContext {
  params: Promise<{
    slug: string
    service: string
  }>
}

const ALLOWED_SERVICES = ['kong', 'studio', 'analytics', 'db', 'rest', 'auth', 'storage']

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

    // Try multiple host addresses to reach services on the Docker host
    const hostCandidates = [
      process.env.DOCKER_HOST_IP,
      'host.docker.internal',
      '172.17.0.1',
      '172.18.0.1',
      '172.19.0.1',
    ].filter(Boolean) as string[]

    let finalUrl: string | null = null
    let lastError: Error | null = null

    for (const host of hostCandidates) {
      const testUrl = `http://${host}:${targetPort}`
      try {
        const testResponse = await fetch(testUrl, { 
          method: 'GET',
          signal: AbortSignal.timeout(300)
        })
        finalUrl = testUrl
        break
      } catch (e) {
        lastError = e as Error
        continue
      }
    }

    if (!finalUrl) {
      console.error(`Cannot reach Docker host for proxy. Tried: ${hostCandidates.join(', ')}. Last error:`, lastError)
      return NextResponse.json(
        { error: `Cannot connect to ${service} service. Docker host unreachable.` },
        { status: 502 }
      )
    }

    const targetUrl = `${finalUrl}${request.nextUrl.pathname}${request.nextUrl.search}`
    
    let body: ReadableStream | null = null
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      body = request.body
    }

    const fetchOptions: RequestInit = {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        'host': `127.0.0.1:${targetPort}`,
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
      console.error(`Proxy error for ${service} on project ${slug}:`, fetchError)
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

export const dynamic = 'force-dynamic'
export const revalidate = 0
