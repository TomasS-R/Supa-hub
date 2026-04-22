'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { toast } from 'vibe-toast'
import { Play, Pause, Trash2, RotateCw, Settings, RefreshCw, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface Project {
  id: string
  name: string
  slug: string
  description?: string
  status: string
  deployStatus?: string
  deployLog?: string
  createdAt: string
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [initializing, setInitializing] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [initProgress, setInitProgress] = useState('')
  const [error, setError] = useState('')
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [projectDisabledModules, setProjectDisabledModules] = useState<string[]>([])
  const [projectUrls, setProjectUrls] = useState<Record<string, string>>({})
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateResult, setUpdateResult] = useState<{
    success: boolean
    updated: string[]
    failed: { name: string; error: string }[]
  } | null>(null)
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [restoreWithNewPorts, setRestoreWithNewPorts] = useState(false)
  const [restoreSuccess, setRestoreSuccess] = useState<{ message: string; newPorts?: any } | null>(null)
  const [showCustomPorts, setShowCustomPorts] = useState(false)
  const [customPorts, setCustomPorts] = useState({
    POSTGRES_PORT: '',
    POOLER_PROXY_PORT_TRANSACTION: ''
  })
  const [inlineActionLoading, setInlineActionLoading] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [projectUrlsMap, setProjectUrlsMap] = useState<Record<string, Record<string, string>>>({})
  const [openLinksDropdown, setOpenLinksDropdown] = useState<string | null>(null)
  const linksDropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const fetchProjectUrl = async (projectId: string, slug: string): Promise<Record<string, string>> => {
    try {
      const response = await fetch(`/api/projects/${projectId}/env`)
      if (!response.ok) return {}
      const data = await response.json()
      const envVars = data.envVars || {}
      const disabledStr = envVars.DISABLED_MODULES || ''
      const disabledVars = disabledStr ? disabledStr.split(',') : []
      
      const urls: Record<string, string> = {}
      const serverHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
      const serverProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:'
      const isLocal = serverHost === 'localhost' || serverHost === '127.0.0.1'
      
      if (slug && envVars.KONG_HTTP_PORT) {
        if (isLocal) {
          urls['API Gateway'] = `${serverProtocol}//${serverHost}:${envVars.KONG_HTTP_PORT}`
        } else {
          urls['API Gateway'] = `${serverProtocol}//${serverHost}/api/proxy/${slug}/kong`
        }
      }
      if (envVars.STUDIO_PORT && !disabledVars.includes('studio')) {
        if (isLocal) {
          urls['Supabase Studio'] = `${serverProtocol}//${serverHost}:${envVars.STUDIO_PORT}`
        } else {
          urls['Supabase Studio'] = `${serverProtocol}//${serverHost}/api/proxy/${slug}/studio`
        }
      }
      if (envVars.ANALYTICS_PORT && !disabledVars.includes('analytics')) {
        if (isLocal) {
          urls['Analytics'] = `${serverProtocol}//${serverHost}:${envVars.ANALYTICS_PORT}`
        } else {
          urls['Analytics'] = `${serverProtocol}//${serverHost}/api/proxy/${slug}/analytics`
        }
      }
      if (envVars.POSTGRES_PORT) {
        urls['Database'] = `postgresql://postgres:${envVars.POSTGRES_PASSWORD || 'password'}@${serverHost}:${envVars.POSTGRES_PORT}/postgres`
      }
      return urls
    } catch {
      return {}
    }
  }

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects')
      if (response.ok) {
        const data = await response.json()
        setProjects(data.projects)
        if (data.projects.length > 0) {
          setInitialized(true)
          
          const urlsMap: Record<string, Record<string, string>> = {}
          await Promise.all(
            data.projects.map(async (project: Project) => {
              const urls = await fetchProjectUrl(project.id, project.slug)
              if (Object.keys(urls).length > 0) {
                urlsMap[project.id] = urls
              }
            })
          )
          setProjectUrlsMap(urlsMap)
        }
      } else if (response.status === 401) {
        router.push('/auth/login')
        return
      }
    } catch {
      setError('Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  const handleInitialize = async () => {
    setInitializing(true)
    setError('')
    setInitProgress('Starting initialization...')

    try {
      setInitProgress('Creating directories...')
      await new Promise(resolve => setTimeout(resolve, 500)) // Small delay for UX

      setInitProgress('Cloning Supabase repository (this may take a few minutes)...')
      const response = await fetch('/api/projects/initialize', {
        method: 'POST',
      })

      if (response.ok) {
        setInitProgress('Repository cloned successfully!')
        await new Promise(resolve => setTimeout(resolve, 1000))
        setInitialized(true)
        setInitProgress('')
        toast.success('Initialization complete!', {
          description: 'Supabase repository cloned successfully.',
        })
      } else {
        const data = await response.json()
        setError(data.error || 'Initialization failed')
        setInitProgress('')
        toast.error('Initialization failed', {
          description: data.error || 'Something went wrong',
        })
      }
    } catch {
      setError('An error occurred during initialization')
      setInitProgress('')
      toast.error('Error', {
        description: 'An error occurred during initialization',
      })
    } finally {
      setInitializing(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/auth/login')
    } catch (err) {
      console.error('Logout error:', err)
    }
  }

  const handleCreateProject = () => {
    router.push('/dashboard/create-project')
  }

  const handleUpdateAll = async () => {
    setShowUpdateModal(true)
    setUpdating(true)
    setUpdateResult(null)

    try {
      const response = await fetch('/api/projects/update-all', {
        method: 'POST',
      })

      if (response.ok) {
        const data = await response.json()
        setUpdateResult({
          success: data.success,
          updated: data.updated || [],
          failed: data.failed || []
        })
        if (data.success) {
          toast.success('Update complete', {
            description: `${data.updated?.length || 0} projects updated successfully.`,
          })
        } else {
          toast.error('Update failed', {
            description: 'Unable to update projects.',
          })
        }
      } else {
        const data = await response.json()
        setUpdateResult({
          success: false,
          updated: [],
          failed: [],
        })
        console.error('Update failed:', data.error)
        toast.error('Update failed', {
          description: data.error || 'Something went wrong',
        })
      }
    } catch (error) {
      console.error('Update all projects error:', error)
      setUpdateResult({
        success: false,
        updated: [],
        failed: [],
      })
      toast.error('Error', {
        description: 'Failed to update projects',
      })
    } finally {
      setUpdating(false)
    }
  }

  const closeUpdateModal = () => {
    setShowUpdateModal(false)
    setUpdateResult(null)
  }

  const handleDeleteProject = async () => {
    if (!selectedProject) return

    setDeleting(true)
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        setProjects(prev => prev.filter(p => p.id !== selectedProject.id))
        setSelectedProject(null)
        setShowDeleteConfirm(false)
        toast.success('Project deleted', {
          description: `${selectedProject.name} has been removed.`,
        })
      } else {
        const data = await response.json()
        setError(data.error || 'Failed to delete project')
        toast.error('Failed to delete', {
          description: data.error || 'Something went wrong',
        })
      }
    } catch (error) {
      setError('Failed to delete project')
      console.error('Delete project error:', error)
      toast.error('Error', {
        description: 'Failed to delete project',
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleRestoreProject = async () => {
    if (!selectedProject) return

    setRestoring(true)
    setRestoreError('')
    setRestoreSuccess(null)
    try {
      const body: any = {}
      
      if (showCustomPorts) {
        // Validate custom ports
        const ports = {
          POSTGRES_PORT: parseInt(customPorts.POSTGRES_PORT),
          POOLER_PROXY_PORT_TRANSACTION: parseInt(customPorts.POOLER_PROXY_PORT_TRANSACTION)
        }
        
        // Check if all ports are valid numbers
        for (const [key, value] of Object.entries(ports)) {
          if (isNaN(value) || value < 1 || value > 65535) {
            setRestoreError(`Invalid port for ${key}: ${customPorts[key as keyof typeof customPorts]}. Must be a number between 1 and 65535.`)
            setRestoring(false)
            return
          }
        }
        
        body.customPorts = ports
        body.forceNewPorts = true
      } else {
        body.forceNewPorts = restoreWithNewPorts
      }

      const response = await fetch(`/api/projects/${selectedProject.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const data = await response.json()
      
      if (response.ok) {
        setRestoreSuccess({ 
          message: data.message || 'Project restored successfully', 
          newPorts: data.newPorts 
        })
        toast.success('Project restored', {
          description: data.message || 'Docker containers have been recreated.',
        })
      } else {
        let errorMsg = data.error || 'Failed to restore project'
        
        if (errorMsg.includes('ports are not available') || errorMsg.includes('bind')) {
          const portMatch = errorMsg.match(/(\d+):\s*bind/)
          if (portMatch) {
            errorMsg = `Port ${portMatch[1]} is blocked by another process.\n\nSuggestion: Use the "Custom Ports" option to specify different ports.`
          }
        }
        
        setRestoreError(errorMsg)
        toast.error('Restore failed', {
          description: errorMsg.replace(/\n/g, ' '),
        })
      }
    } catch (error) {
      setRestoreError('Failed to restore project. Please try again.')
      console.error('Restore project error:', error)
      toast.error('Error', {
        description: 'Failed to restore project',
      })
    } finally {
      setRestoring(false)
    }
  }

  const handleInlinePause = async (project: Project) => {
    setInlineActionLoading(project.id)
    try {
      const response = await fetch(`/api/projects/${project.id}/pause`, { method: 'POST' })
      if (response.ok) {
        toast.success('Project paused', { description: `${project.name} has been paused.` })
        await fetchProjects()
      } else {
        const data = await response.json()
        toast.error('Failed to pause', { description: data.error })
      }
    } catch {
      toast.error('Error', { description: 'Failed to pause project' })
    } finally {
      setInlineActionLoading(null)
    }
  }

  const handleInlineDeploy = async (project: Project) => {
    setInlineActionLoading(project.id)
    try {
      const response = await fetch(`/api/projects/${project.id}/deploy`, { method: 'POST' })
      if (response.ok || response.status === 202) {
        toast.success('Deployment started', { description: `${project.name} is deploying in the background...` })
        // Start polling for deploy status
        pollDeployStatus(project.id)
        await fetchProjects()
      } else {
        const data = await response.json()
        toast.error('Failed to deploy', { description: data.error })
      }
    } catch {
      toast.error('Error', { description: 'Failed to deploy project' })
    } finally {
      setInlineActionLoading(null)
    }
  }

  const pollDeployStatus = (projectId: string) => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/deploy-status`)
        if (!response.ok) {
          clearInterval(interval)
          return
        }
        const data = await response.json()
        
        if (data.deployStatus === 'done') {
          clearInterval(interval)
          toast.success('Deployment complete', { description: data.deployLog || 'All containers are running.' })
          await fetchProjects()
        } else if (data.deployStatus === 'failed') {
          clearInterval(interval)
          toast.error('Deployment failed', { description: data.deployLog || 'Check server logs for details.' })
          await fetchProjects()
        }
        // For 'pulling' and 'starting' — continue polling
      } catch {
        clearInterval(interval)
      }
    }, 5000) // Poll every 5 seconds
    
    // Safety: stop polling after 15 minutes
    setTimeout(() => clearInterval(interval), 15 * 60 * 1000)
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchProjects()
    setRefreshing(false)
  }

  const handleCopyUrl = async (url: string, label: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Copied!', {
        description: `${label} copied to clipboard.`,
      })
    } catch {
      toast.error('Failed to copy', {
        description: 'Unable to copy to clipboard.',
      })
    }
  }

  const toggleLinksDropdown = (projectId: string) => {
    setOpenLinksDropdown(openLinksDropdown === projectId ? null : projectId)
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (linksDropdownRef.current && !linksDropdownRef.current.contains(event.target as Node)) {
        setOpenLinksDropdown(null)
      }
    }
    if (openLinksDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [openLinksDropdown])

  const closeModal = () => {
    setSelectedProject(null)
    setShowDeleteConfirm(false)
    setShowRestoreConfirm(false)
    setRestoreError('')
    setRestoreSuccess(null)
    setRestoreWithNewPorts(false)
    setShowCustomPorts(false)
    setCustomPorts({
      POSTGRES_PORT: '',
      POOLER_PROXY_PORT_TRANSACTION: ''
    })
  }

  useEffect(() => {
    fetchProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedProject) {
      const fetchProjectInfo = async () => {
        try {
          const response = await fetch(`/api/projects/${selectedProject.id}/env`)
          if (response.ok) {
            const data = await response.json()
            const envVars = data.envVars || {}

            const disabledStr = envVars.DISABLED_MODULES || ''
            const disabledVars = disabledStr ? disabledStr.split(',') : []
            setProjectDisabledModules(disabledVars)

            const urls: Record<string, string> = {}
            const serverHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
            const serverProtocol = typeof window !== 'undefined' ? window.location.protocol : 'http:'
            const isLocal = serverHost === 'localhost' || serverHost === '127.0.0.1'
            
            if (selectedProject.slug && envVars.KONG_HTTP_PORT) {
              if (isLocal) {
                urls['API Gateway'] = `${serverProtocol}//${serverHost}:${envVars.KONG_HTTP_PORT}`
              } else {
                urls['API Gateway'] = `${serverProtocol}//${serverHost}/proxy/${selectedProject.slug}/kong`
              }
            }
            if (envVars.STUDIO_PORT && !disabledVars.includes('studio')) {
              if (isLocal) {
                urls['Supabase Studio'] = `${serverProtocol}//${serverHost}:${envVars.STUDIO_PORT}`
              } else {
                urls['Supabase Studio'] = `${serverProtocol}//${serverHost}/proxy/${selectedProject.slug}/studio`
              }
            }
            if (envVars.ANALYTICS_PORT && !disabledVars.includes('analytics')) {
              if (isLocal) {
                urls['Analytics'] = `${serverProtocol}//${serverHost}:${envVars.ANALYTICS_PORT}`
              } else {
                urls['Analytics'] = `${serverProtocol}//${serverHost}/proxy/${selectedProject.slug}/analytics`
              }
            }
            if (envVars.POSTGRES_PORT) {
              urls['Database'] = `postgresql://postgres:${envVars.POSTGRES_PASSWORD || 'password'}@${serverHost}:${envVars.POSTGRES_PORT}/postgres`
            }

            setProjectUrls(urls)
          }
        } catch (error) {
          console.error('Failed to fetch project info:', error)
        }
      }
      fetchProjectInfo()
    }
  }, [selectedProject])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div>Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="SupaConsole"
              width={150}
              height={150}
              className="object-contain"
            />
          </div>
          <Button variant="outline" onClick={handleLogout}>
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Logout
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {!initialized && projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[400px] text-center">
            <Card className="w-full max-w-md">
              <CardHeader>
                <CardTitle>Welcome to SupaConsole</CardTitle>
                <CardDescription>
                  Initialize your workspace to get started with managing Supabase projects
                </CardDescription>
              </CardHeader>
              <CardContent>
                {error && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-500 px-4 py-3 rounded mb-4">
                    {error}
                  </div>
                )}

                {initProgress && (
                  <div className="mb-4">
                    <div className="flex items-center gap-2 text-blue-500 mb-2">
                      <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
                      <span className="text-sm">{initProgress}</span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full animate-pulse" style={{ width: '45%' }}></div>
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleInitialize}
                  disabled={initializing}
                  className="w-full"
                >
                  {initializing ? 'Initializing...' : 'Initialize'}
                </Button>

                <p className="text-xs text-muted-foreground mt-3 text-center">
                  This will clone the Supabase repository (~500MB) and set up the workspace
                </p>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div>
            <div className="flex justify-between items-center mb-8">
              <div>
                <h2 className="text-3xl font-bold">Projects</h2>
                <p className="text-muted-foreground">Manage your Supabase projects</p>
              </div>
              <Button onClick={handleCreateProject}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Project
              </Button>
              {projects.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
                    <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                    {refreshing ? 'Refreshing...' : 'Refresh'}
                  </Button>
                  <Button variant="outline" onClick={handleUpdateAll}>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Update All
                  </Button>
                </div>
              )}
            </div>

            {projects.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <h3 className="text-lg font-medium mb-2">No projects yet</h3>
                  <p className="text-muted-foreground mb-4">
                    Create your first project to get started
                  </p>
                  <Button onClick={handleCreateProject}>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Create Project
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map((project) => {
                  const isRunning = project.status === 'active' || project.status === 'partially_running'
                  const isPaused = project.status === 'paused' || project.status === 'not_found'
                  const isDeploying = project.status === 'deploying'
                  
                  return (
                    <Card 
                      key={project.id} 
                      className="group hover:shadow-lg transition-shadow"
                    >
                      <CardHeader className="pb-3">
                        <div className="flex justify-between items-start">
                          <a
                            href={projectUrlsMap[project.id] && Object.keys(projectUrlsMap[project.id]).length > 0 ? Object.values(projectUrlsMap[project.id])[0] : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`text-lg font-semibold hover:underline flex items-center gap-1.5 ${projectUrlsMap[project.id] && Object.keys(projectUrlsMap[project.id]).length > 0 ? '' : ''}`}
                            onClick={(e) => {
                              if (!projectUrlsMap[project.id]) e.preventDefault()
                            }}
                          >
                            {project.name}
                            {projectUrlsMap[project.id] && Object.keys(projectUrlsMap[project.id]).length > 0 && (
                              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                            )}
                          </a>
                          
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div className={`px-2 py-1 rounded-full text-xs ${project.status === 'active' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' :
                                project.status === 'deploying' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse' :
                                project.status === 'paused' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' :
                                project.status === 'partially_running' ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400' :
                                project.status === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' :
                                project.status === 'created' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' :
                                'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                              }`}>
                              {project.status === 'deploying' ? `Deploying${project.deployStatus ? ` (${project.deployStatus})` : '...'}` :
                               project.status === 'partially_running' ? 'Partially Running' :
                               project.status === 'not_found' ? 'Not Setup' :
                               project.status.charAt(0).toUpperCase() + project.status.slice(1).replace('_', ' ')}
                            </div>
                            
                            {projectUrlsMap[project.id] && Object.keys(projectUrlsMap[project.id]).length > 0 && (
                              <div ref={linksDropdownRef} className="relative flex-shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 hover:bg-accent"
                                  onClick={() => toggleLinksDropdown(project.id)}
                                >
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                  </svg>
                                </Button>
                                {openLinksDropdown === project.id && (
                                  <div className="absolute right-0 top-9 z-50 w-64 bg-background border rounded-lg shadow-xl animate-in fade-in zoom-in-95 duration-100">
                                    <div className="p-1">
                                      <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                        Quick Links
                                      </div>
                                      {Object.entries(projectUrlsMap[project.id]).map(([name, url]) => (
                                        <div
                                          key={name}
                                          className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-accent rounded-md"
                                        >
                                          <a
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex-1 min-w-0 text-sm truncate hover:underline text-left"
                                          >
                                            {name}
                                          </a>
                                          <div className="flex items-center gap-0.5 flex-shrink-0">
                                            <button
                                              onClick={(e) => {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                handleCopyUrl(url, name)
                                              }}
                                              className="p-1 rounded hover:bg-muted/80 transition-colors"
                                              title="Copy URL"
                                            >
                                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                              </svg>
                                            </button>
                                            <a
                                              href={url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              onClick={(e) => e.stopPropagation()}
                                              className="p-1 rounded hover:bg-muted/80 transition-colors"
                                              title="Open in new tab"
                                            >
                                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                              </svg>
                                            </a>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        {project.description && (
                          <CardDescription>{project.description}</CardDescription>
                        )}
                      </CardHeader>
                      <CardContent>
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-muted-foreground">
                            {project.slug}
                          </span>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 hover:bg-accent"
                              onClick={(e) => { e.stopPropagation(); router.push(`/dashboard/projects/${project.id}/configure`) }}
                              title="Configure"
                            >
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                            
                            {isPaused && !isRunning && !isDeploying && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 hover:bg-green-500/10 hover:text-green-600 dark:hover:text-green-400"
                                onClick={(e) => { e.stopPropagation(); handleInlineDeploy(project) }}
                                disabled={inlineActionLoading === project.id}
                                title="Deploy"
                              >
                                {inlineActionLoading === project.id ? (
                                  <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                            
                            {isRunning && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 hover:bg-yellow-500/10 hover:text-yellow-600 dark:hover:text-yellow-400"
                                onClick={(e) => { e.stopPropagation(); handleInlinePause(project) }}
                                disabled={inlineActionLoading === project.id}
                                title="Pause"
                              >
                                {inlineActionLoading === project.id ? (
                                  <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Pause className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                            
                            {(project.status === 'error' || project.status === 'created') && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400"
                                onClick={(e) => { e.stopPropagation(); setSelectedProject(project); setShowRestoreConfirm(true) }}
                                title="Restore"
                              >
                                <RotateCw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                              onClick={(e) => { e.stopPropagation(); setSelectedProject(project); setShowDeleteConfirm(true) }}
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Project Management Modal */}
      {selectedProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-lg max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold">Manage Project</h3>
                <button
                  onClick={closeModal}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="mb-6">
                <h4 className="font-medium text-gray-900 dark:text-white mb-2">{selectedProject.name}</h4>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{selectedProject.description}</p>

                {projectDisabledModules.length > 0 && (
                  <div className="bg-green-500/10 border border-green-500/20 text-green-500 px-4 py-3 rounded text-sm mb-4">
                    🌿 Lightweight Mode — {projectDisabledModules.length} modules disabled, 
                    saving ~{(() => {
                      let savings = 0;
                      if (projectDisabledModules.includes('analytics') || projectDisabledModules.includes('vector')) savings += 1000;
                      if (projectDisabledModules.includes('edge-functions')) savings += 150;
                      if (projectDisabledModules.includes('imgproxy')) savings += 100;
                      if (projectDisabledModules.includes('realtime')) savings += 200;
                      return savings;
                    })()} MB RAM
                  </div>
                )}

                {/* Project URLs */}
                <div className="space-y-2">
                  <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300">Service URLs:</h5>
                  {Object.entries(projectUrls).map(([name, url]) => (
                    <div key={name} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded">
                      <span className="text-sm text-gray-600 dark:text-gray-400">{name}:</span>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-mono truncate max-w-xs"
                        title={url}
                      >
                        {url}
                        <svg className="w-3 h-3 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  ))}
                  {Object.keys(projectUrls).length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No active services found</p>
                  )}
                </div>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => router.push(`/dashboard/projects/${selectedProject.id}/configure`)}
                  className="flex-1"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Configure
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowRestoreConfirm(true)}
                  className="flex-1"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Restore
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex-1"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && selectedProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-lg max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delete Project</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">This action cannot be undone</p>
                </div>
              </div>

              <div className="mb-6">
                <p className="text-gray-700 dark:text-gray-300 mb-2">
                  Are you sure you want to delete <strong>{selectedProject.name}</strong>?
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  This will:
                </p>
                <ul className="text-sm text-gray-600 dark:text-gray-400 mt-1 ml-4 list-disc">
                  <li>Stop all running Docker containers</li>
                  <li>Remove all project files and data</li>
                  <li>Delete the project from the database</li>
                </ul>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1"
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDeleteProject}
                  className="flex-1"
                  disabled={deleting}
                >
                  {deleting ? (
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      Deleting...
                    </div>
                  ) : (
                    'Delete Project'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Update All Projects Modal */}
      {showUpdateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-lg max-w-md w-full mx-4">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  updating 
                    ? 'bg-blue-100 dark:bg-blue-900/20' 
                    : updateResult?.success 
                      ? 'bg-green-100 dark:bg-green-900/20' 
                      : 'bg-red-100 dark:bg-red-900/20'
                }`}>
                  {updating ? (
                    <div className="w-5 h-5 border-2 border-blue-600/30 border-t-blue-600 rounded-full animate-spin"></div>
                  ) : updateResult?.success ? (
                    <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {updating ? 'Updating Projects' : updateResult?.success ? 'Update Complete' : 'Update Failed'}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {updating ? 'Please wait...' : `${updateResult?.updated.length || 0} projects updated`}
                  </p>
                </div>
              </div>

              {updating && (
                <div className="mb-4">
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                    Updating supabase-core and syncing all projects...
                  </p>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full animate-pulse" style={{ width: '60%' }}></div>
                  </div>
                </div>
              )}

              {!updating && updateResult && (
                <div className="mb-6">
                  {updateResult.updated.length > 0 && (
                    <div className="mb-4">
                      <p className="text-sm font-medium text-green-600 dark:text-green-400 mb-2">
                        Successfully updated ({updateResult.updated.length}):
                      </p>
                      <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                        {updateResult.updated.map((name, i) => (
                          <li key={i} className="flex items-center gap-2">
                            <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            {name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {updateResult.failed.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                        Failed to update ({updateResult.failed.length}):
                      </p>
                      <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                        {updateResult.failed.map((item, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <svg className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            <div>
                              <span className="font-medium">{item.name}</span>
                              <p className="text-xs text-gray-500">{item.error}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={closeUpdateModal}
                  className="flex-1"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Restore Confirmation Modal */}
      {showRestoreConfirm && selectedProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-lg max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                  <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Restore Project</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Recreate Docker configuration</p>
                </div>
              </div>

              {!restoreSuccess ? (
                <>
                  <div className="mb-4">
                    <p className="text-gray-700 dark:text-gray-300 mb-2">
                      Are you sure you want to restore <strong>{selectedProject.name}</strong>?
                    </p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      This will:
                    </p>
                    <ul className="text-sm text-gray-600 dark:text-gray-400 mt-1 ml-4 list-disc">
                      <li>Stop all running containers</li>
                      <li>Recreate docker-compose.yml from supabase-core</li>
                      <li>Restore .env from database</li>
                      <li>Restart all containers</li>
                    </ul>
                  </div>

                  {/* Port Configuration Options */}
                  <div className="mb-4 space-y-3">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Port Configuration:</p>
                    
                    {!showCustomPorts ? (
                      <div className="space-y-2">
                        <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="portConfig"
                              checked={!restoreWithNewPorts && !showCustomPorts}
                              onChange={() => {
                                setRestoreWithNewPorts(false)
                                setShowCustomPorts(false)
                              }}
                              className="mt-1"
                            />
                            <div>
                              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                                Keep original ports
                              </p>
                              <p className="text-xs text-gray-600 dark:text-gray-400">
                                Use the ports saved in the database.
                              </p>
                            </div>
                          </label>
                        </div>

                        <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="portConfig"
                              checked={restoreWithNewPorts && !showCustomPorts}
                              onChange={() => {
                                setRestoreWithNewPorts(true)
                                setShowCustomPorts(false)
                              }}
                              className="mt-1"
                            />
                            <div>
                              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                                Auto-assign new ports
                              </p>
                              <p className="text-xs text-gray-600 dark:text-gray-400">
                                Let the system find available ports automatically.
                              </p>
                            </div>
                          </label>
                        </div>

                        <div className="p-3 bg-green-500/10 border border-green-500/20 rounded">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="portConfig"
                              checked={showCustomPorts}
                              onChange={() => {
                                setRestoreWithNewPorts(false)
                                setShowCustomPorts(true)
                              }}
                              className="mt-1"
                            />
                            <div>
                              <p className="text-sm font-medium text-green-600 dark:text-green-400">
                                Custom ports
                              </p>
                              <p className="text-xs text-gray-600 dark:text-gray-400">
                                Specify your own ports (recommended if ports are blocked).
                              </p>
                            </div>
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 bg-green-500/10 border border-green-500/20 rounded">
                        <p className="text-sm font-medium text-green-600 dark:text-green-400 mb-3">
                          Enter Custom Ports:
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-xs text-gray-600 dark:text-gray-400">PostgreSQL</label>
                            <input
                              type="number"
                              placeholder="e.g. 60000"
                              value={customPorts.POSTGRES_PORT}
                              onChange={(e) => setCustomPorts({...customPorts, POSTGRES_PORT: e.target.value})}
                              className="w-full mt-1 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600 dark:text-gray-400">Pooler</label>
                            <input
                              type="number"
                              placeholder="e.g. 60001"
                              value={customPorts.POOLER_PROXY_PORT_TRANSACTION}
                              onChange={(e) => setCustomPorts({...customPorts, POOLER_PROXY_PORT_TRANSACTION: e.target.value})}
                              className="w-full mt-1 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          Other ports will be auto-assigned automatically.
                        </p>
                        <button
                          onClick={() => setShowCustomPorts(false)}
                          className="mt-2 text-xs text-gray-500 hover:text-gray-700 underline"
                        >
                          Cancel custom ports
                        </button>
                      </div>
                    )}
                  </div>

                  {restoreError && (
                    <div className="mb-4 bg-red-500/10 border border-red-500/20 text-red-500 px-4 py-3 rounded text-sm whitespace-pre-line">
                      {restoreError}
                    </div>
                  )}

                  <div className="flex gap-3">
                    <Button
                      variant="outline"
                      onClick={closeModal}
                      className="flex-1"
                      disabled={restoring}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="default"
                      onClick={handleRestoreProject}
                      className="flex-1"
                      disabled={restoring || (showCustomPorts && (!customPorts.POSTGRES_PORT || !customPorts.POOLER_PROXY_PORT_TRANSACTION))}
                    >
                      {restoring ? (
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                          Restoring...
                        </div>
                      ) : (
                        'Restore Project'
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/20 flex items-center justify-center">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="font-medium text-green-600 dark:text-green-400">{restoreSuccess.message}</span>
                  </div>

                  {restoreSuccess.newPorts && (
                    <div className="bg-green-500/10 border border-green-500/20 rounded p-3">
                      <p className="text-sm font-medium text-green-600 dark:text-green-400 mb-2">Ports Changed:</p>
                      <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                        <li>PostgreSQL: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{restoreSuccess.newPorts.POSTGRES_PORT}</code></li>
                        <li>Pooler: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{restoreSuccess.newPorts.POOLER_PROXY_PORT_TRANSACTION}</code></li>
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={closeModal}
                  className="flex-1"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}