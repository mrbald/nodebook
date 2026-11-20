import { useLayoutEffect, type RefObject } from 'react'

/** Keep a toolbar popup beside its trigger even when the controls wrap against a pane edge. */
export function useToolbarPopup(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const popup = popupRef.current
    const bar = anchor?.closest('.graph-toolbar, .status-bar')
    if (!open || !anchor || !popup || !bar) return
    const pane = bar.closest('.editor-pane') ?? bar.parentElement
    const position = (): void => {
      const control = anchor.getBoundingClientRect()
      const bounds = bar.getBoundingClientRect()
      const left = Math.max(0, bounds.left) + 2
      const right = Math.min(window.innerWidth, bounds.right) - 2
      const available = Math.max(0, right - left)
      popup.style.setProperty('--popup-width', `${available}px`)
      const width = popup.getBoundingClientRect().width
      const preferred = anchor.closest('.graph-controls') ? control.left : control.right - width
      popup.style.left = `${Math.max(left, Math.min(preferred, right - width)) - control.left}px`
      const ceiling = Math.max(0, pane?.getBoundingClientRect().top ?? 0)
      popup.style.maxHeight = `${Math.max(0, control.top - ceiling - 6)}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(bar)
    observer.observe(anchor)
    observer.observe(popup)
    if (pane) observer.observe(pane)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [open, anchorRef, popupRef])
}
