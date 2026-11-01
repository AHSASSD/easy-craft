import type { NativeState } from './native-contracts';

// Suggestions use the final error only; old log entries can describe recovered errors.
export function taskAdvice(message: string): string {
  if (/内存不足|OutOfMemoryError|Could not reserve enough space/i.test(message))
    return '关闭暂时不用的程序，并在实例设置中检查内存分配；不要把全部物理内存分配给游戏。';
  if (/超时|连接失败|网络|timeout|connection|HTTP (429|5\d\d)/i.test(message))
    return '检查网络或代理设置后重试。若来源服务暂时不可用，请稍后再试。';
  if (/占用|正在运行|锁定/.test(message))
    return '退出使用此实例的游戏或程序后重试。';
  if (/空间不足|磁盘已满|no space|disk full/i.test(message))
    return '检查游戏目录所在磁盘的剩余空间，释放空间后重试。';
  if (
    /需要(?:\s*64\s*位)?\s*Java\s*\d+|Java 版本记录与实际运行时不符|请选择可信 Java 安装目录中的 java\.exe 完整路径/.test(
      message,
    )
  )
    return '在实例设置的运行环境中选择自动匹配 Java，或选择符合版本要求的 64 位 Java 后重试。';
  return '查看下方日志了解失败位置；需要求助时，可预览并复制诊断摘要。';
}

export function taskReport(state: NativeState): string {
  const { task } = state;
  const privateValues = [
    state.dataRoot,
    state.settings.offlineName,
    state.settings.clientId,
    state.account?.name,
    state.account?.id,
    state.account?.xuid,
    state.loginCode?.userCode,
    state.loginCode?.verificationUri,
  ].filter((value): value is string => !!value);
  function clean(text: string) {
    for (const value of privateValues.sort((a, b) => b.length - a.length))
      text = text.split(value).join('[已隐藏]');
    return text
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
      .replace(
        /((?:access|refresh|id)[_-]?token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
        '$1[已隐藏]',
      )
      .replace(/[A-Z]:[\\/][^\r\n"<>|]*/gi, '[本地路径]')
      .replace(/\\\\[^\s\\]+\\[^\r\n"<>|]*/g, '[本地路径]');
  }
  return clean(
    [
      'Easy Craft 任务诊断摘要',
      `状态：${task.status}`,
      `阶段：${task.phase}`,
      `结果：${task.message}`,
      '',
      '当前任务日志：',
      ...task.logs,
    ].join('\n'),
  );
}
