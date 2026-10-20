export const BACKGROUND_DIMMING_OPTIONS = [10, 20, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90] as const;
export function normalizeBackgroundDimming(value: unknown): number {
 return typeof value === 'number' && BACKGROUND_DIMMING_OPTIONS.some(option => option === value) ? value : 50;
}
