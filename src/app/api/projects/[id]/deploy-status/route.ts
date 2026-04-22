import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getProjectStatus } from '@/lib/project'

interface RouteContext {
  params: Promise<{
    id: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
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
      where: { id },
      select: {
        id: true,
        slug: true,
        status: true,
        deployStatus: true,
        deployLog: true,
      }
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Also get live Docker status
    const dockerStatus = await getProjectStatus(project.slug)

    return NextResponse.json({
      status: project.status,
      deployStatus: project.deployStatus,
      deployLog: project.deployLog,
      dockerStatus: dockerStatus.status,
      containers: dockerStatus.containers,
    })
  } catch (error) {
    console.error('Deploy status error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
