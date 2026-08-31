export function capSchemaMaxLength(value, cap = 2_000) {
  if (Array.isArray(value)) {
    for (const item of value) capSchemaMaxLength(item, cap)
    return value
  }
  if (!value || typeof value !== 'object') return value
  for (const [key, child] of Object.entries(value)) {
    if (key === 'maxLength' && typeof child === 'number' && child > cap) value[key] = cap
    else capSchemaMaxLength(child, cap)
  }
  return value
}
