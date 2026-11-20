import { useEffect, useState } from 'react'
import { DISTILL_FOCUS_MAX, type DistillDocument, type DistillEstimate } from '@shared/types'
import { EncodingPreview } from './EncodingPreview'
import { Prompt, type PromptPreset } from './Prompt'

type Preview = {
  selection: string
} & ({ estimate: DistillEstimate } | { error: string })

export function ImportPrompt({ document, presets, onConfirm, onCancel }: {
  document: DistillDocument
  presets: PromptPreset[]
  onConfirm: (focus: string, encoding?: string, estimate?: DistillEstimate) => void
  onCancel: () => void
}): React.JSX.Element {
  const [selection, setSelection] = useState('')
  const [result, setResult] = useState<Preview | null>(null)
  const options = document.encodingOptions
  useEffect(() => {
    if (!options) return
    let current = true
    void window.nodebook.distillEstimate(document.id, '', selection || undefined).then(
      (estimate) => { if (current) setResult({ selection, estimate }) },
      (error: unknown) => {
        if (current) setResult({ selection, error: error instanceof Error ? error.message : String(error) })
      }
    )
    return () => { current = false }
  }, [document.id, options, selection])
  const current = result?.selection === selection ? result : null
  const estimate = current && 'estimate' in current ? current.estimate : undefined
  return (
    <Prompt title="What should the notes focus on? (optional)"
      placeholder="e.g. the arguments and the evidence for them" confirmLabel="Distill"
      presets={presets} maxLength={DISTILL_FOCUS_MAX} allowEmpty
      confirmDisabled={!!options && !estimate}
      onConfirm={(value) => onConfirm(value, selection || undefined, estimate)} onCancel={onCancel}>
      {options && <EncodingPreview options={options} selection={selection} onChange={(value) => {
        setResult(null)
        setSelection(value)
      }}
        detectedLabel={estimate?.encoding?.label} preview={estimate?.encoding?.preview}
        uncertain={estimate?.encoding?.uncertain} pending={!current}
        error={current && 'error' in current ? current.error : undefined} />}
    </Prompt>
  )
}
