export function getYearOptions(): number[] {
  const currentYear = new Date().getFullYear()
  return Array.from(
    { length: currentYear - 1950 + 1 },
    (_, i) => currentYear - i
  )
}
