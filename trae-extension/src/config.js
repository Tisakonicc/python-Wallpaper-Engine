'use strict';

const pkg = require('../package.json');

/** 扩展版本，用于判断 workbench.html 里的注入块是否属于当前构建。 */
const VERSION = pkg.version;

/**
 * 本地服务端口。workbench.html 是静态文件，注入脚本必须写死端口，
 * 所以端口固定而不是随机；被占用时按顺序换下一个，并重新注入。
 */
const PORT_CANDIDATES = [32123, 32124, 32125];

/** 注入块标记，patcher 用它定位与还原。 */
const MARKER = 'backgroundcover';

module.exports = { VERSION, PORT_CANDIDATES, MARKER };
