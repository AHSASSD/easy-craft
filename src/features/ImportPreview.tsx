import { useEffect, useRef, useState } from 'react';
import { FileArchive, Upload } from 'lucide-react';
import { Modal } from '../components/Modal';
export type ImportFile = {
  name: string;
  type: 'ZIP' | 'MRPACK' | '不支持';
  size: number;
};
export function previewFiles(
  files: Pick<File, 'name' | 'size'>[],
): ImportFile[] {
  return files.slice(0, 20).map((file) => ({
    name: file.name,
    size: file.size,
    type: /\.mrpack$/i.test(file.name)
      ? 'MRPACK'
      : /\.zip$/i.test(file.name)
        ? 'ZIP'
        : '不支持',
  }));
}
export function ImportPreview() {
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const isFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes('Files');
    const enter = (event: DragEvent) => {
      event.preventDefault();
      if (isFiles(event)) {
        depth.current++;
        setOver(true);
      }
    };
    const leave = (event: DragEvent) => {
      event.preventDefault();
      if (--depth.current <= 0) {
        depth.current = 0;
        setOver(false);
      }
    };
    const drag = (event: DragEvent) => event.preventDefault();
    const drop = (event: DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (event.dataTransfer?.files.length)
        setFiles(previewFiles(Array.from(event.dataTransfer.files)));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', drag);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', drag);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return (
    <>
      {over && (
        <div className="drop-overlay">
          <Upload size={40} />
          <h2>拖放 ZIP / MRPACK 查看预览</h2>
          <p>不会解压、安装或上传文件</p>
        </div>
      )}
      {files && (
        <Modal title="导入预览 · 演示模式" onClose={() => setFiles(null)}>
          <p>
            真实导入将在后续版本实现。这里只显示文件名、类型与大小，不读取包内容。
          </p>
          <ul className="import-list">
            {files.map((file, index) => (
              <li key={index}>
                <FileArchive size={20} />
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {file.type} · {file.size.toLocaleString('zh-CN')} 字节
                  </small>
                  {file.type === '不支持' && (
                    <small>仅支持 ZIP / MRPACK 预览</small>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="hint">每次最多预览 20 个文件。</p>
          <button onClick={() => setFiles(null)}>关闭预览</button>
        </Modal>
      )}
    </>
  );
}
