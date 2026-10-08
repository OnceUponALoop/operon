import { OperonSettings } from '../types/settings';

function normalizeFolderPath(path: string | null | undefined): string {
	return (path ?? '').trim().replace(/^\/+|\/+$/g, '');
}

export function isPathInsideFolder(filePath: string, folderPath: string): boolean {
	const normalizedFilePath = filePath.trim().replace(/^\/+/, '');
	const normalizedFolderPath = normalizeFolderPath(folderPath);
	if (!normalizedFilePath || !normalizedFolderPath) return false;
	return normalizedFilePath === normalizedFolderPath || normalizedFilePath.startsWith(`${normalizedFolderPath}/`);
}

export function isOperonExcludedPath(filePath: string, settings: Pick<OperonSettings, 'fileTaskTemplateFolder' | 'excludedFolders'>): boolean {
	if (isPathInsideFolder(filePath, settings.fileTaskTemplateFolder)) return true;
	return (settings.excludedFolders ?? []).some(folderPath => isPathInsideFolder(filePath, folderPath));
}
