import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { restoreProject } from '@/lib/project'

interface RouteContext {
  params: Promise<{
    id: string
  }>
}

export async function POST(request: NextRequest, { params }: RouteContext) {
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

    const body = await request.json().catch(() => ({}))
    const forceNewPorts = body.forceNewPorts === true
    const customPorts = body.customPorts || null

    const result = await restoreProject(id, forceNewPorts, customPorts)

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true, 
      newPorts: result.newPorts || null,
      message: result.newPorts 
        ? 'Project restored with new ports assigned'
        : 'Project restored successfully'
    })
  } catch (error) {
    console.error('Restore project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
