import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useToolbarPopup } from './useToolbarPopup'

export interface SelectOption {
  value: string
  label: string
  description?: string
}

interface Props {
  kind: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
  prefix?: string
}

export function StatusSelect({ kind, value, options, onChange, title, prefix }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useToolbarPopup(open, wrapRef, menuRef)

  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector('button')
    selected?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const dismiss = (): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab' || event.key === 'Escape') {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      // Tab continues to the neighbouring toolbar control from this trigger.
      dismiss()
      return
    }
    const items = Array.from(event.currentTarget.querySelectorAll('button'))
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      case 'ArrowDown': next = (i + 1) % items.length; break
      case 'ArrowUp': next = (i + items.length - 1) % items.length; break
      default: return
    }
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className={`status-select status-select-${kind}`} ref={wrapRef}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button ref={triggerRef} id={id} type="button" className="status-btn"
        title={title} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}>
        {prefix}{options.find((o) => o.value === value)?.label ?? value} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="status-menu" id={`${id}-menu`} role="menu" aria-labelledby={id} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {options.map((option, i) => (
            <button key={option.value} type="button" role="menuitemradio" tabIndex={-1}
              aria-label={option.label} aria-checked={option.value === value}
              aria-describedby={option.description ? `${id}-hint-${i}` : undefined}
              className={`status-menu-item${option.value === value ? ' active' : ''}`}
              onClick={() => {
                dismiss()
                if (option.value !== value) onChange(option.value)
              }}>
              <span className="status-option-label">{option.label}</span>
              {option.description && <small id={`${id}-hint-${i}`}>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
