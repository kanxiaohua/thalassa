# Third-Party Notices

本项目随仓库分发的第三方组件如下。

## Three.js r147

- **文件**：`vendor/three.min.js`（本地 UMD 构建，未修改，文件头保留原始许可声明）
- **版权**：Copyright © 2010-2022 Three.js Authors
- **许可证**：MIT License
- **上游**：https://github.com/mrdoob/three.js

```
MIT License

Copyright © 2010-2022 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 字体

仅使用系统字体栈（`PingFang SC` / `Microsoft YaHei` / `system-ui` 等），**不随仓库分发任何字体文件**。

## 音频

**不随仓库分发任何音频文件。** 背景音乐播放器只读取使用者自行放入 `assets/music/` 的音频；请确保你拥有相应的使用与分发权。程序化音景（`js/audio.js`）由 Web Audio API 实时合成，不含任何采样或第三方录音。

## 示例内容

`data/memories.js`、`data/memories.example.js` 中的 9 条记忆文案，以及 `assets/mem-01.svg` ~ `mem-09.svg` 占位图，均为本项目原创的虚构内容，以 [MIT](LICENSE) 许可证发布，不对应任何真实人物、地点或事件。
