import { useEffect, useRef, type ReactNode } from 'react';

export function ManageDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="manage-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <button type="button" className="manage-dialog-close" aria-label="关闭弹窗" onClick={onClose}>×</button>
    {children}
  </dialog>;
}
