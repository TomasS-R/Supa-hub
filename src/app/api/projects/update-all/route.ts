import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { updateAllProjects } from '@/lib/project'

export async function POST(request: NextRequest) {
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

    const result = await updateAllProjects()

    if (!result.success && result.updated.length === 0) {
      return NextResponse.json(
        { error: result.error || 'Failed to update projects' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: result.success,
      updated: result.updated,
      failed: result.failed
    })
  } catch (error) {
    console.error('Update all projects error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
