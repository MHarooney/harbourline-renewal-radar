import { defineConfig } from 'vitest/config'

// GitHub Pages serves from /<repo>/ — update if the repo name changes.
export default defineConfig({
  base: '/harbourline-renewal-radar/',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
