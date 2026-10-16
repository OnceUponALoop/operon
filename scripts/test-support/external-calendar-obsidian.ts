export * from './obsidian';
import { App, Setting as BaseSetting } from './obsidian';

export class AbstractInputSuggest<T> {
 constructor(public app: App, ..._args: unknown[]) {}
 close(): void {}
}

export const calendarControls = new Map<string, any>();
export class Setting extends BaseSetting {
 private name = '';
 setName(name = ''): this { this.name = name; return this; }
 private addControl(callback: (control: any) => unknown): this {
  const control: any = {
   value: '', disabled: false, options: {}, inputEl: { addClass() {}, type: '', min: '', max: '' },
   setValue(value: unknown) { this.value = value; return this; },
   setPlaceholder() { return this; }, setIcon() { return this; },
   addOption(key: string, label: string) { this.options[key] = label; return this; },
   setDisabled(value: boolean) { this.disabled = value; return this; },
   onChange(handler: (value: unknown) => void) { this.change = handler; return this; },
   onClick(handler: () => void) { this.click = handler; return this; },
  };
  callback(control); calendarControls.set(this.name + (control.click ? ':sync' : ''), control); return this;
 }
 addText(callback: (control: any) => unknown): this { return this.addControl(callback); }
 addDropdown(callback: (control: any) => unknown): this { return this.addControl(callback); }
 addToggle(callback: (control: any) => unknown): this { return this.addControl(callback); }
 addExtraButton(callback: (control: any) => unknown): this { return this.addControl(callback); }
}
