export function readSvgDimensions(svg: string) {
  const viewBox = svg.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
  const values = viewBox?.trim().split(/[\s,]+/).map(Number)
  if (values?.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
    return { width: values[2], height: values[3] }
  }

  const width = Number.parseFloat(svg.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1] ?? '')
  const height = Number.parseFloat(svg.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1] ?? '')
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : { width: 1200, height: 900 }
}
