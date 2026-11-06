import type { PropsWithChildren } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './runtime'
import { useLocale } from './useLocale'

export function LocalizationProvider({ children }: PropsWithChildren) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
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
