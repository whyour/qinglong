import * as monaco from 'monaco-editor';

interface FileTypeConfig {
  extensions?: string[];      // 文件扩展名
  filenames?: string[];      // 完整文件名
  patterns?: RegExp[];       // 文件名正则匹配
  startsWith?: string[];     // 文件名前缀匹配
  endsWith?: string[];       // 文件名后缀匹配
}

// 文件类型分类配置（只包含特殊文件类型）
const fileTypeConfigs: Record<string, FileTypeConfig> = {
  // 前端特殊文件
  frontend: {
    extensions: [
      '.json5',    // JSON5
      '.vue',      // Vue
      '.svelte',   // Svelte
      '.astro',    // Astro
      '.wxss',     // 微信小程序样式
      '.pcss',     // PostCSS
      '.acss',     // 支付宝小程序样式
    ],
    patterns: [
      /\.env\.(local|development|production|test)$/,
      /\.module\.(css|less|scss|sass)$/,
      /\.d\.ts$/,
      /\.config\.(js|ts|json)$/,
    ],
  },

  // 小程序相关
  miniprogram: {
    extensions: [
      '.wxml',     // 微信小程序
      '.wxs',      // 微信小程序
      '.axml',     // 支付宝小程序
      '.sjs',      // 支付宝小程序
      '.swan',     // 百度小程序
      '.ttml',     // 字节跳动小程序
      '.ttss',     // 字节跳动小程序
      '.wxl',      // 微信小程序语言包
      '.qml',      // QQ小程序
      '.qss',      // QQ小程序
      '.ksml',     // 快手小程序
      '.kss',      // 快手小程序
    ],
  },

  // 开发工具相关
  devtools: {
    extensions: [
      '.prisma',   // Prisma
      '.mdx',      // MDX
      '.swagger',  // Swagger
      '.openapi',  // OpenAPI
    ],
  },

  // 锁文件
  lock: {
    filenames: [
      'yarn.lock',
      'pnpm-lock.yaml',
      'package-lock.json',
      'composer.lock',
      'Gemfile.lock',
      'poetry.lock',
      'Cargo.lock',
    ],
  },

  // 无后缀配置文件
  noExtension: {
    filenames: [
      '.dockerignore',
      '.gitignore',
      '.npmignore',
      '.browserslistrc',
      '.czrc',
      '.huskyrc',
      '.lintstagedrc',
      '.nvmrc',
      '.gcloudignore',
      '.htaccess',
    ],
    patterns: [
      /^\.env\./,
    ],
  },

  // CI/CD 配置
  cicd: {
    patterns: [
      /^\.github\/workflows\/.*\.yml$/,
      /^\.gitlab\/.*\.yml$/,
      /^\.circleci\/.*\.yml$/,
    ],
  },
};

/**
 * 检查文件是否可以在 Monaco 编辑器中预览
 * @param fileName 文件名
 * @returns boolean
 */
export function canPreviewInMonaco(fileName: string): boolean {
  if (!fileName) return false;
  
  // 获取 Monaco 支持的语言
  const supportedLanguages = monaco.languages.getLanguages();
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const lowercaseFileName = fileName.toLowerCase();

  // 检查 Monaco 原生支持
  if (supportedLanguages.some((lang) => 
    lang.extensions?.includes(ext) || 
    (lang.filenames?.includes(lowercaseFileName))
  )) {
    return true;
  }

  // 检查额外支持的文件类型
  return Object.values(fileTypeConfigs).some(config => {
    return (
      (config.extensions?.includes(ext)) ||
      (config.filenames?.includes(lowercaseFileName)) ||
      (config.patterns?.some(pattern => pattern.test(lowercaseFileName))) ||
      (config.startsWith?.some(prefix => lowercaseFileName.startsWith(prefix))) ||
      (config.endsWith?.some(suffix => lowercaseFileName.endsWith(suffix)))
    );
  });
}

/**
 * 获取文件类型分类
 * @param fileName 文件名
 * @returns string 文件类型分类名称
 */
export function getFileCategory(fileName: string): string {
  if (!fileName) return 'unknown';
  
  const lowercaseFileName = fileName.toLowerCase();
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

  for (const [category, config] of Object.entries(fileTypeConfigs)) {
    if (
      (config.extensions?.includes(ext)) ||
      (config.filenames?.includes(lowercaseFileName)) ||
      (config.patterns?.some(pattern => pattern.test(lowercaseFileName))) ||
      (config.startsWith?.some(prefix => lowercaseFileName.startsWith(prefix))) ||
      (config.endsWith?.some(suffix => lowercaseFileName.endsWith(suffix)))
    ) {
      return category;
    }
  }

  // 检查 Monaco 原生支持
  const supportedLanguages = monaco.languages.getLanguages();
  if (supportedLanguages.some((lang) => 
    lang.extensions?.includes(ext) || 
    (lang.filenames?.includes(lowercaseFileName))
  )) {
    return 'monaco-native';
  }

  return 'unknown';
}
