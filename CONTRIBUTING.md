# 贡献指南

谢谢你愿意帮这个项目变好一点。中文交流即可，不用特意写英文。

## 🚨 提交前的一条硬规则

**不要提交任何私人数据或音频文件。**

这个仓库是公开的，`data/memories.js` 在你的本地副本里很可能装的是真实回忆。提交前请一定跑一遍：

```bash
git status
git diff -- data/memories.js
grep -nE "睡衣|pajama|衡山|不能说的秘密|mem-1[0-9]" -r . --exclude=three.min.js
```

如果你只是想改代码、不想动示例数据，可以在本地让 Git 忽略这个文件的改动：

```bash
git update-index --skip-worktree data/memories.js
```

照片、音频、调试截图已被 `.gitignore` 排除，但 `git add -f` 会绕过它——请勿使用。

更多背景见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 本地开发

无需安装依赖、无需构建：

```bash
python -m http.server 8000
# http://localhost:8000
```

改完刷新即可。建议开启 `?debug=1`，控制台里 `__sea.state()` 能看粒子数、draw call 和帧耗时。

## 可以帮上忙的方向

- **性能**：低端设备 / 移动端帧率、粒子数与分辨率的自适应降级
- **可访问性**：键盘导航、屏幕阅读器、对比度、`prefers-reduced-motion`
- **移动端**：窄屏布局与触控手势
- **文档**：翻译、示例、教程、故障排查
- **Bug**：带复现步骤、浏览器版本和控制台输出的 Issue 最有帮助

## 代码约定

- 原生 ES2017+ 语法，不引入框架和打包器；保持「双击 index.html 就能跑」
- 中文注释，与现有文件风格一致（文件头用块注释说明职责）
- 新增可调参数放进 `js/main.js` 顶部的 `CFG`，不要散落魔法数字
- 不引入新的运行时依赖；如确有必要，请在 Issue 里先讨论
- 不要提交 `vendor/three.min.js` 的格式化或升级后的巨型 diff

## Pull Request

1. Fork 并建分支；
2. 说明改了什么、为什么、怎么验证；
3. 确认 diff 里没有私人内容；
4. 提交 PR。

提交即表示你同意你的贡献以 [MIT](LICENSE) 许可证发布。
