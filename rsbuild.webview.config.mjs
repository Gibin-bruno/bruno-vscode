import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { pluginStyledComponents } from '@rsbuild/plugin-styled-components';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill';

export default defineConfig({
  plugins: [
    pluginNodePolyfill(),
    // React is aliased to preact/compat below; React Fast Refresh does not work with Preact
    pluginReact({ fastRefresh: false }),
    pluginStyledComponents(),
    pluginSass(),
    pluginBabel({
      include: /\.(?:jsx?|tsx?)$/
    })
  ],
  source: {
    entry: {
      index: './src/webview/index.tsx',
      simple: './src/webview/simple/index.tsx'
    }
  },
  resolve: {
    alias: {
      // Webview path aliases
      components: './src/webview/components',
      providers: './src/webview/providers',
      hooks: './src/webview/hooks',
      utils: './src/webview/utils',
      themes: './src/webview/themes',
      assets: './src/webview/assets',
      selectors: './src/webview/selectors',
      ui: './src/webview/ui',
      views: './src/webview/views',
      // Run the webview on Preact via its React compatibility layer
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-runtime',
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom/client': 'preact/compat/client',
      'react-dom$': 'preact/compat',
      'react$': 'preact/compat',
      // @usebruno package shims for browser compatibility
      '@usebruno/common/utils': './src/webview/shims/bruno-common-utils.ts',
      '@usebruno/converters': './src/webview/shims/bruno-converters.ts',
      '@usebruno/graphql-docs': './src/webview/shims/bruno-graphql-docs.tsx'
    }
  },
  output: {
    distPath: {
      root: 'dist/webview'
    },
    assetPrefix: 'auto',
    cleanDistPath: true,
    filename: {
      js: '[name].js',
      css: '[name].css'
    },
    cssModules: {
      localIdentName: '[local]'
    }
  },
  html: {
    template: './src/webview/index.html'
  },
  dev: {
    port: 3000
  },
  performance: {
    chunkSplit: {
      strategy: 'split-by-experience'
    }
  }
});
