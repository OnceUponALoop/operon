// Use a real YAML codec for native property persistence tests; never bundled into the plugin.
export * from './obsidian';
export { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
