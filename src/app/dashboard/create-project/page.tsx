'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function CreateProjectPage() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  const [optimizationMode, setOptimizationMode] = useState<'eco' | 'custom' | 'full'>('eco')
  const [customModules, setCustomModules] = useState({
    analytics: false,
    'edge-functions': false,
    imgproxy: false,
    realtime: false,
  })

  // Calculate estimated RAM savings (MB)
  const calculateSavings = () => {
    let savings = 0
    if (optimizationMode === 'eco') return 1450
    if (optimizationMode === 'full') return 0
    
    if (!customModules.analytics) savings += 1000
    if (!customModules['edge-functions']) savings += 150
    if (!customModules.imgproxy) savings += 100
    if (!customModules.realtime) savings += 200
    
    return savings
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleNameChange = (e: any) => {
    setName(e.target.value)
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDescriptionChange = (e: any) => {
    setDescription(e.target.value)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (!name.trim()) {
      setError('Project name is required')
      setLoading(false)
      return
    }

    // Prepare disabled modules array
    let disabledModules: string[] = []
    if (optimizationMode === 'eco') {
      disabledModules = ['analytics', 'vector', 'edge-functions', 'imgproxy', 'realtime']
    } else if (optimizationMode === 'custom') {
      if (!customModules.analytics) disabledModules.push('analytics', 'vector')
      if (!customModules['edge-functions']) disabledModules.push('edge-functions')
      if (!customModules.imgproxy) disabledModules.push('imgproxy')
      if (!customModules.realtime) disabledModules.push('realtime')
    }

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          name: name.trim(), 
          description: description.trim(),
          disabledModules 
        }),
      })

      if (response.ok) {
        const data = await response.json()
        // Redirect to project configuration page
        router.push(`/dashboard/projects/${data.project.id}/configure`)
      } else {
        const data = await response.json()
        setError(data.error || 'Failed to create project')
      }
    } catch {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
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
          <Link href="/dashboard">
            <Button variant="outline">Back to Dashboard</Button>
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <div className="mb-8">
            <h2 className="text-3xl font-bold mb-2">Create New Project</h2>
            <p className="text-muted-foreground">
              Set up a new Supabase project with Docker configuration
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Project Details</CardTitle>
              <CardDescription>
                Enter the basic information for your new Supabase project
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                {error && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-500 px-4 py-3 rounded">
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">Project Name *</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Enter project name"
                    value={name}
                    onChange={handleNameChange}
                    required
                  />
                  <p className="text-sm text-muted-foreground">
                    A unique identifier will be generated automatically
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Input
                    id="description"
                    type="text"
                    placeholder="Brief description of your project"
                    value={description}
                    onChange={handleDescriptionChange}
                  />
                </div>

                <div className="space-y-4 pt-4 border-t">
                  <div>
                    <h3 className="text-lg font-medium">Optimization Mode</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Select how you want to deploy this Supabase instance. Disabled modules will not be downloaded, saving disk and RAM.
                    </p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <label className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer transition-colors ${optimizationMode === 'eco' ? 'bg-green-500/10 border-green-500/50' : 'hover:bg-muted/50'}`}>
                      <input 
                        type="radio" 
                        name="optMode" 
                        value="eco" 
                        checked={optimizationMode === 'eco'} 
                        onChange={() => setOptimizationMode('eco')}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium text-green-500">🌱 Eco Mode (Recommended for testing/VPS)</div>
                        <div className="text-sm text-muted-foreground">Installs only Postgres, Auth, API, and Studio. Disables Analytics, Functions, Realtime, and Imgproxy to save ~1.4GB RAM.</div>
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer transition-colors ${optimizationMode === 'custom' ? 'bg-primary/5 border-primary/50' : 'hover:bg-muted/50'}`}>
                      <input 
                        type="radio" 
                        name="optMode" 
                        value="custom" 
                        checked={optimizationMode === 'custom'} 
                        onChange={() => setOptimizationMode('custom')}
                        className="mt-1"
                      />
                      <div className="w-full">
                        <div className="font-medium">⚙️ Custom Mode</div>
                        <div className="text-sm text-muted-foreground mb-3">Choose exactly which heavy modules you need.</div>
                        
                        {optimizationMode === 'custom' && (
                          <div className="grid gap-2 pl-2 border-l-2 ml-1 pb-2">
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input type="checkbox" checked={customModules.analytics} onChange={(e) => setCustomModules({...customModules, analytics: e.target.checked})} />
                              <span>Analytics & Logs (Logflare + Vector) <span className="text-muted-foreground ml-1">[-1GB RAM if OFF]</span></span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input type="checkbox" checked={customModules.realtime} onChange={(e) => setCustomModules({...customModules, realtime: e.target.checked})} />
                              <span>Realtime Server (Websockets) <span className="text-muted-foreground ml-1">[-200MB RAM if OFF]</span></span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input type="checkbox" checked={customModules['edge-functions']} onChange={(e) => setCustomModules({...customModules, 'edge-functions': e.target.checked})} />
                              <span>Edge Functions (Deno Runtime) <span className="text-muted-foreground ml-1">[-150MB RAM if OFF]</span></span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-sm">
                              <input type="checkbox" checked={customModules.imgproxy} onChange={(e) => setCustomModules({...customModules, imgproxy: e.target.checked})} />
                              <span>Image Transformation (Imgproxy) <span className="text-muted-foreground ml-1">[-100MB RAM if OFF]</span></span>
                            </label>
                          </div>
                        )}
                      </div>
                    </label>

                    <label className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer transition-colors ${optimizationMode === 'full' ? 'bg-destructive/10 border-destructive/50' : 'hover:bg-muted/50'}`}>
                      <input 
                        type="radio" 
                        name="optMode" 
                        value="full" 
                        checked={optimizationMode === 'full'} 
                        onChange={() => setOptimizationMode('full')}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium text-destructive">🔥 Full Mode (Heavy)</div>
                        <div className="text-sm text-muted-foreground">Installs the entire 14-container Supabase Enterprise suite. Requires at least 4GB RAM per project.</div>
                      </div>
                    </label>

                    {calculateSavings() > 0 && (
                      <div className="mt-2 text-sm font-semibold text-green-500 bg-green-500/10 p-3 rounded text-center border-green-500/20 border">
                        ✨ Module Configuration saving ~{calculateSavings()} MB of RAM per instance!
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-blue-500/10 border border-blue-500/20 text-blue-500 px-4 py-3 rounded">
                  <p className="text-sm">
                    <strong>Next steps:</strong> After creation, you&apos;ll configure environment variables 
                    and the system will automatically set up Docker containers for your project.
                  </p>
                </div>

                <div className="flex gap-4">
                  <Button type="submit" disabled={loading}>
                    {loading ? 'Creating Project...' : 'Create Project'}
                  </Button>
                  <Link href="/dashboard">
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </Link>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}