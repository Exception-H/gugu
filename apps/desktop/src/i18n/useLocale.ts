import { useSyncExternalStore } from 'react'
import type { LocalePreference } from './locale'
import {
  getLocaleSnapshot,
  i18n,
  setLocalePreference,
  subscribeLocale,
} from './runtime'

export function useLocale(): ReturnType<typeof getLocaleSnapshot> & {
  setPreference: (preference: LocalePreference) => void
} {
  const state = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  return { ...state, setPreference: setLocalePreference }
}


// Message rows use the same registered catalogs and locale store as the app. A fixed
// translator belongs to a locale/namespace, so it can be reused across every row and visit.
const translations = new Map<string, { t: ReturnType<typeof i18n.getFixedT> }>()

export function useSharedTranslation(namespace: string) {
  const { resolvedLocale } = useLocale()
  const key = `${resolvedLocale}:${namespace}`
  let translation = translations.get(key)
  if (!translation) {
    translation = { t: i18n.getFixedT(resolvedLocale, namespace) }
    translations.set(key, translation)
  }
  return translation
}
