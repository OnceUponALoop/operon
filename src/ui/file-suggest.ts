import { AbstractInputSuggest, App, TFile } from 'obsidian';

interface FileSuggestOptions {
	files?: () => TFile[];
	filter?: (file: TFile) => boolean;
}

export class FileSuggest extends AbstractInputSuggest<TFile> {
	private selectCallback: (file: TFile) => void;
	private textInputEl: HTMLInputElement;
	private files: () => TFile[];
	private filter: (file: TFile) => boolean;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		selectCallback: (file: TFile) => void,
		options: FileSuggestOptions = {},
	) {
		super(app, inputEl);
		this.textInputEl = inputEl;
		this.selectCallback = selectCallback;
		this.files = options.files ?? (() => this.app.vault.getMarkdownFiles());
		this.filter = options.filter ?? (() => true);
	}

	getSuggestions(query: string): TFile[] {
		const lowerQuery = query.toLowerCase();
		const files: TFile[] = [];
		for (const f of this.files()) {
			if (!this.filter(f)) continue;
			if (!lowerQuery || f.path.toLowerCase().includes(lowerQuery) || f.basename.toLowerCase().includes(lowerQuery)) {
				files.push(f);
			}
		}
		files.sort((a, b) => a.path.localeCompare(b.path));
		return files.slice(0, 20);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.textInputEl.value = file.path;
		this.textInputEl.trigger('input');
		this.selectCallback(file);
		this.close();
	}
}
