const lower = value => String(value ?? '').toLowerCase()
const identity = value => lower(value).replace(/@.*$/, '')

function phoneTerms(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '')
  if (!digits) return []
  const terms = new Set([digits])
  if (digits.startsWith('0')) terms.add(`972${digits.slice(1)}`)
  if (digits.startsWith('972')) terms.add(`0${digits.slice(3)}`)
  return [...terms]
}

export function searchQuery(value) {
  const term = lower(value).trim()
  const id = identity(value).trim()
  return { term, id, phones: phoneTerms(id || term) }
}

export function createSearchIndexer() {
  const cache = new WeakMap()
  return item => {
    // Read only searchable properties, so receipts and typing do not invalidate
    // the Vue computed search index. Cache normalization for unchanged records.
    const fields = [item.name, item.lastMessage, item.jid, item.displayJid, item.phoneNumber]
    const old = cache.get(item)
    if (old && fields.every((value, index) => value === old.fields[index])) return old
    const identities = fields.slice(2).filter(Boolean).map(identity)
    const phones = [...new Set(identities.flatMap(phoneTerms))]
    const entry = {
      item, fields, name: lower(item.name), preview: lower(item.lastMessage), identities, phones,
      keys: [...new Set([...identities, ...phones.map(phone => `phone:${phone}`)])]
    }
    cache.set(item, entry)
    return entry
  }
}

export function matchesSearch(entry, query) {
  return !query.term || entry.name.includes(query.term) || entry.preview.includes(query.term)
    || Boolean(query.id) && entry.identities.some(id => id.includes(query.id))
    || query.phones.some(term => entry.phones.some(phone => phone.includes(term)))
}
