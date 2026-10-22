import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootstrap, kernel } from './app/bootstrap';

const root = createRoot(document.getElementById('root')!);
void bootstrap()
  .then((services) => root.render(<App services={services} />))
  .catch((error: unknown) => {
    console.error('Easy Craft bootstrap failed', error);
    root.render(
      <main>
        <h1>Easy Craft 启动失败</h1>
        <p role="alert">
          无法初始化官方插件，请刷新重试。详细信息见开发者控制台。
        </p>
        <button onClick={() => location.reload()}>重试</button>
      </main>,
    );
  });
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    void kernel.stop().catch(console.error);
  });
