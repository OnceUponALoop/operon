export const pickerCalls: any[] = [];
export function openTaskFieldPicker(options: any) { pickerCalls.push(options); return () => options.onClose?.(); }
