import { t } from './i18n';

export type FileTaskTitleChangeMode = 'keep' | 'ask';

export interface FileTaskRenameSuggestion {
	filename: string;
	error?: string;
}

export function sanitizeTaskFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

export function deriveTaskFilename(title: string): string {
	const filename = title.trim().toLowerCase()
		.replace(/[\s\p{P}]+/gu, '-')
		.replace(/[^\p{L}\p{N}-]/gu, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
	return sanitizeTaskFilename(filename);
}

/** Called only after an Operon UI title edit has committed, never by index refresh. */
export async function filenameSuggestionAfterTitleEdit(
	title: string,
	basename: string,
	mode: FileTaskTitleChangeMode,
): Promise<FileTaskRenameSuggestion | null> {
	if (mode !== 'ask' || !title.trim()) return null;
	const filename = deriveTaskFilename(title);
	if (!filename) return {
		filename: basename,
		error: t('taskEditor', 'fileTaskFilenameFallback', { filename: `${basename}.md` }),
	};
	if (filename === basename) return null;
	return { filename };
}
