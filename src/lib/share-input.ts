export function shareInputValue(value: string | undefined): number {
  return parseFloat(value || "1") || 0;
}
