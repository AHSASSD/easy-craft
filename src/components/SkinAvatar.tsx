import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativeService } from '../core/native-contracts';
import { skinHead } from './skin-head';
export function SkinAvatar({ service }: { service: NativeService }) {
  const { available, state, avatar } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const identity = `${state?.settings.launchMode}:${state?.settings.offlineName}:${state?.account?.id}:${state?.account?.skinUrl}`;
  useEffect(() => {
    if (available) void service.avatar().catch(() => {});
  }, [available, identity, service]);
  const [head, setHead] = useState<{ source: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (!avatar) return;
    let disposed = false;
    void skinHead(avatar)
      .then((url) => {
        if (!disposed) setHead({ source: avatar, url });
      })
      .catch(() => {
        if (!disposed) setHead(null);
      });
    return () => {
      disposed = true;
    };
  }, [avatar]);
  const src = head?.source === avatar ? head?.url : undefined;
  return (
    <span
      className="skin-avatar"
      role="img"
      aria-label={src ? '玩家皮肤头像' : '默认玩家头像'}
    >
      {src ? (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          onError={() => setHead(null)}
        />
      ) : (
        <svg viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
          <rect width="8" height="8" fill="#b77b58" />
          <path d="M0 0h8v3H6V2H2v1H0z" fill="#503628" />
          <path d="M1 4h2v1H1zm4 0h2v1H5z" fill="#f2e9de" />
          <path d="M2 4h1v1H2zm3 0h1v1H5z" fill="#467c96" />
          <path d="M2 6h4v1H2z" fill="#68412f" />
        </svg>
      )}
    </span>
  );
}
