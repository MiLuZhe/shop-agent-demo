import { useEffect, useId, useRef, type ReactNode } from 'react';
import './dialog.css';

export function Dialog({ title, busy = false, onClose, children }: { title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="app-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (event.target === ref.current && !busy) onClose(); }}>
    <div className="app-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="app-dialog-close" aria-label="关闭弹窗" disabled={busy} onClick={onClose}>×</button></div>
    <div className="app-dialog-body">{children}</div>
  </dialog>;
}
