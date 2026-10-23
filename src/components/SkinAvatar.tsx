import { useEffect, useSyncExternalStore } from 'react';
import type { NativeService } from '../core/native-contracts';
export function SkinAvatar({ service }: { service: NativeService }) {
  const { available, state, avatar } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const identity = `${state?.settings.launchMode}:${state?.settings.offlineName}:${state?.account?.id}:${state?.account?.skinUrl}`;
  useEffect(() => {
    if (available) void service.avatar().catch(() => {});
  }, [available, identity, service]);
  const background = avatar
    ? { backgroundImage: `url("${avatar}")` }
    : undefined;
  return (
    <span
      className="skin-avatar"
      role="img"
      aria-label={avatar ? '玩家皮肤头像' : '默认玩家头像'}
    >
      <svg viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
        <rect width="8" height="8" fill="#b77b58" />
        <path d="M0 0h8v3H6V2H2v1H0z" fill="#503628" />
        <path d="M1 4h2v1H1zm4 0h2v1H5z" fill="#f2e9de" />
        <path d="M2 4h1v1H2zm3 0h1v1H5z" fill="#467c96" />
        <path d="M2 6h4v1H2z" fill="#68412f" />
      </svg>
      <span className="skin-face" style={background} />
      <span className="skin-hat" style={background} />
    </span>
  );
}
