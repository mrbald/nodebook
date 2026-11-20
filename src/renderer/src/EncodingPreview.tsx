interface EncodingPreviewProps {
  options: readonly { name: string; label: string }[]
  selection: string
  onChange: (encoding: string) => void
  detectedLabel?: string
  preview?: string
  uncertain?: boolean
  pending?: boolean
  disabled?: boolean
  error?: string
}

export function EncodingPreview({
  options, selection, onChange, detectedLabel, preview, uncertain, pending, disabled, error
}: EncodingPreviewProps): React.JSX.Element {
  return (
    <div className="encoding-preview">
      <label>
        Text encoding
        <select value={selection} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
          <option value="">{!selection && detectedLabel ? `Automatic · ${detectedLabel}` : 'Automatic'}</option>
          {options.map(({ name, label }) => <option key={name} value={name}>{label}</option>)}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : pending ? <p role="status">Reading preview…</p> : (
        <>
          {uncertain && <p role="status">The encoding is uncertain. Check the text below or choose another encoding.</p>}
          {preview && <pre aria-label="Decoded text preview" dir="auto">{preview}</pre>}
        </>
      )}
    </div>
  )
}
