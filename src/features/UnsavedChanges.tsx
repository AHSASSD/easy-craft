import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Modal } from '../components/Modal';

type Editor = { dirty: boolean; save(): Promise<void>; discard(): void };
const Context = createContext<{
  register(id: string, editor: Editor | null): void;
  navigate(action: () => void): void;
} | null>(null);
export function useEditor(editor: Editor) {
  const context = useContext(Context);
  const id = useId();
  const { dirty, save, discard } = editor;
  useEffect(() => {
    context?.register(id, { dirty, save, discard });
    return () => context?.register(id, null);
  }, [context, id, dirty, save, discard]);
}
export function useNavigationGuard() {
  const context = useContext(Context);
  return context?.navigate ?? ((action: () => void) => action());
}
export function UnsavedChanges({ children }: { children: ReactNode }) {
  const editors = useRef(new Map<string, Editor>());
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const register = useCallback((id: string, editor: Editor | null) => {
    if (editor) editors.current.set(id, editor);
    else editors.current.delete(id);
    setDirty([...editors.current.values()].some((item) => item.dirty));
  }, []);
  const navigate = useCallback((action: () => void) => {
    if ([...editors.current.values()].some((item) => item.dirty)) {
      setError('');
      setPending(() => action);
    } else action();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const value = useMemo(() => ({ register, navigate }), [register, navigate]);
  return (
    <Context.Provider value={value}>
      {children}
      {pending && (
        <Modal
          title="有尚未保存的修改"
          onClose={() => !busy && setPending(null)}
        >
          <p>保存后离开，或放弃本次修改。保存失败时会留在当前页面。</p>
          {error && <p role="alert">{error}</p>}
          <div className="button-row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void (async () => {
                  try {
                    for (const editor of [...editors.current.values()])
                      if (editor.dirty) await editor.save();
                    const action = pending;
                    setPending(null);
                    action();
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : '保存失败',
                    );
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              保存并离开
            </button>
            <button
              disabled={busy}
              onClick={() => {
                for (const editor of editors.current.values())
                  if (editor.dirty) editor.discard();
                const action = pending;
                setPending(null);
                action();
              }}
            >
              放弃并离开
            </button>
            <button disabled={busy} onClick={() => setPending(null)}>
              继续编辑
            </button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}
