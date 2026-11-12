import { expect, it } from 'vitest'
import { getPrNumber } from '@/session/shared/core/pull-requests/pull-requests'
import { parseRepositoryRef } from '@/session/shared/repository-ref'
import { extensionOf, mimeTypeFromName } from '@gugu/core/shared/imageMime.mjs'
import { renderAssistantRule } from '@gugu/core/shared/assistantRulesFormat'
import { isTransientNetworkError } from '@gugu/core/shared/networkError'
import { LifecycleMap } from '@gugu/session-shared/lifecycle-map'
import { ok } from '@gugu/session-shared/result'

it('does not parse partial or invalid PR numbers',()=>{for(const identifier of ['#12oops','#0','-1','##7','#9007199254740993']) expect(getPrNumber({identifier})).toBeNull();expect(getPrNumber({identifier:'#12'})).toBe(12)})
