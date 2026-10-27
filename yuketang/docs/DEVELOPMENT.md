# 开发与测试

使用方法见 [README](../README.md)，模块职责见 [架构说明](ARCHITECTURE.md)。

## 代码组织

- `src/ui/`、`src/video/`、`src/discussion/`、`src/assignment/`、`src/ai/`：各功能控制器。
- `src/shared/`：目录、题目、页面操作及缓存等共用适配；`src/app.cjs` 负责调度。
- `tools/build.cjs` 构建油猴脚本；`tools/model-service.cjs` 提供本机模型服务。
- `tools/reference-extractor.cjs` 和 `tools/extract-reference.py` 负责导入材料。
- `tests/` 包含功能、模块约束、模拟页面和回归测试；`yuketang-autoplay.user.js` 是构建产物。

## 构建与验证

使用 Node.js 18 或更高版本，在项目目录执行：

```bash
node tools/build.cjs
node --check yuketang-autoplay.user.js
node --test
```

本次 347 项回归在本地完整测试套件中执行；公开仓库暂保留旧版测试文件，尚未同步该套件。

文档和 PDF 导入还需要按照 README 安装对应的 Python 依赖。`node tests/preview-server.cjs` 可启动本地模拟页面，用于检查界面；模拟测试不会替代真实课程的验证。

当前回归覆盖目录扫描与导航失效、章节材料复用、题目切换后的过期结果丢弃、多题状态隔离、作答和暂停逻辑。性能测试检查同步调度周期内的目录与题目复用，实际运行速度仍取决于页面和网络。

## 修改原则

保留人机验证处理、错误后暂停、提交结果核验和课程间缓存隔离。不要将未确认的提交、完成度或识别结果标记为成功；模型异步返回时要重新确认当前题目。课程材料、个人诊断和密钥应留在本地，提交前检查公开内容。
