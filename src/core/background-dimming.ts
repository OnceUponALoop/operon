export const BACKGROUND_DIMMING_OPTIONS = [50, 60, 70, 80, 90] as const;
export function normalizeBackgroundDimming(value: unknown): number {
 return typeof value === 'number' && BACKGROUND_DIMMING_OPTIONS.some(option => option === value) ? value : 70;
}
