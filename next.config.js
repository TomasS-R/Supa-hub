/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.tsx?$/,
      exclude: [/supabase-core/, /supabase-projects/],
    })
    return config
  },
}

module.exports = nextConfig
