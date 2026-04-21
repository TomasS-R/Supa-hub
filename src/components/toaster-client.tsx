'use client'

import { Toaster as ToasterBase } from 'vibe-toast'
import type { ToasterProps } from 'vibe-toast'

export function Toaster(props: ToasterProps) {
  return <ToasterBase {...props} />
}
