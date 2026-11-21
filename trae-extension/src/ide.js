'use strict';

/**
 * IDE 适配层：集中判断当前宿主是 Trae 还是 VS Code 系，以及代理缓存命名空间。
 *
 * 这里只放纯函数，不 require('vscode')，这样 server.js 和普通 Node 脚本也能复用。
 * Trae 与 VS Code 的差异集中在少数几个能力上（autoplay 策略、代理画质），
 * 以后新增差异时先在这里加一个能力函数，不要把字符串判断散回业务代码。
 */

const TRAE_RE = /trae/i;
const VSCODE_RE = /visual studio code|microsoft vs code|vscode|code\.exe/i;

/** 'trae' | 'vscode' | 'other'；other 仍按 VS Code 系处理（autoplay 等）。 */
function flavorOf(appName, appRoot) {
  const text = `${appName || ''} ${appRoot || ''}`;
  if (TRAE_RE.test(text)) return 'trae';
  if (VSCODE_RE.test(text)) return 'vscode';
  return 'other';
}

/**
 * 代理缓存命名空间。
 *
 * 保持原有行为：只有确认是 VS Code 才用 vscode 命名空间（720p 代理），
 * 其它宿主（Trae / Cursor / VSCodium）沿用 trae，避免改变它们的画质策略。
 */
function proxyNamespace(appKey) {
  return VSCODE_RE.test(String(appKey || '')) ? 'vscode' : 'trae';
}

module.exports = { flavorOf, proxyNamespace };
