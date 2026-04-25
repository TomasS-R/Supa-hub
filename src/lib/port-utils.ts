import { exec } from 'child_process'
import { promisify } from 'util'
import * as net from 'net'
import { prisma } from './db'

const execAsync = promisify(exec)

// Ports known to be problematic on Windows (reserved by Hyper-V, Docker, etc.)
const WINDOWS_RESERVED_PORTS = new Set([
    135, 136, 137, 138, 139, // NetBIOS
    445, // SMB
    500, 1701, 4500, // VPN
    3306, // MySQL
    5432, // PostgreSQL (often reserved)
    54320, 54321, 54322, 54323, 54324, 54325, // Common Supabase/Docker ports
    50000, 50001, // Docker
    30000, 30001, 30002, 30003, 30004, 30005, // Docker exposed ports
    80, 443, // HTTP/HTTPS
    22, // SSH
    3389, // RDP
    5985, 5986, // WinRM
    8080, 8443, // Common web
    6379, // Redis
    27017, // MongoDB
    11211, // Memcached
])

/**
 * Check if a specific port is available on the system
 * @param port - The port number to check
 * @returns Promise<boolean> - true if port is available, false if occupied
 */
export async function isPortAvailable(port: number): Promise<boolean> {
    // Skip known Windows reserved ports
    if (WINDOWS_RESERVED_PORTS.has(port)) {
        return false
    }

    return new Promise((resolve) => {
        const server = net.createServer()

        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false) // Port is in use
            } else {
                resolve(false) // Other error, assume port is not available
            }
        })

        server.once('listening', () => {
            server.close(() => {
                resolve(true) // Port is available
            })
        })

        server.listen(port, '0.0.0.0')
    })
}

/**
 * Find an available port starting from a given port number
 * @param startPort - The port number to start searching from
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns Promise<number> - The first available port found
 * @throws Error if no available port is found within maxAttempts
 */
export async function findAvailablePort(
    startPort: number,
    maxAttempts: number = 100
): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i
        const available = await isPortAvailable(port)

        if (available) {
            return port
        }
    }

    throw new Error(
        `Could not find an available port after checking ${maxAttempts} ports starting from ${startPort}`
    )
}

/**
 * Get ports that are already assigned to SupaConsole projects from the database
 * @returns Promise<Set<number>> - Set of port numbers already in use by projects
 */
export async function getUsedPortsFromDatabase(): Promise<Set<number>> {
    const usedPorts = new Set<number>()

    try {
        // Query all environment variables that contain port assignments
        const portEnvVars = await prisma.projectEnvVar.findMany({
            where: {
                key: {
                    in: [
                        'KONG_HTTP_PORT',
                        'KONG_HTTPS_PORT',
                        'STUDIO_PORT',
                        'ANALYTICS_PORT',
                        'POSTGRES_HOST_PORT',
                        'POOLER_PROXY_PORT_TRANSACTION',
                    ],
                },
            },
            select: {
                value: true,
            },
        })

        // Extract port numbers from the values
        for (const envVar of portEnvVars) {
            const port = parseInt(envVar.value, 10)
            if (!isNaN(port) && port > 0) {
                usedPorts.add(port)
            }
        }
    } catch (error) {
        console.warn('Could not query database for used ports:', error)
    }

    return usedPorts
}


/**
 * Find multiple unique available ports
 * @param portConfigs - Array of {name, startPort} configurations
 * @param reservedPorts - Optional set of ports that are already reserved (e.g., from database)
 * @returns Promise<Record<string, number>> - Object mapping names to available ports
 */
export async function findAvailablePorts(
    portConfigs: Array<{ name: string; startPort: number }>,
    reservedPorts: Set<number> = new Set()
): Promise<Record<string, number>> {
    const result: Record<string, number> = {}
    const usedPorts = new Set<number>(reservedPorts)

    for (const config of portConfigs) {
        let port = config.startPort
        let attempts = 0
        const maxAttempts = 200 // Increased to find more available ports

        while (attempts < maxAttempts) {
            // Skip if we've already assigned this port in this batch or it's reserved
            if (usedPorts.has(port)) {
                port++
                attempts++
                continue
            }

            const available = await isPortAvailable(port)

            if (available) {
                result[config.name] = port
                usedPorts.add(port)
                break
            }

            port++
            attempts++
        }

        if (!result[config.name]) {
            throw new Error(
                `Could not find an available port for ${config.name} after ${maxAttempts} attempts`
            )
        }
    }

    return result
}

/**
 * Get a list of currently used ports on the system (Windows-specific using netstat)
 * This is a fallback method for additional verification
 */
export async function getUsedPorts(): Promise<number[]> {
    try {
        const isWindows = process.platform === 'win32'
        const command = isWindows
            ? 'netstat -ano | findstr LISTENING'
            : 'netstat -tuln | grep LISTEN'

        const { stdout } = await execAsync(command)
        const ports: number[] = []

        // Parse netstat output to extract port numbers
        const lines = stdout.split('\n')
        for (const line of lines) {
            const match = isWindows
                ? line.match(/:(\d+)\s/)  // Windows format
                : line.match(/:(\d+)\s/)  // Unix format

            if (match && match[1]) {
                const port = parseInt(match[1], 10)
                if (!isNaN(port) && !ports.includes(port)) {
                    ports.push(port)
                }
            }
        }

        return ports
    } catch (error) {
        console.warn('Could not get used ports via netstat:', error)
        return []
    }
}
