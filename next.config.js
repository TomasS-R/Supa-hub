/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    turbo: {
      rules: {
        '*.ts': ['babel-loader'],
        '*.tsx': ['babel-loader'],
      },
    },
    externalDir: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config, { isServer }) => {
    config.module.rules.push({
      test: /\.tsx?$/,
      exclude: [/supabase-core/, /supabase-projects/],
    })
    return config
  },
}

module.exports = nextConfig
