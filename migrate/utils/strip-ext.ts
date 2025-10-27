export const stripExt = (name: string, { all = false } = {}) => {
  if (typeof name !== 'string') return name
  if (all) {
    if (name.startsWith('.')) {
      return name.replace(/^(\.[^.]+)(?:\.[^.]+)+$/, '$1')
    }
    return name.replace(/^([^\.]+)(?:\.[^.]+)+$/, '$1')
  }
  return name.replace(/^(.+?)(\.[^.]+)$/, '$1')
}
