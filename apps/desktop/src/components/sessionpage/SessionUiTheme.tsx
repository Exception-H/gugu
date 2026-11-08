import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ThemeProvider,
  UiPortalContainerProvider,
  usePortalThemeClass,
  useUiPortalContainer,
  type ThemeProviderProps,
} from '@gugu/session-ui/react/primitives'
import './SessionSettingsSection.css'

const CONTENTS = { display: 'contents' } as const
const THEMED = '.emlight, .emdark'

/**
 * The session page's theme for session-page components the shell draws itself, ❌ written on `<html>`.
 *
 * On `<html>`, `.emlight` / `.emdark` sits on the same element as the shell's `:root` / `[data-theme]` tokens, so
 * wherever both define a name (`--border`, `--background-*`, …) stylesheet order picked the winner and the session
 * page's values reached every shell element. The theme class moves to where these components are:
 *
 * - Content (the chat composer, permission band, assistant thread, phone transcript) sits in a `display: contents`
 *   wrapper (layout unchanged). Inside a themed ancestor — a chat drawn in the session page's mount, whose skin bridges
 *   the session palette to the shell's tokens — the wrapper adds nothing, as the far `<html>` class added nothing
 *   there before. Elsewhere (the phone, shell pages) the wrapper carries the class `<html>` used to carry.
 * - Popups portal out of the wrapper and get a themed layer of their own: by default a `display: contents` layer
 *   where they already portaled to (the surface's declared layer, else `document.body`), so stacking is what it was;
 *   with `skin` (the session-page parts of Settings, the phone App product page) the session page's skin and a
 *   fixed, zero-size layer right here, so they stay inside the dialog for focus, outside-press and inert, and are
 *   not clipped by its scroll area.
 */
export function SessionUiTheme({ theme, skin = false, children }: {
  theme: ThemeProviderProps['theme']
  skin?: boolean
  children: ReactNode
}) {
  return (
    <ThemeProvider theme={theme} target="none">
      {skin ? <SkinScope>{children}</SkinScope> : <ContentScope>{children}</ContentScope>}
    </ThemeProvider>
  )
}

function ContentScope({ children }: { children: ReactNode }) {
  const themeClass = usePortalThemeClass()
  const outer = useUiPortalContainer() ?? document.body
  const wrapper = useRef<HTMLDivElement>(null)
  const [inherited, setInherited] = useState(false)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => { setInherited(!!wrapper.current?.parentElement?.closest(THEMED)) }, [])
  return (
    <>
      <div ref={wrapper} className={inherited ? undefined : themeClass} style={CONTENTS}>
        <UiPortalContainerProvider value={layer ?? undefined}>{children}</UiPortalContainerProvider>
      </div>
      {createPortal(<div ref={setLayer} className={themeClass} style={CONTENTS} data-session-ui-popups="" />, outer)}
    </>
  )
}

function SkinScope({ children }: { children: ReactNode }) {
  const themeClass = usePortalThemeClass()
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  return (
    <div className={`${themeClass} gugu-skin`} style={CONTENTS}>
      <UiPortalContainerProvider value={layer ?? undefined}>{children}</UiPortalContainerProvider>
      <div ref={setLayer} className={`${themeClass} gugu-skin gg-session-settings-layer`} />
    </div>
  )
}
