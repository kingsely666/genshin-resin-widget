'use strict';

/** 把外链的 CSS / JS 内联进单文件 HTML，方便直接双击预览界面 */
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
let html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

html = html.replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`);
html = html.replace('<script src="renderer.js"></script>', `<script>\n${js}\n</script>`);

fs.writeFileSync(path.join(root, '界面预览.html'), html, 'utf8');
console.log('界面预览.html 已更新');
