import { resolveInlinePropertyDefinition, type InlinePropertyDefinitions, type InlinePropertyType } from './inline-property-definitions';
import { encodeVaultPropertyValue, type VaultPropertyValue } from './vault-property-codec';
import { getManagedYamlAliases } from './yaml-fields';
import { parseYaml } from 'obsidian';
import { splitFrontmatterDocument } from './file-task-template-merge';
import { isSupportedRawYamlPropertyValue, isWritableRawYamlPropertyName, rawYamlPropertyExpectationsEqual, readRawYamlPropertyExpectation, type RawYamlPropertyExpectation, type RawYamlPropertyValue } from './raw-yaml-property';
import type { KeyMapping } from '../types/settings';

export interface FileTaskPropertyChange {
 remove?: boolean;
 propertyName: string;
 nativeType?: InlinePropertyType;
 expected: RawYamlPropertyExpectation;
 value: RawYamlPropertyValue;
}

/** Read the real document rather than a potentially stale metadata-cache snapshot. */
export function readFileTaskPropertyDocument(content: string): { frontmatter: Record<string, unknown>; order: string[]; body: string } | null {
 const { frontmatter, body } = splitFrontmatterDocument(content);
 if (frontmatter === null) return null;
 try {
  const parsed: unknown = parseYaml(frontmatter + '\n');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const values = parsed as Record<string, unknown>;
  const order: string[] = [];
  for (const line of frontmatter.split(/\r?\n/)) {
   const match = line.match(/^((?:"(?:\\.|[^"])*"|'(?:''|[^'])*'|[^\s:#][^:]*)):(?:\s|$)/);
   if (!match) continue;
   const parsedKey: unknown = parseYaml(`${match[1]}: null`);
   const key = parsedKey && typeof parsedKey === 'object' && !Array.isArray(parsedKey) ? Object.keys(parsedKey)[0] : null;
   if (!key || order.includes(key)) return null;
   order.push(key);
  }
  if (Object.keys(values).some(key => !order.includes(key))) return null;
  return { frontmatter: values, order, body };
 } catch { return null; }
}

export function canApplyFileTaskPropertyChanges(frontmatter: Record<string, unknown>, changes: readonly FileTaskPropertyChange[], mappings: readonly KeyMapping[], definitions?: InlinePropertyDefinitions): boolean {
 const seen = new Set<string>();
 return changes.length > 0 && changes.every(change => {
  if (seen.has(change.propertyName.toLowerCase())) return false;
  seen.add(change.propertyName.toLowerCase());
  if (Object.keys(frontmatter).some(name => name !== change.propertyName && name.toLowerCase() === change.propertyName.toLowerCase())) return false;
  if (!isSupportedRawYamlPropertyValue(change.value)) return false;
  if (!isWritableRawYamlPropertyName(change.propertyName, mappings)) {
   const mapping = mappings.find(item => item.isSystem === false && [item.canonicalKey, item.visiblePropertyName].some(name => name.toLowerCase() === change.propertyName.toLowerCase()));
   if (!mapping || !change.nativeType) return false;
   const aliases = Object.keys(frontmatter).filter(name => [mapping.canonicalKey, mapping.visiblePropertyName].some(alias => alias.toLowerCase() === name.toLowerCase()));
   if (aliases.length > 1) return false;
   try {
    if (resolveInlinePropertyDefinition(change.propertyName, change.nativeType, mappings, definitions).encoding !== 'vault-v1') return false;
    encodeVaultPropertyValue(change.value as VaultPropertyValue, change.nativeType);
   } catch { return false; }
  }
  if (typeof change.value === 'number' && !Number.isFinite(change.value)) return false;
  if (Array.isArray(change.value) && change.value.some(value => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) return false;
  const current = readRawYamlPropertyExpectation(frontmatter, change.propertyName);
  return current !== null && rawYamlPropertyExpectationsEqual(current, change.expected);
 });
}

export function fileTaskPropertyIdentityMatches(frontmatter: Record<string, unknown>, operonId: string, mappings: readonly KeyMapping[]): boolean {
 const keys = getManagedYamlAliases('operonId', [...mappings]).filter(key => Object.prototype.hasOwnProperty.call(frontmatter, key));
 if (keys.length !== 1) return false;
 const value = frontmatter[keys[0]];
 return (typeof value === 'string' || typeof value === 'number') && String(value).trim() === operonId;
}
