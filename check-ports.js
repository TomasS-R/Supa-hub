const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkPorts() {
    try {
        const projects = await prisma.project.findMany({
            include: {
                envVars: {
                    where: {
                        key: {
                            in: [
                                'KONG_HTTP_PORT',
                                'KONG_HTTPS_PORT',
                                'STUDIO_PORT',
                                'ANALYTICS_PORT',
                                'POSTGRES_PORT',
                                'POOLER_PROXY_PORT_TRANSACTION',
                            ],
                        },
                    },
                },
            },
        });

        console.log('\n=== Projects and their assigned ports ===\n');

        for (const project of projects) {
            console.log(`Project: ${project.name} (${project.slug})`);
            console.log(`Status: ${project.status}`);
            console.log('Ports:');

            for (const envVar of project.envVars) {
                console.log(`  ${envVar.key}: ${envVar.value}`);
            }

            console.log('');
        }

        // Get all used ports
        const allPorts = new Set();
        for (const project of projects) {
            for (const envVar of project.envVars) {
                const port = parseInt(envVar.value, 10);
                if (!isNaN(port)) {
                    allPorts.add(port);
                }
            }
        }

        console.log('All ports in use:', Array.from(allPorts).sort((a, b) => a - b));

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

checkPorts();
