// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useSharedTranslation } from '../../../../apps/desktop/src/i18n/react'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n/runtime'
import { createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let translators: Array<ReturnType<typeof useSharedTranslation>['t']>
function Label() {
  const { t } = useSharedTranslation('common')
  translators.push(t)
  return <span>{t('agentName.naming')}</span>
}
beforeEach(() => { setLocalePreference('zh-CN'); harness = createReactHarness(); translators = [] })
afterEach(() => harness.cleanup())
it('shares a locale-bound translator across rows and visits while updating mounted rows on locale changes', async () => {
  await harness.render(<><Label /><Label /></>)
  expect(translators[0]).toBe(translators[1])
  const chinese = translators[0]
  expect(harness.container.textContent).toBe('正在起名…正在起名…')
  await act(async () => { setLocalePreference('en-US') })
  expect(harness.container.textContent).toBe('Naming the agent…Naming the agent…')
  expect(translators.at(-1)).not.toBe(chinese)
  await act(async () => { setLocalePreference('zh-CN') })
  expect(translators.at(-1)).toBe(chinese)
  await harness.render(null)
  await harness.render(<Label />)
  expect(translators.at(-1)).toBe(chinese)
})
