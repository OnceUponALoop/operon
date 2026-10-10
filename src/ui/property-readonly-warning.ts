import { t } from '../core/i18n';
import type { NativePropertyReadOnlyReason } from '../core/task-editor-native-properties';
import { setAccessibleLabelWithoutTooltip } from './accessibility-label';
import { bindOperonHoverTooltip } from './operon-hover-tooltip';

export function propertyReadOnlyWarningText(name: string, reason: NativePropertyReadOnlyReason): string {
 const key = reason === 'automatic' ? 'filePropertyAutomatic' : reason === 'type-conflict'
  ? 'filePropertyTypeConflict' : reason === 'unsupported' ? 'filePropertyUnsupported' : 'filePropertyUnavailable';
 return t('taskEditor', key, { name });
}

export function bindPropertyReadOnlyWarning(
 target: HTMLElement, name: string, reason: NativePropertyReadOnlyReason,
 taskColor: string | null | (() => string | null) = null,
): void {
 const content = propertyReadOnlyWarningText(name, reason);
 setAccessibleLabelWithoutTooltip(target, content);
 bindOperonHoverTooltip(target, { content, taskColor });
}
