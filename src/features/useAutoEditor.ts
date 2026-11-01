import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useEditor } from './UnsavedChanges';

export function useAutoEditor(editor: {
  key: string;
  dirty: boolean;
  blocked: boolean;
  save(): Promise<void>;
  discard(): void;
  automatic: boolean;
}) {
  const latest = useRef(editor);
  const pending = useRef<Promise<void> | null>(null);
  const saved = useRef<string | null>(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    latest.current = editor;
  });
  const flush = useCallback(async () => {
    if (pending.current) await pending.current;
    const value = latest.current;
    if (!value.dirty || saved.current === value.key) return;
    if (value.blocked) throw Error('游戏或任务运行中，暂不能保存');
    const work = value.save();
    pending.current = work;
    try {
      await work;
      saved.current = value.key;
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '自动保存失败');
      throw error;
    } finally {
      pending.current = null;
    }
  }, []);
  useEffect(() => {
    if (!editor.automatic || !editor.dirty || editor.blocked) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [editor.automatic, editor.dirty, editor.blocked, editor.key, flush]);
  useEditor({
    dirty: editor.dirty,
    automatic: editor.automatic,
    save: flush,
    discard: editor.discard,
  });
  return { error, retry: flush };
}
