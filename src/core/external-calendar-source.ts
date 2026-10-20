import type { ExternalCalendarSource } from '../types/settings';

/** Logical vault paths only; no filesystem or URL interpretation. */
export function isVaultCalendarPath(path: string, configDir = ''): boolean {
	const parts = path.split('/');
	return path.length > 0 && path === path.trim() && !/[\\:]/u.test(path) && !Array.from(path).some(char => char.charCodeAt(0) < 32)
		&& parts.every(part => part.length > 0 && part !== '..' && !part.startsWith('.'))
		&& /\.ics$/iu.test(path)
		&& path !== configDir && !path.startsWith(`${configDir}/`);
}

export function externalCalendarSourceAddress(source: ExternalCalendarSource): string {
	return source.sourceKind === 'vault-file' ? source.filePath ?? '' : source.url;
}

export function externalCalendarSourceIdentity(source: ExternalCalendarSource): string {
	return JSON.stringify([source.sourceKind ?? 'url', externalCalendarSourceAddress(source).trim()]);
}
